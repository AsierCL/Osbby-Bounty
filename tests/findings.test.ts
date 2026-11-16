/**
 * Finding lifecycle (S29 depends on it: status.md reports finding state changes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFindingsStore, fingerprint } from "../src/core/findings.ts";

async function withStore<T>(run: (store: ReturnType<typeof createFindingsStore>) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-findings-"));
	try {
		return await run(createFindingsStore({ dir, program: "lab", now: () => 1_700_000_000_000 }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const base = { title: "IDOR en facturas", class: "idor", endpoint: "/api/v1/invoices/1234" };

test("a new finding starts as candidate with a stable fingerprint", () =>
	withStore(async (store) => {
		const { finding, duplicateOf } = await store.create(base);
		assert.equal(finding.id, "F-0001");
		assert.equal(finding.state, "candidate");
		assert.equal(duplicateOf, null);
		assert.equal(finding.fingerprint, fingerprint(base));
		assert.deepEqual(
			finding.transitions.map((transition) => transition.to),
			["candidate"],
		);
	}));

test("the same class and endpoint is deduplicated instead of duplicated", () =>
	withStore(async (store) => {
		await store.create(base);
		const second = await store.create({ ...base, title: "IDOR otra vez" });
		assert.equal(second.duplicateOf, "F-0001");
		assert.equal((await store.list()).length, 1);
	}));

test("a different parameter is a different finding", () =>
	withStore(async (store) => {
		await store.create({ ...base, parameter: "id" });
		const second = await store.create({ ...base, parameter: "invoice_id" });
		assert.equal(second.duplicateOf, null);
		assert.equal((await store.list()).length, 2);
	}));

test("candidate cannot jump straight to reported", () =>
	withStore(async (store) => {
		const { finding } = await store.create(base);
		await assert.rejects(() => store.update(finding.id, { state: "reported" }, "shortcut"), /invalid transition candidate → reported/);
	}));

test("the normal path is candidate → verified → reported", () =>
	withStore(async (store) => {
		const { finding } = await store.create(base);
		const verified = await store.update(finding.id, { state: "verified", confidence: "high" }, "reproduced twice");
		assert.equal(verified.state, "verified");
		assert.equal(verified.confidence, "high");
		const reported = await store.update(finding.id, { state: "reported" }, "report sent by the human");
		assert.equal(reported.state, "reported");
		assert.deepEqual(
			reported.transitions.map((transition) => transition.to),
			["candidate", "verified", "reported"],
		);
	}));

test("a terminal state refuses any further transition", () =>
	withStore(async (store) => {
		const { finding } = await store.create(base);
		await store.update(finding.id, { state: "rejected" }, "false positive");
		await assert.rejects(() => store.update(finding.id, { state: "verified" }, "retry"), /invalid transition rejected/);
	}));

test("cvss and score are stored with the finding", () =>
	withStore(async (store) => {
		const { finding } = await store.create(base);
		await store.update(finding.id, { state: "verified" }, "ok");
		const scored = await store.update(finding.id, { cvss: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:H/SI:H/SA:H", score: 8.1 }, "cvss");
		assert.equal(scored.score, 8.1);
		assert.match(scored.cvss ?? "", /^CVSS:4\.0\//);
	}));

test("the sensitive marker survives round trips (S26 third-party secret)", () =>
	withStore(async (store) => {
		const { finding } = await store.create({ ...base, class: "secret-exposure", sensitive: true });
		const reloaded = await store.get(finding.id);
		assert.equal(reloaded?.sensitive, true);
	}));

test("an unknown finding is reported as missing, not invented", () =>
	withStore(async (store) => {
		assert.equal(await store.get("F-9999"), null);
		await assert.rejects(() => store.update("F-9999", { state: "verified" }, "x"), /unknown finding F-9999/);
	}));

test("S81: renaming a finding keeps its state and adds no transition", () =>
	withStore(async (store) => {
		const { finding } = await store.create(base);
		const renamed = await store.update(finding.id, { title: "candidato: posible exposición de playerId, sin confirmar" }, "renombrado");
		assert.equal(renamed.title, "candidato: posible exposición de playerId, sin confirmar");
		assert.equal(renamed.state, "candidate");
		assert.equal(renamed.transitions.length, finding.transitions.length);
		assert.equal(renamed.fingerprint, finding.fingerprint, "renaming must not change identity");
	}));

test("S92: a resolution written by the agent is refused; only a verbatim human reason is accepted", async () => {
	const { createSession } = await import("../src/pi/session.ts");
	const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "bounty-resolve-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n", "utf8");
		const session = createSession(
			{ root: dir, program: "lab" },
			{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }), confirm: async () => false },
		);
		await session.scope({ file: scopePath, confirm: async () => true });
		const created = await session.finding({ action: "create", title: "x", class: "idor", endpoint: "/x" });
		const id = (created.text.match(/F-\d{4}/) ?? [])[0] as string;

		const fromAgent = await session.finding({ action: "resolve", id, reason: "lo resumo yo", reasonSource: "agent", confirm: async () => true });
		assert.equal(fromAgent.ok, false);
		assert.match(fromAgent.text, /citado textualmente del humano/);

		const noSource = await session.finding({ action: "resolve", id, reason: "sin declarar", confirm: async () => true });
		assert.equal(noSource.ok, false);

		// A session with no UI at all: the criterion resolution is refused, whatever the channel says.
		const headless = createSession(
			{ root: dir, program: "lab" },
			{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		);
		const noUi = await headless.finding({ action: "resolve", id, reason: "texto literal del humano", reasonSource: "human-verbatim" });
		assert.equal(noUi.ok, false);
		assert.match(noUi.text, /exige tu confirmación en el diálogo/);

		const ok = await session.finding({ action: "resolve", id, reason: "texto literal del humano", reasonSource: "human-verbatim", confirm: async () => true });
		assert.equal(ok.ok, true, ok.text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
