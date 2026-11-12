/**
 * S67: bounty_report computes the score, rejects M* metrics, refuses unverified findings and writes
 * the canonical report. The model never passes a score.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, type ProgramSession } from "../src/pi/session.ts";
import { scoreVector } from "../src/core/cvss.ts";

const SCOPE = "program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n";

const BASE = { AV: "N", AC: "L", AT: "N", PR: "N", UI: "N", VC: "H", VI: "N", VA: "N", SC: "N", SI: "N", SA: "N" };

async function sessionWithFinding(verified: boolean): Promise<{ dir: string; session: ProgramSession; id: string; cleanup(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-report-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, SCOPE, "utf8");
	const deps = {
		dns: async () => ({ cname: [] }),
		readFile: (path: string) => readFile(path, "utf8"),
		runTool: async () => ({ exitCode: 0, stdout: "HTTP 200\n{\"owner\":\"bob\"}", stderr: "" }),
		confirm: async () => true,
	};
	const session = createSession({ root: dir, program: "lab" }, deps);
	await session.scope({ file: scopePath });
	await session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/invoices/2"], target: "http://127.0.0.1:3000/api/invoices/2" });
	const created = await session.finding({ action: "create", title: "IDOR en facturas", class: "idor", endpoint: "/api/invoices/2", parameter: "id" });
	const id = (created.text.match(/F-\d{4}/) ?? [])[0] ?? "";
	if (verified) {
		const verifier = createSession({ root: dir, program: "lab", verifier: true }, deps);
		await verifier.finding({ action: "update", id, state: "verified", reason: "reproducido dos veces" });
	}
	return { dir, session, id, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const FIELDS = {
	steps: ["GET /api/invoices/1 como alice", "GET /api/invoices/2 como alice", "repetir el segundo"],
	impact: "Se leen facturas de otro usuario.",
	remediation: "Verificar propiedad del recurso.",
};

test("a verified finding produces a report with the score computed from the metrics", async () => {
	const h = await sessionWithFinding(true);
	try {
		const result = await h.session.report({ findingId: h.id, metrics: BASE, ...FIELDS });
		assert.equal(result.ok, true, result.text);
		const expected = scoreVector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N");
		assert.ok(!("ok" in expected));
		if (!("ok" in expected)) assert.match(result.text, new RegExp(`Severidad calculada: ${expected.score.toFixed(1)}`));
		const report = await readFile(join(h.dir, "work", "lab", "reports", `${h.id}.md`), "utf8");
		assert.match(report, /CVSS:4\.0\/AV:N/);
		assert.match(report, /sha256 [0-9a-f]{16}/);
		assert.match(report, /^1\. GET/m);
		const status = await readFile(h.session.paths.statusFile, "utf8");
		assert.match(status, /espera envío humano|lo mandás vos/);
	} finally {
		await h.cleanup();
	}
});

test("M* metrics are rejected, not ignored", async () => {
	const h = await sessionWithFinding(true);
	try {
		const result = await h.session.report({ findingId: h.id, metrics: { ...BASE, MAV: "N" }, ...FIELDS });
		assert.equal(result.ok, false);
		assert.match(result.text, /Métricas modificadas no soportadas: MAV/);
	} finally {
		await h.cleanup();
	}
});

test("an unverified finding cannot be reported", async () => {
	const h = await sessionWithFinding(false);
	try {
		const result = await h.session.report({ findingId: h.id, metrics: BASE, ...FIELDS });
		assert.equal(result.ok, false);
		assert.match(result.text, /primero tiene que verificarlo el verificador independiente/);
	} finally {
		await h.cleanup();
	}
});

test("missing base metrics and missing report fields are refused with a list", async () => {
	const h = await sessionWithFinding(true);
	try {
		const missingMetrics = await h.session.report({ findingId: h.id, metrics: { AV: "N" }, ...FIELDS });
		assert.equal(missingMetrics.ok, false);
		assert.match(missingMetrics.text, /Faltan métricas base/);
		const missingFields = await h.session.report({ findingId: h.id, metrics: BASE });
		assert.equal(missingFields.ok, false);
		assert.match(missingFields.text, /no cumple la checklist/);
	} finally {
		await h.cleanup();
	}
});

test("an unknown finding is refused by id", async () => {
	const h = await sessionWithFinding(true);
	try {
		const result = await h.session.report({ findingId: "F-9999", metrics: BASE, ...FIELDS });
		assert.equal(result.ok, false);
		assert.match(result.text, /No existe el hallazgo F-9999/);
	} finally {
		await h.cleanup();
	}
});
