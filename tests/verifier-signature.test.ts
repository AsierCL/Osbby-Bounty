/**
 * S74/task 7: the runner signs the invocation, the child's session signs its executions, and the parent
 * refuses a REPRODUCIDO it cannot attribute to the child it launched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { signExecution } from "../src/core/attestation.ts";
import { createSession } from "../src/pi/session.ts";

const SCOPE = "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n";
const ENDPOINT = "/api/invoices/2";

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "bounty-attest-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, SCOPE, "utf8");
	const deps = {
		dns: async () => ({ cname: [] }),
		readFile: (path: string) => readFile(path, "utf8"),
		runTool: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
		confirm: async () => true,
	};
	const main = createSession({ root: dir, program: "lab" }, deps);
	await main.scope({ file: scopePath });
	const created = await main.finding({ action: "create", title: "IDOR", class: "idor", endpoint: ENDPOINT, parameter: "id" });
	const findingId = (created.text.match(/F-\d{4}/) ?? [])[0] ?? "";
	const store = createEvidenceStore(join(dir, "work", "lab", "evidence"), { now: () => Date.now() });
	return { dir, main, findingId, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const TARGET = "http://127.0.0.1:3000/api/invoices/2";

test("a signed execution from the verifier's own session verifies the finding", async () => {
	const h = await setup();
	try {
		const verifier = createSession(
			{ root: h.dir, program: "lab", sessionId: "child-1", invocationToken: "token-1" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: "HTTP 200\n{\"owner\":\"bob\"}", stderr: "" }),
				confirm: async () => true,
			},
		);
		await verifier.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		await verifier.run({ tool: "curl", args: ["-sS", TARGET], target: TARGET });
		const records = await h.store.read();
		const seq = records.filter((record) => record.kind === "execution").at(-1)?.seq ?? 0;

		const applied = await h.main.applyVerifierVerdict({
			findingId: h.findingId,
			verdict: "REPRODUCIDO",
			seqs: [seq],
			reason: "dos veces",
			verifierSessionId: "child-1",
			invocationToken: "token-1",
		});
		assert.equal(applied.ok, true, applied.text);
	} finally {
		await h.cleanup();
	}
});

test("an execution from the right session but without a valid signature is refused", async () => {
	const h = await setup();
	try {
		// Someone crafts an execution record with the child's session id and the right endpoint.
		await h.store.append({
			kind: "execution",
			payload: { tool: "curl", argv: ["curl", TARGET], endpoint: ENDPOINT, at: new Date().toISOString(), sessionId: "child-1" },
		});
		const seq = (await h.store.read()).at(-1)?.seq ?? 0;
		const applied = await h.main.applyVerifierVerdict({
			findingId: h.findingId,
			verdict: "REPRODUCIDO",
			seqs: [seq],
			reason: "lo vi",
			verifierSessionId: "child-1",
			invocationToken: "token-1",
		});
		assert.equal(applied.ok, false);
		assert.match(applied.text, /no lleva una firma válida/);
	} finally {
		await h.cleanup();
	}
});

test("a signature from a different invocation token is refused", async () => {
	const h = await setup();
	try {
		const at = new Date().toISOString();
		const signature = signExecution("another-token", { sessionId: "child-1", tool: "curl", argv: ["curl", TARGET], endpoint: ENDPOINT, at });
		await h.store.append({
			kind: "execution",
			payload: { tool: "curl", argv: ["curl", TARGET], endpoint: ENDPOINT, at, sessionId: "child-1", signature },
		});
		const seq = (await h.store.read()).at(-1)?.seq ?? 0;
		const applied = await h.main.applyVerifierVerdict({
			findingId: h.findingId,
			verdict: "REPRODUCIDO",
			seqs: [seq],
			reason: "lo vi",
			verifierSessionId: "child-1",
			invocationToken: "token-1",
		});
		assert.equal(applied.ok, false);
		assert.match(applied.text, /no lleva una firma válida/);
	} finally {
		await h.cleanup();
	}
});

test("without the invocation token the verdict is refused, not trusted", async () => {
	const h = await setup();
	try {
		const applied = await h.main.applyVerifierVerdict({
			findingId: h.findingId,
			verdict: "REPRODUCIDO",
			seqs: [1],
			reason: "lo vi",
			verifierSessionId: "child-1",
		});
		assert.equal(applied.ok, false);
		assert.match(applied.text, /falta el token de invocación/);
	} finally {
		await h.cleanup();
	}
});
