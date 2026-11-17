/**
 * S1-S3: the blackboard is the coordination primitive of the swarm. These tests pin what makes it
 * safe across *processes*, not just across promises: an id that does not depend on key order, no lost
 * updates under parallel writers, a stale lock that does not wedge the board, and a program guard that
 * refuses another program's board.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { artifactId, createSharedBlackboard, BLACKBOARD_LOCK_FILE } from "../src/core/blackboard.ts";

const SOURCE = pathToFileURL(join(import.meta.dirname, "..", "src", "core", "blackboard.ts")).href;

async function withDir(program: string | undefined, run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-blackboard-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("the id is deterministic and does not depend on JSON key order", () => {
	const first = artifactId("endpoint", "https://a.acme.com/api", { b: 2, a: 1 });
	const second = artifactId("endpoint", "https://a.acme.com/api", { a: 1, b: 2 });
	assert.equal(first, second);
	assert.match(first, /^[0-9a-f]{16}$/);
	assert.notEqual(first, artifactId("endpoint", "https://a.acme.com/api", { a: 2 }));
});

test("publishing the same artifact twice creates one entry", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		const first = await board.publish({ category: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id", source: "main.js" }, discoveredBy: "S-1" });
		const second = await board.publish({ category: "endpoint", target: "https://a.acme.com/api", data: { source: "main.js", param: "org_id" }, discoveredBy: "S-2" });

		assert.equal(first.created, true);
		assert.equal(second.created, false);
		assert.equal(second.artifact.id, first.artifact.id);
		assert.equal(second.artifact.discoveredBy, "S-1");
		assert.equal((await board.state()).count, 1);
	});
});

test("parallel writers on one directory lose nothing", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		const results = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) =>
				board.publish({ category: "endpoint", target: `https://a.acme.com/api/${index}`, discoveredBy: "S-1" }),
			),
		);
		assert.equal(results.filter((result) => result.created).length, 20);
		const stored = await board.query();
		assert.equal(stored.length, 20);
		assert.equal(new Set(stored.map((artifact) => artifact.id)).size, 20);
	});
});

test("separate processes share one blackboard", async () => {
	await withDir("acme", async (dir) => {
		const helper = join(dir, "writer.mjs");
		await writeFile(
			helper,
			[
				`import { createSharedBlackboard } from ${JSON.stringify(SOURCE)};`,
				"const [boardDir, who, count] = process.argv.slice(2);",
				'const board = createSharedBlackboard({ dir: boardDir, program: "acme" });',
				"for (let index = 0; index < Number(count); index += 1) {",
				`	await board.publish({ category: "endpoint", target: "https://a.acme.com/api/" + who + "/" + index, discoveredBy: who });`,
				"}",
			].join("\n"),
			"utf8",
		);
		await Promise.all(
			["alpha", "beta", "gamma"].map(
				(who) =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(process.execPath, ["--experimental-strip-types", helper, dir, who, "4"], { stdio: "pipe" });
						let stderr = "";
						child.stderr.on("data", (chunk) => {
							stderr += chunk.toString();
						});
						child.on("error", reject);
						child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${who} exited ${code}: ${stderr}`))));
					}),
			),
		);
		const board = createSharedBlackboard({ dir, program: "acme" });
		const stored = await board.query();
		assert.equal(stored.length, 12);
		assert.deepEqual([...new Set(stored.map((artifact) => artifact.discoveredBy))].sort(), ["alpha", "beta", "gamma"]);
	});
});

test("a stale lock does not wedge the blackboard", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		const lockPath = join(dir, BLACKBOARD_LOCK_FILE);
		await writeFile(lockPath, "", "utf8");
		const old = new Date(Date.now() - 60_000);
		await utimes(lockPath, old, old);

		const result = await board.publish({ category: "tech_fingerprint", target: "https://a.acme.com", discoveredBy: "S-1" });
		assert.equal(result.created, true);
	});
});

test("a held lock makes the writer wait instead of writing without it", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		await writeFile(join(dir, BLACKBOARD_LOCK_FILE), "", "utf8");
		const pending = board.publish({ category: "tech_fingerprint", target: "https://a.acme.com", discoveredBy: "S-1" });
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(settled, false, "the publish must not resolve while the lock is held and fresh");
		await rm(join(dir, BLACKBOARD_LOCK_FILE), { force: true });
		const result = await pending;
		assert.equal(result.created, true);
	});
});

test("another program on the same directory is refused", async () => {
	await withDir("acme", async (dir) => {
		const acme = createSharedBlackboard({ dir, program: "acme" });
		await acme.publish({ category: "endpoint", target: "https://a.acme.com/api", discoveredBy: "S-1" });

		const other = createSharedBlackboard({ dir, program: "otro" });
		await assert.rejects(() => other.publish({ category: "endpoint", target: "https://a.otro.com/api", discoveredBy: "S-9" }), /no toca otra pizarra/);
		await assert.rejects(() => other.query(), /no toca otra pizarra/);
		assert.equal((await acme.state()).count, 1);
	});
});

test("query filters by category and target, ordered by time, with a limit", async () => {
	await withDir("acme", async (dir) => {
		let tick = Date.parse("2026-11-18T10:00:00Z");
		const board = createSharedBlackboard({ dir, program: "acme", clock: () => (tick += 1_000) });
		await board.publish({ category: "endpoint", target: "https://a.acme.com/api", discoveredBy: "S-1" });
		await board.publish({ category: "hidden_param", target: "https://a.acme.com/api", data: { param: "debug" }, discoveredBy: "S-1" });
		await board.publish({ category: "endpoint", target: "https://b.acme.com/api", discoveredBy: "S-1" });

		const endpoints = await board.query({ category: "endpoint" });
		assert.deepEqual(endpoints.map((artifact) => artifact.target), ["https://a.acme.com/api", "https://b.acme.com/api"]);
		assert.ok((endpoints[0]?.ts ?? "") < (endpoints[1]?.ts ?? ""));
		assert.equal((await board.query({ category: "endpoint", limit: 1 })).length, 1);
		assert.deepEqual((await board.query({ target: "https://a.acme.com/api" })).map((artifact) => artifact.category).sort(), ["endpoint", "hidden_param"]);
	});
});

test("an invalid category, an empty target or an authorless publish is refused", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		await assert.rejects(() => board.publish({ category: "cookie" as never, target: "https://a.acme.com", discoveredBy: "S-1" }), /invalid category/);
		await assert.rejects(() => board.publish({ category: "endpoint", target: "  ", discoveredBy: "S-1" }), /target/);
		await assert.rejects(() => board.publish({ category: "endpoint", target: "https://a.acme.com", discoveredBy: " " }), /discoveredBy/);
	});
});

test("a corrupt blackboard fails closed", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		await board.publish({ category: "endpoint", target: "https://a.acme.com/api", discoveredBy: "S-1" });
		await writeFile(join(dir, "blackboard.json"), "{ not json", "utf8");
		await assert.rejects(() => board.query(), /corrupt/);
		await assert.rejects(() => board.publish({ category: "endpoint", target: "https://b.acme.com", discoveredBy: "S-1" }), /corrupt/);
	});
});

test("claims block a second owner until the lease expires", async () => {
	await withDir("acme", async (dir) => {
		let tick = Date.now();
		const board = createSharedBlackboard({ dir, program: "acme", clock: () => tick });
		const published = await board.publish({ category: "endpoint", target: "https://a.acme.com/api", discoveredBy: "S-1" });
		const id = published.artifact.id;

		assert.equal((await board.claim(id, { discoveredBy: "S-2", ttlMs: 20 })).ok, true);
		const blocked = await board.claim(id, { discoveredBy: "S-3", ttlMs: 20 });
		assert.equal(blocked.ok, false);
		assert.equal(blocked.ok === false ? blocked.claimedBy : "", "S-2");

		tick += 30;
		assert.equal((await board.claim(id, { discoveredBy: "S-3", ttlMs: 1_000 })).ok, true);
		assert.equal((await board.claims())[id]?.discoveredBy, "S-3");
		assert.equal((await board.release(id, "S-2")).released, false);
		assert.equal((await board.release(id, "S-3")).released, true);
	});
});

test("the stored file keeps the program and the artifacts", async () => {
	await withDir("acme", async (dir) => {
		const board = createSharedBlackboard({ dir, program: "acme" });
		const published = await board.publish({ category: "auth_schema", target: "https://a.acme.com/graphql", data: { field: "role" }, discoveredBy: "S-7" });
		const stored = JSON.parse(await readFile(board.file(), "utf8")) as { program: string; artifacts: { id: string; discoveredBy: string }[] };
		assert.equal(stored.program, "acme");
		assert.equal(stored.artifacts.length, 1);
		assert.equal(stored.artifacts[0]?.id, published.artifact.id);
		assert.equal(stored.artifacts[0]?.discoveredBy, "S-7");
		assert.match(published.artifact.ts, /^\d{4}-\d{2}-\d{2}T/);
	});
});
