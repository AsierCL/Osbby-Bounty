/**
 * S101: the tool-call budget belongs to the program and survives a restart. Hitting it pauses cleanly,
 * seals the evidence, and extending the limit lets the session continue from where it stopped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";

async function setup(dir: string, maxToolCalls: number) {
	const calls: string[][] = [];
	const session = createSession(
		{ root: dir, program: "lab", budget: { maxToolCalls } },
		{
			dns: async () => ({ cname: [] }),
			readFile: (path) => readFile(path, "utf8"),
			runTool: async (argv) => {
				calls.push(argv);
				return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" };
			},
			confirm: async () => true,
		},
	);
	return { session, calls };
}

const run = (session: Awaited<ReturnType<typeof setup>>["session"], path: string) =>
	session.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:3000${path}`], target: `http://127.0.0.1:3000${path}` });

test("the limit stops exactly at N, records it in state.json and status.md, and extending resumes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-budget-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 500\n", "utf8");

		const first = await setup(dir, 5);
		await first.session.scope({ file: scopePath, confirm: async () => true });
		for (let index = 0; index < 5; index += 1) {
			const result = await run(first.session, `/r${index}`);
			assert.equal(result.ok, true, `call ${index + 1} should run: ${result.text}`);
		}
		const sixth = await run(first.session, "/r5");
		assert.equal(sixth.ok, false);
		assert.match(sixth.text, /Presupuesto alcanzado/);
		assert.equal(first.calls.length, 5, "the sixth call must not execute");

		const state = JSON.parse(await readFile(join(dir, "work", "lab", "state.json"), "utf8"));
		assert.deepEqual([state.budget.toolCalls, state.budget.limitHit], [5, "toolCalls"]);
		const status = await readFile(join(dir, "work", "lab", "status.md"), "utf8");
		assert.match(status, /Presupuesto alcanzado/);
		assert.match(status, /límite de llamadas/);

		// Extending: a new session with a higher limit continues from 5, not from zero.
		const second = await setup(dir, 7);
		await second.session.scope({ file: scopePath, confirm: async () => true });
		// Extended to 7: two more calls fit (6 and 7), the ninth attempt (call 8) is refused.
		const resumed = await run(second.session, "/r6");
		assert.equal(resumed.ok, true, `resume should run: ${resumed.text}`);
		const seventh = await run(second.session, "/r7");
		assert.equal(seventh.ok, true, `call 7 should run: ${seventh.text}`);
		const eighth = await run(second.session, "/r8");
		assert.equal(eighth.ok, false, "the extended limit must stop at exactly 7");
		assert.match(eighth.text, /Presupuesto alcanzado/);
		const stateAfter = JSON.parse(await readFile(join(dir, "work", "lab", "state.json"), "utf8"));
		assert.equal(stateAfter.budget.toolCalls, 7);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a fresh program starts at zero and the default limit is 500, not 16", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-budget-default-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 500\n", "utf8");
		const { session } = await setup(dir, 500);
		await session.scope({ file: scopePath, confirm: async () => true });
		await run(session, "/x");
		const state = JSON.parse(await readFile(join(dir, "work", "lab", "state.json"), "utf8"));
		assert.equal(state.budget.toolCalls, 1);
		assert.equal(state.budget.limitHit, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("S102: --restart-limits zeroes the counters, records it in the chain, and a reload resumes", async () => {
	const { restartLimits } = await import("../scripts/restart-limits.ts");
	const dir = await mkdtemp(join(tmpdir(), "bounty-restart-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 500\n", "utf8");
		const first = await setup(dir, 2);
		await first.session.scope({ file: scopePath, confirm: async () => true });
		assert.equal((await run(first.session, "/a")).ok, true);
		assert.equal((await run(first.session, "/b")).ok, true);
		const third = await run(first.session, "/c");
		assert.equal(third.ok, false, "the limit of 2 must stop the third call");

		const restarted = await restartLimits(dir, "lab", () => Date.parse("2026-11-17T12:00:00Z"));
		assert.equal(restarted.reset, true);
		assert.equal(restarted.previous?.toolCalls, 2);

		const state = JSON.parse(await readFile(join(dir, "work", "lab", "state.json"), "utf8"));
		assert.deepEqual([state.budget.toolCalls, state.budget.tokens, state.budget.limitHit], [0, 0, null]);
		assert.equal(state.budget.startedAt, "2026-11-17T12:00:00.000Z");

		const chain = (await (await import("../src/core/evidence.ts")).createEvidenceStore(join(dir, "work", "lab", "evidence")).read()).filter((record) => record.kind === "budget-reset");
		assert.equal(chain.length, 1);
		assert.equal((chain[0]?.payload as { previous: { toolCalls: number } }).previous.toolCalls, 2);

		// Reload the scope in the same session: the in-memory clock picks up the reset.
		await first.session.scope({ file: scopePath, confirm: async () => true });
		assert.equal((await run(first.session, "/d")).ok, true, "after the reset, calls fit again");
		assert.equal((await run(first.session, "/e")).ok, true);
		assert.equal((await run(first.session, "/f")).ok, false, "the limit still applies: 2 more, not infinite");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
