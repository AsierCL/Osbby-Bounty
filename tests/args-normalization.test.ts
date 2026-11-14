/**
 * S78/task 2: `args` is what the tool receives, never the tool name. A child that repeated the tool
 * inside args produced `curl curl …`: curl fetched both positionally, the gate validated both hosts,
 * but the recorded argv did not describe what ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { createSession } from "../src/pi/session.ts";

async function setup(seen: string[][]) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-args-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 20\n", "utf8");
	const session = createSession(
		{ root: dir, program: "lab" },
		{
			dns: async () => ({ cname: [] }),
			readFile: (path) => readFile(path, "utf8"),
			runTool: async (argv) => {
				seen.push(argv);
				return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" };
			},
			confirm: async () => true,
		},
	);
	await session.scope({ file: scopePath });
	return { dir, session, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a duplicated tool name in args is dropped, and the record matches what ran", async () => {
	const seen: string[][] = [];
	const h = await setup(seen);
	try {
		const result = await h.session.run({
			tool: "curl",
			args: ["curl", "-sS", "-i", "http://127.0.0.1:3000/api/invoices/2"],
			target: "http://127.0.0.1:3000/api/invoices/2",
		});
		assert.equal(result.ok, true, result.text);
		assert.deepEqual(seen[0], ["curl", "-sS", "-i", "http://127.0.0.1:3000/api/invoices/2"]);
		const store = createEvidenceStore(join(h.dir, "work", "lab", "evidence"));
		const execution = (await store.read()).filter((record) => record.kind === "execution").at(-1);
		assert.deepEqual((execution?.payload as { argv: string[] }).argv, ["curl", "-sS", "-i", "http://127.0.0.1:3000/api/invoices/2"]);
	} finally {
		await h.cleanup();
	}
});

test("the gate receives the normalized args, so a second real host still blocks", async () => {
	const seen: string[][] = [];
	const h = await setup(seen);
	try {
		const blocked = await h.session.run({
			tool: "curl",
			args: ["curl", "-sS", "http://otro.example.com/x", "http://127.0.0.1:3000/api/invoices/2"],
			target: "http://127.0.0.1:3000/api/invoices/2",
		});
		assert.equal(blocked.ok, false);
		assert.match(blocked.text, /otro\.example\.com/);
		assert.equal(seen.length, 0, "nothing may run when a second host is out of scope");
	} finally {
		await h.cleanup();
	}
});
