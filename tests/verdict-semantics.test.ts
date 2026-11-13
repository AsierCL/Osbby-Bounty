/**
 * S76/task 2: what a verdict is allowed to mean.
 *
 * REPRODUCIDO and NO_REPRODUCIDO need at least one signed execution from the verifier's own session
 * with a complete HTTP response. Without that, the effective verdict is INCONCLUSO and the finding
 * does not move. NO_REPRODUCIDO over a verified finding leaves it disputed, never rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideVerdict, inspectVerifierExecutions } from "../src/core/verdict.ts";
import { createSession } from "../src/pi/session.ts";

const run = (argv: string[]) =>
	new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
		const [command, ...args] = argv;
		execFile(command as string, args, (error, stdout, stderr) => {
			resolve({ exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});



/** A local HTTP server: the only "target" these tests touch. */
async function withServer<T>(handler: (port: number, close: () => Promise<void>) => Promise<T>): Promise<T> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"id":2,"owner":"bob","total":4200}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
	try {
		return await handler(port, close);
	} finally {
		await close().catch(() => undefined);
	}
}

async function setup(port: number, options: { state?: "candidate" | "verified" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-verdict-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, `program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:${port}\nlimits:\n  rate_rps: 20\n`, "utf8");
	const deps = {
		dns: async () => ({ cname: [] }),
		readFile: (path: string) => readFile(path, "utf8"),
		runTool: run,
		confirm: async () => true,
	};
	const parent = createSession({ root: dir, program: "lab" }, deps);
	await parent.scope({ file: scopePath });
	const created = await parent.finding({ action: "create", title: "IDOR en facturas", class: "idor", endpoint: "/api/invoices/2", parameter: "id" });
	const findingId = (created.text.match(/F-\d{4}/) ?? [])[0] as string;
	if (options.state === "verified") await parent.finding({ action: "update", id: findingId, state: "verified" }).catch(() => undefined);
	return { dir, parent, findingId, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function verifier(dir: string, scopePath: string) {
	return createSession(
		{ root: dir, program: "lab", sessionId: "child-1", invocationToken: "tok-1" },
		{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: run, confirm: async () => false },
	).scope({ file: scopePath });
}

test("no signed executions means INCONCLUSO, and nothing moves", async () => {
	await withServer(async (port) => {
		const h = await setup(port);
		try {
			const applied = await h.parent.applyVerifierVerdict({
				findingId: h.findingId,
				verdict: "NO_REPRODUCIDO",
				seqs: [],
				reason: "no pude cargar el alcance",
				verifierSessionId: "child-1",
				invocationToken: "tok-1",
			});
			assert.equal(applied.ok, false);
			assert.equal(applied.effective, "INCONCLUSO");
			assert.equal(applied.converted, true, "the declared NO_REPRODUCIDO was converted");
			assert.match(applied.text, /sin ejecuciones firmadas/);
			const status = await readFile(join(h.dir, "work", "lab", "status.md"), "utf8");
			assert.match(status, /sin ejecuciones firmadas/);
		} finally {
			await h.cleanup();
		}
	});
});

test("a signed execution whose connection was refused is INCONCLUSO, not a rejection", async () => {
	// Nothing listens on this port: curl exits non-zero and there is no HTTP status.
	await withServer(async () => {
		const closed = 1;
		const h = await setup(closed);
		try {
			const scopePath = join(h.dir, "scope.yaml");
			const child = createSession(
				{ root: h.dir, program: "lab", sessionId: "child-1", invocationToken: "tok-1" },
				{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: run, confirm: async () => false },
			);
			await child.scope({ file: scopePath });
			await child.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:${closed}/api/invoices/2`], target: `http://127.0.0.1:${closed}/api/invoices/2` });
			const applied = await h.parent.applyVerifierVerdict({
				findingId: h.findingId,
				verdict: "NO_REPRODUCIDO",
				seqs: [],
				reason: "la conexión fue rechazada",
				verifierSessionId: "child-1",
				invocationToken: "tok-1",
			});
			assert.equal(applied.effective, "INCONCLUSO", applied.text);
			assert.match(applied.text, /conexión rechazada o timeout/);
		} finally {
			await h.cleanup();
		}
	});
});

test("REPRODUCIDO with a complete signed execution verifies; NO_REPRODUCIDO over it leaves it disputed", async () => {
	await withServer(async (port) => {
		const h = await setup(port);
		try {
			const scopePath = join(h.dir, "scope.yaml");
			await verifier(h.dir, scopePath);
			const child = createSession(
				{ root: h.dir, program: "lab", sessionId: "child-1", invocationToken: "tok-1" },
				{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: run, confirm: async () => false },
			);
			await child.scope({ file: scopePath });
			await child.run({
				tool: "curl",
				args: ["-sS", "-w", "\n%{http_code}", `http://127.0.0.1:${port}/api/invoices/2`],
				target: `http://127.0.0.1:${port}/api/invoices/2`,
			});
			const seq = (JSON.parse(await readFile(join(h.dir, "work", "lab", "findings", `${h.findingId}.json`), "utf8")) as { id: string }).id;

			const records = (await import("../src/core/evidence.ts")).createEvidenceStore(join(h.dir, "work", "lab", "evidence"));
			const all = await records.read();
			const execution = all.filter((record) => record.kind === "execution").at(-1);
			assert.ok(execution);

			const reproduced = await h.parent.applyVerifierVerdict({
				findingId: h.findingId,
				verdict: "REPRODUCIDO",
				seqs: [execution.seq],
				reason: "dos veces",
				verifierSessionId: "child-1",
				invocationToken: "tok-1",
			});
			assert.equal(reproduced.effective, "REPRODUCIDO", reproduced.text);
			assert.equal(reproduced.state, "verified", `finding ${seq}`);

			const disputed = await h.parent.applyVerifierVerdict({
				findingId: h.findingId,
				verdict: "NO_REPRODUCIDO",
				seqs: [],
				reason: "ahora no aparece",
				verifierSessionId: "child-1",
				invocationToken: "tok-1",
			});
			assert.equal(disputed.effective, "NO_REPRODUCIDO", disputed.text);
			assert.equal(disputed.state, "disputed");
			const status = await readFile(join(h.dir, "work", "lab", "status.md"), "utf8");
			assert.match(status, /Disputas \(las resolvés vos\)/);
			assert.match(status, /No se degrada solo/);
		} finally {
			await h.cleanup();
		}
	});
});

test("NO_REPRODUCIDO over a candidate rejects it", async () => {
	await withServer(async (port) => {
		const h = await setup(port);
		try {
			const scopePath = join(h.dir, "scope.yaml");
			const child = createSession(
				{ root: h.dir, program: "lab", sessionId: "child-1", invocationToken: "tok-1" },
				{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: run, confirm: async () => false },
			);
			await child.scope({ file: scopePath });
			await child.run({
				tool: "curl",
				args: ["-sS", "-w", "\n%{http_code}", `http://127.0.0.1:${port}/api/invoices/2`],
				target: `http://127.0.0.1:${port}/api/invoices/2`,
			});
			const applied = await h.parent.applyVerifierVerdict({
				findingId: h.findingId,
				verdict: "NO_REPRODUCIDO",
				seqs: [],
				reason: "responde 200 pero sin datos de otro usuario",
				verifierSessionId: "child-1",
				invocationToken: "tok-1",
			});
			assert.equal(applied.effective, "NO_REPRODUCIDO");
			assert.equal(applied.state, "rejected");
		} finally {
			await h.cleanup();
		}
	});
});

test("the decision table: what each combination is allowed to do", () => {
	const complete = { seq: 1, endpoint: "/x", signed: true, exitCode: 0, status: "200", complete: true };
	const refused = { seq: 1, endpoint: "/x", signed: true, exitCode: 7, status: null, complete: false };
	const inspection = (executions: (typeof complete)[]) => ({
		executions,
		signed: executions.filter((execution) => execution.signed),
		complete: executions.filter((execution) => execution.complete),
	});

	const unreadable = decideVerdict({ verdict: null, seqs: [], reason: "", state: "candidate", inspection: inspection([]) });
	assert.equal(unreadable.effective, "INCONCLUSO");
	assert.match(unreadable.detail, /no devolvió un veredicto legible/);

	const declaredInconclusive = decideVerdict({ verdict: "INCONCLUSO", seqs: [], reason: "sin alcance", state: "verified", inspection: inspection([]) });
	assert.equal(declaredInconclusive.effective, "INCONCLUSO");
	assert.equal(declaredInconclusive.converted, false);
	assert.equal(declaredInconclusive.nextState, null);

	const refusedNo = decideVerdict({ verdict: "NO_REPRODUCIDO", seqs: [], reason: "", state: "candidate", inspection: inspection([refused]) });
	assert.equal(refusedNo.effective, "INCONCLUSO");
	assert.equal(refusedNo.converted, true);
	assert.equal(refusedNo.nextState, null);

	const reproduced = decideVerdict({ verdict: "REPRODUCIDO", seqs: [1], reason: "", state: "candidate", inspection: inspection([complete]) });
	assert.deepEqual([reproduced.effective, reproduced.nextState, reproduced.event], ["REPRODUCIDO", "verified", "verified"]);

	const reproducedUncited = decideVerdict({ verdict: "REPRODUCIDO", seqs: [9], reason: "", state: "candidate", inspection: inspection([complete]) });
	assert.equal(reproducedUncited.effective, "INCONCLUSO");
	assert.match(reproducedUncited.detail, /no tienen respuesta HTTP completa/);

	const rejected = decideVerdict({ verdict: "NO_REPRODUCIDO", seqs: [], reason: "", state: "candidate", inspection: inspection([complete]) });
	assert.deepEqual([rejected.effective, rejected.nextState, rejected.event], ["NO_REPRODUCIDO", "rejected", "rejected"]);

	const disputed = decideVerdict({ verdict: "NO_REPRODUCIDO", seqs: [], reason: "", state: "verified", inspection: inspection([complete]) });
	assert.deepEqual([disputed.effective, disputed.nextState, disputed.event], ["NO_REPRODUCIDO", "disputed", "disputed"]);

	const reported = decideVerdict({ verdict: "NO_REPRODUCIDO", seqs: [], reason: "", state: "reported", inspection: inspection([complete]) });
	assert.equal(reported.effective, "INCONCLUSO");
	assert.equal(reported.nextState, null);
	assert.match(reported.detail, /está en reported/);
});
