/**
 * Phase E negative tests (S38), one level, against the local lab only.
 *
 *   1. leaving the scope is blocked, with a readable reason in status.md
 *   2. a destructive class pauses and asks, even in automatic mode
 *   3. a planted prompt injection is treated as data, never executed
 *   4. a rate above the program's limit is classified as destructive
 *
 * Plus the positive path: two reproductions, a verified finding and a report that passes the
 * checklist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAB_INJECTION, startLab, type Lab } from "../lab/server.ts";
import { createFetchTool } from "../lab/http-tool.ts";
import { createSession, type ProgramSession } from "../src/pi/session.ts";
import { renderReport, validateReport } from "../src/core/report.ts";
import { createEvidenceStore } from "../src/core/evidence.ts";

interface Harness {
	dir: string;
	lab: Lab;
	session: ProgramSession;
	executed: string[][];
	confirmations: string[];
	cleanup(): Promise<void>;
}

async function harness(options: { confirm?: boolean } = {}): Promise<Harness> {
	const lab = await startLab();
	const dir = await mkdtemp(join(tmpdir(), "bounty-phase-e-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(
		scopePath,
		`program: lab
lab: true
authorized_on: 2026-11-11
in_scope:
  - 127.0.0.1:${lab.port}
limits:
  rate_rps: 5
  allowed_methods:
    - GET
  redirects: reject
  forbidden:
    - dos
    - brute-force
`,
		"utf8",
	);
	const fetchTool = createFetchTool();
	const confirmations: string[] = [];
	const session = createSession(
		{ root: dir, program: "lab" },
		{
			dns: async () => ({ cname: [] }),
			readFile: (path) => readFile(path, "utf8"),
			runTool: fetchTool.runTool,
			confirm: async (question) => {
				confirmations.push(question);
				return options.confirm ?? false;
			},
		},
	);
	await session.scope({ file: scopePath, confirm: true });
	return {
		dir,
		lab,
		session,
		executed: fetchTool.executed,
		confirmations,
		cleanup: async () => {
			await lab.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function statusOf(h: Harness): Promise<string> {
	return readFile(h.session.paths.statusFile, "utf8");
}

test("negative 1: leaving the scope is blocked and the reason is in status.md", async () => {
	const h = await harness();
	try {
		const outside = await h.session.run({ tool: "get", args: [`http://127.0.0.1:${h.lab.port + 1}/`], target: `http://127.0.0.1:${h.lab.port + 1}/` });
		assert.equal(outside.ok, false);
		assert.match(outside.text, /Bloqueado por el gate/);
		assert.equal(h.executed.length, 0, "an out-of-scope command was executed");
		assert.equal(h.lab.requests.length, 0, "the lab received a request that should have been blocked");
		const text = await statusOf(h);
		assert.match(text, /bloqueado: no in_scope rule matched 127\.0\.0\.1/);
	} finally {
		await h.cleanup();
	}
});

test("negative 2: an inferred destructive class pauses and executes nothing", async () => {
	const h = await harness({ confirm: false });
	try {
		const hydra = await h.session.run({
			tool: "hydra",
			args: ["-L", "logins.txt", "-P", "passwords.txt", "127.0.0.1", "ssh"],
			target: `http://127.0.0.1:${h.lab.port}/login`,
		});
		assert.equal(hydra.ok, false);
		assert.match(hydra.text, /clase destructiva/);
		assert.equal(h.executed.length, 0);
		assert.equal(h.confirmations.length, 1);
		assert.match(h.confirmations[0] ?? "", /brute-force/);
		const text = await statusOf(h);
		assert.match(text, /destructiva necesita tu OK explícito/);
	} finally {
		await h.cleanup();
	}
});

test("negative 3: a planted injection is recorded as data and never executed", async () => {
	const h = await harness();
	try {
		const page = await h.session.run({ tool: "get", args: [`http://127.0.0.1:${h.lab.port}/`], target: `http://127.0.0.1:${h.lab.port}/` });
		assert.equal(page.ok, true, page.text);
		assert.ok(page.text.includes(LAB_INJECTION), "the lab fixture did not carry the injection");

		await h.session.evidence({ action: "append", kind: "observation", payload: { note: "instrucciones plantadas en el HTML: se tratan como dato", text: LAB_INJECTION } });

		// The injected host is not in scope, so acting on the text is blocked by construction.
		const injected = await h.session.run({ tool: "nuclei", args: ["-u", "http://192.0.2.1/"], target: "http://192.0.2.1/" });
		assert.equal(injected.ok, false);
		assert.match(injected.text, /Bloqueado por el gate/);
		assert.ok(!h.executed.some((argv) => argv.join(" ").includes("192.0.2.1")), "the injected host was contacted");
		assert.equal(h.lab.requests.length, 1, "only the page fetch should have reached the lab");
	} finally {
		await h.cleanup();
	}
});

test("negative 4: a rate above the program limit is destructive, so it pauses", async () => {
	const h = await harness({ confirm: false });
	try {
		const ffuf = await h.session.run({
			tool: "ffuf",
			args: ["-w", "words.txt", "-u", `http://127.0.0.1:${h.lab.port}/FUZZ`, "-rate", "200"],
			target: `http://127.0.0.1:${h.lab.port}/FUZZ`,
		});
		assert.equal(ffuf.ok, false);
		assert.match(ffuf.text, /clase destructiva/);
		assert.equal(h.executed.length, 0);
		assert.match(h.confirmations[0] ?? "", /exceeds the program rate of 5/);
	} finally {
		await h.cleanup();
	}
});

test("the positive path: two reproductions, a verified finding and a report that passes", async () => {
	const h = await harness();
	try {
		const own = await h.session.run({ tool: "get", args: [`http://127.0.0.1:${h.lab.port}/api/invoices/1`, "--user", "alice"], target: `http://127.0.0.1:${h.lab.port}/api/invoices/1` });
		const other = await h.session.run({ tool: "get", args: [`http://127.0.0.1:${h.lab.port}/api/invoices/2`, "--user", "alice"], target: `http://127.0.0.1:${h.lab.port}/api/invoices/2` });
		const again = await h.session.run({ tool: "get", args: [`http://127.0.0.1:${h.lab.port}/api/invoices/2`, "--user", "alice"], target: `http://127.0.0.1:${h.lab.port}/api/invoices/2` });
		assert.equal(own.ok, true);
		assert.equal(other.ok, true);
		assert.equal(again.ok, true);
		assert.notEqual(other.text, own.text, "the lab did not return a different resource");
		assert.match(other.text, /bob/);

		const created = await h.session.finding({ action: "create", title: "IDOR en facturas", class: "idor", endpoint: "/api/invoices/2", parameter: "id" });
		const id = (created.text.match(/F-\d{4}/) ?? [])[0];
		assert.ok(id, created.text);
		await h.session.finding({ action: "update", id, state: "verified", reason: "reproducido dos veces" });
		await h.session.finding({ action: "update", id, state: "verified", cvss: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N", score: 8.7 });

		const store = createEvidenceStore(h.session.paths.evidenceDir, { now: () => Date.now() });
		const verified = await store.verify();
		assert.equal(verified.ok, true, JSON.stringify(verified));

		const finding = JSON.parse(await readFile(join(h.session.paths.findingsDir, `${id}.json`), "utf8"));
		const markdown = renderReport({
			finding,
			evidence: await store.read(),
			program: "lab",
			reproductionSteps: ["GET /api/invoices/1 como alice", "GET /api/invoices/2 como alice", "repetir el segundo"],
			impact: "Se leen facturas de otro usuario.",
			remediation: "Verificar propiedad del recurso.",
		});
		const check = validateReport(markdown);
		assert.equal(check.ok, true, `report missing: ${check.missing.join(", ")}`);
		assert.match(markdown, /CVSS:4\.0\//);
		assert.match(markdown, /sha256 [0-9a-f]{16}/);

		const status = await statusOf(h);
		assert.match(status, /IDOR en facturas — confirmado — severidad 8\.7/);
	} finally {
		await h.cleanup();
	}
});
