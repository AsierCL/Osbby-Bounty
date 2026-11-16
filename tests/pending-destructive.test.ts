/**
 * S90: with nobody at the keyboard a destructive action is QUEUED, never approved and never executed.
 * The queue is not an authorization: no field in it can make bounty_run run something.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";

async function setup(options: { night?: boolean; confirm?: () => Promise<boolean> } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-pending-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 20\n  allowed_methods:\n    - GET\n    - POST\n", "utf8");
	const executed: string[][] = [];
	const session = createSession(
		{ root: dir, program: "lab", ...(options.night === true ? { nightMode: true } : {}) },
		{
			dns: async () => ({ cname: [] }),
			readFile: (path) => readFile(path, "utf8"),
			runTool: async (argv) => {
				executed.push(argv);
				return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" };
			},
			...(options.confirm === undefined ? {} : { confirm: options.confirm }),
		},
	);
	await session.scope({ file: scopePath, confirm: async () => true });
	return { dir, session, executed, scopePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const mutation = (target: string) => ({
	tool: "curl",
	args: ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "-d", '{"query":"mutation { addNote { ok } }"}', target],
	target,
	why: "probar si la mutación está protegida",
});

test("night mode queues the destructive action, executes nothing, and the session keeps working", async () => {
	const h = await setup({ night: true });
	try {
		const queued = await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		assert.equal(queued.ok, false);
		assert.match(queued.text, /encolada como P-0001/);
		assert.equal(h.executed.length, 0, "nothing may run while queued");

		const items = await h.session.pendingQueue.pending();
		assert.equal(items.length, 1);
		assert.equal(items[0]?.tool, "curl");
		assert.match(items[0]?.why ?? "", /mutación/);

		// The session is not stopped: a normal GET still runs.
		const judge = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.equal(judge.ok, true, judge.text);
		assert.equal(h.executed.length, 1);

		// Hours later, without a human: still nothing.
		const again = await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		assert.equal(again.ok, false);
		assert.equal(h.executed.length, 1, "the queue never executes on its own");
	} finally {
		await h.cleanup();
	}
});

test("a low-risk annotation does not authorize anything", async () => {
	const h = await setup({ night: true });
	try {
		await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		const [item] = await h.session.pendingQueue.pending();
		assert.ok(item);
		await h.session.pendingQueue.annotate(item.id, {
			at: new Date().toISOString(),
			risk: "low",
			touchesThirdPartyData: false,
			financialEffect: false,
			whatCouldHappen: "escribe una nota en el lab",
			recommendation: "approve",
			note: "parece inocuo",
		});
		assert.equal(h.executed.length, 0, "an approve recommendation is an opinion, not an approval");
		const again = await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		assert.equal(again.ok, false);
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("with a real dialog the old behavior stays: no means no, and nothing is queued", async () => {
	const h = await setup({ night: false, confirm: async () => false });
	try {
		const denied = await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		assert.equal(denied.ok, false);
		assert.match(denied.text, /denegada por el humano/);
		assert.equal(h.executed.length, 0);
		assert.equal((await h.session.pendingQueue.pending()).length, 0);
	} finally {
		await h.cleanup();
	}
});

test("a hand-written approved flag in the queue file is ignored by bounty_run", async () => {
	const h = await setup({ night: true });
	try {
		await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		const file = h.session.pendingQueue.file();
		const raw = await readFile(file, "utf8");
		const tampered = raw
			.trim()
			.split("\n")
			.map((line) => {
				const item = JSON.parse(line) as Record<string, unknown>;
				return JSON.stringify({ ...item, approved: true, authorization: "granted" });
			})
			.join("\n");
		await writeFile(file, `${tampered}\n`, "utf8");
		// A second destructive attempt is queued again; nothing executes.
		await h.session.run(mutation("http://127.0.0.1:3000/graphql"));
		assert.equal(h.executed.length, 0, "no field in the queue authorizes execution");
	} finally {
		await h.cleanup();
	}
});
