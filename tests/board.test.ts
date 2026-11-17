/**
 * S3/S5: the board is the coordination primitive of the swarm. These tests pin the properties that
 * make coordination safe: idempotent publish, leases that expire, no lost writes across *processes*
 * (not just across promises), and a corrupt log that fails closed instead of silently skipping a
 * record — a skipped record is duplicate work later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBoard } from "../src/core/board.ts";

const BOARD_SOURCE = pathToFileURL(join(import.meta.dirname, "..", "src", "core", "board.ts")).href;

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-board-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("publish is idempotent: the same discovery twice creates one entry", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const first = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", data: { param: "org_id" }, by: "js-agent" });
		const second = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", data: { param: "org_id" }, by: "authz-agent" });

		assert.equal(first.created, true);
		assert.equal(second.created, false);
		assert.equal(second.entry.seq, first.entry.seq);
		assert.equal(second.entry.by, "js-agent");
		assert.equal((await board.state()).count, 1);
	});
});

test("a different data payload on the same target is a different discovery", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		await board.publish({ kind: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" }, by: "js-agent" });
		const other = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api", data: { param: "role" }, by: "js-agent" });
		assert.equal(other.created, true);
		assert.equal((await board.state()).count, 2);
	});
});

test("concurrent publishes from one process lose nothing and number the entries", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		await Promise.all(
			Array.from({ length: 12 }, (_unused, index) =>
				board.publish({ kind: "host", target: `https://h${index}.acme.com`, by: "recon-agent" }),
			),
		);

		const entries = await board.query();
		assert.equal(entries.length, 12);
		assert.deepEqual(entries.map((entry) => entry.seq).sort((left, right) => left - right), Array.from({ length: 12 }, (_u, index) => index + 1));
		assert.equal(new Set(entries.map((entry) => entry.fingerprint)).size, 12);
	});
});

test("concurrent publishes from separate processes share one log", async () => {
	await withDir(async (dir) => {
		const helper = join(dir, "writer.mjs");
		await writeFile(
			helper,
			[
				`import { createBoard } from ${JSON.stringify(BOARD_SOURCE)};`,
				"const [boardDir, who, count] = process.argv.slice(2);",
				"const board = createBoard({ dir: boardDir });",
				"for (let index = 0; index < Number(count); index += 1) {",
				`	await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/" + who + "/" + index, by: who });`,
				"}",
			].join("\n"),
			"utf8",
		);

		const writers = ["alpha", "beta", "gamma", "delta"];
		await Promise.all(
			writers.map(
				(who) =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(process.execPath, ["--experimental-strip-types", helper, dir, who, "5"], { stdio: "pipe" });
						let stderr = "";
						child.stderr.on("data", (chunk) => {
							stderr += chunk.toString();
						});
						child.on("error", reject);
						child.on("close", (code) => {
							if (code === 0) resolve();
							else reject(new Error(`writer ${who} exited ${code}: ${stderr}`));
						});
					}),
			),
		);

		const board = createBoard({ dir });
		const entries = await board.query();
		assert.equal(entries.length, 20);
		assert.equal(new Set(entries.map((entry) => entry.seq)).size, 20);
		assert.equal(Math.max(...entries.map((entry) => entry.seq)), 20);
		assert.equal(new Set(entries.map((entry) => entry.fingerprint)).size, 20);
		assert.deepEqual([...new Set(entries.map((entry) => entry.by))].sort(), writers.slice().sort());
		assert.equal((await board.state()).headSeq, 20);
	});
});

test("a claim blocks another owner while the lease is alive", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const created = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", by: "recon-agent" });

		const mine = await board.claim(created.entry.seq, { by: "authz-agent", ttlMs: 60_000 });
		assert.equal(mine.ok, true);

		const theirs = await board.claim(created.entry.seq, { by: "logic-agent", ttlMs: 60_000 });
		assert.equal(theirs.ok, false);
		assert.equal(theirs.reason, "claimed");
		assert.equal(theirs.claimedBy, "authz-agent");
	});
});

test("the same owner renewing its own claim is allowed", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const created = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", by: "recon-agent" });
		await board.claim(created.entry.seq, { by: "authz-agent", ttlMs: 60_000 });
		const renewed = await board.claim(created.entry.seq, { by: "authz-agent", ttlMs: 120_000 });
		assert.equal(renewed.ok, true);
	});
});

test("a released claim is claimable by someone else", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const created = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", by: "recon-agent" });
		await board.claim(created.entry.seq, { by: "authz-agent", ttlMs: 60_000 });
		const released = await board.release(created.entry.seq, "authz-agent");
		assert.equal(released.released, true);

		const theirs = await board.claim(created.entry.seq, { by: "logic-agent", ttlMs: 60_000 });
		assert.equal(theirs.ok, true);
	});
});

test("only the claimant releases, and releasing what was never claimed is not a release", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const created = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", by: "recon-agent" });
		await board.claim(created.entry.seq, { by: "authz-agent", ttlMs: 60_000 });

		assert.equal((await board.release(created.entry.seq, "logic-agent")).released, false);
		assert.equal((await board.claim(created.entry.seq, { by: "logic-agent", ttlMs: 60_000 })).ok, false);
	});
});

test("an expired lease can be stolen, and the new owner is recorded", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const created = await board.publish({ kind: "endpoint", target: "https://a.acme.com/api/orders", by: "recon-agent" });
		await board.claim(created.entry.seq, { by: "authz-agent", ttlMs: 20 });
		await sleep(60);

		const stolen = await board.claim(created.entry.seq, { by: "logic-agent", ttlMs: 60_000 });
		assert.equal(stolen.ok, true);
		const claims = await board.claims();
		assert.equal(claims[String(created.entry.seq)]?.by, "logic-agent");
	});
});

test("claiming an entry that does not exist is not found", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		const result = await board.claim(99, { by: "authz-agent" });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "not-found");
	});
});

test("since returns only what is newer than the cursor, in order", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		await board.publish({ kind: "host", target: "https://one.acme.com", by: "recon-agent" });
		await board.publish({ kind: "host", target: "https://two.acme.com", by: "recon-agent" });
		await board.publish({ kind: "host", target: "https://three.acme.com", by: "recon-agent" });

		const fresh = await board.since(1);
		assert.deepEqual(fresh.map((entry) => entry.seq), [2, 3]);
		assert.deepEqual((await board.since(3)), []);
	});
});

test("query filters by kind and target without touching the rest", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		await board.publish({ kind: "host", target: "https://a.acme.com", by: "recon-agent" });
		await board.publish({ kind: "endpoint", target: "https://a.acme.com/api", by: "js-agent" });
		await board.publish({ kind: "endpoint", target: "https://b.acme.com/api", by: "js-agent" });

		assert.deepEqual((await board.query({ kind: "endpoint" })).map((entry) => entry.target), ["https://a.acme.com/api", "https://b.acme.com/api"]);
		assert.deepEqual((await board.query({ target: "https://a.acme.com" })).map((entry) => entry.kind), ["host"]);
	});
});

test("every discovery must name its author", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		await assert.rejects(() => board.publish({ kind: "host", target: "https://a.acme.com", by: "  " }), /by/);
		await assert.rejects(() => board.publish({ kind: "", target: "https://a.acme.com", by: "recon-agent" }), /kind/);
		await assert.rejects(() => board.publish({ kind: "host", target: "", by: "recon-agent" }), /target/);
	});
});

test("a corrupt log fails closed instead of skipping the line", async () => {
	await withDir(async (dir) => {
		const board = createBoard({ dir });
		await board.publish({ kind: "host", target: "https://a.acme.com", by: "recon-agent" });
		await writeFile(join(dir, "board.jsonl"), `${await readFile(join(dir, "board.jsonl"), "utf8")}{ this is not json\n`, "utf8");

		await assert.rejects(() => board.publish({ kind: "host", target: "https://b.acme.com", by: "recon-agent" }), /corrupt/);
		await assert.rejects(() => board.query(), /corrupt/);
		await assert.rejects(() => board.state(), /corrupt/);
	});
});

test("two board instances on one directory see each other", async () => {
	await withDir(async (dir) => {
		const first = createBoard({ dir });
		const second = createBoard({ dir });
		await first.publish({ kind: "host", target: "https://a.acme.com", by: "recon-agent" });
		const seen = await second.query();
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.by, "recon-agent");
		assert.equal((await second.state()).headSeq, 1);
	});
});
