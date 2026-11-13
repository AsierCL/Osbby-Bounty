/**
 * S76/task 1: the verifier child knows its program and cannot touch another one.
 * - With the locked program, an already confirmed scope loads without a dialog (same hash in state.json).
 * - With any other program name, the tools refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";
import { buildVerifierTask } from "../src/pi/verifier.ts";

const ROOT = await mkdtemp(join(tmpdir(), "bounty-lock-"));
await mkdir(join(ROOT, "work", "lab"), { recursive: true });
const SCOPE = "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n";
const scopePath = join(ROOT, "work", "lab", "scope.yaml");
await writeFile(scopePath, SCOPE, "utf8");

// The operator confirmed the scope once (a normal session).
const confirmed = await createSession(
	{ root: ROOT, program: "lab" },
	{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }), confirm: async () => true },
).scope({ file: scopePath });
assert.equal(confirmed.ok, true, confirmed.text);
const confirmedState = JSON.parse(await readFile(join(ROOT, "work", "lab", "state.json"), "utf8"));

process.env.GENTLE_BOUNTY_ROOT = ROOT;
process.env.GENTLE_BOUNTY_PROGRAM = "lab";

const mod = (await import("../extensions/bounty.ts")) as { default: (pi: unknown) => void };
const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
mod.default({ registerTool: (spec: { name: string } & Record<string, unknown>) => tools.set(spec.name, spec as never) });

test("the task names the program and the absolute scope path", () => {
	const task = buildVerifierTask({ findingId: "F-0001", evidence: [], program: "lab", scopePath });
	assert.match(task, /del programa lab/);
	assert.match(task, new RegExp(scopePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(task, /No busques otros scopes ni listes work\//);
	assert.match(task, /respondé INCONCLUSO, nunca NO_REPRODUCIDO/);
});

test("the confirmed scope loads without a dialog and keeps the same hash", async () => {
	const result = await tools.get("bounty_scope")?.execute("1", { program: "lab", file: scopePath });
	const text = result?.content[0]?.text ?? "";
	assert.equal(result?.details.ok, true, text);
	assert.match(text, /ya lo confirmaste/);
	const state = JSON.parse(await readFile(join(ROOT, "work", "lab", "state.json"), "utf8"));
	assert.equal(state.scopeConfirmedHash, confirmedState.scopeConfirmedHash, "the child must not re-confirm or invalidate the hash");
});

test("another program name is refused by the tools", async () => {
	for (const name of ["bounty_scope", "bounty_run", "bounty_evidence", "bounty_status"]) {
		const tool = tools.get(name);
		assert.ok(tool, name);
		const result = await tool.execute("2", { program: "otro", file: scopePath, action: "list", tool: "curl", args: ["-sS", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		const text = result.content[0]?.text ?? "";
		assert.equal(result.details.ok, false, `${name}: ${text}`);
		assert.match(text, /Programa no permitido en esta sesión/);
	}
});

test("the program argument is optional inside a locked child and defaults to the lock", async () => {
	const result = await tools.get("bounty_status")?.execute("3", {});
	assert.equal(result?.details.ok, true, result?.content[0]?.text);
	assert.match(result?.content[0]?.text ?? "", /lab/);
});

test.after(async () => {
	delete process.env.GENTLE_BOUNTY_PROGRAM;
	await rm(ROOT, { recursive: true, force: true });
});
