/**
 * S3/S5: the model-facing board action, tested without Pi. The properties that matter are the ones
 * a swarm depends on: the author comes from the harness, reads are pruned, and a duplicate publish
 * tells the agent to stop repeating work instead of silently accepting it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoard } from "../src/core/board.ts";
import { runBoardAction } from "../src/pi/board-tools.ts";

async function withBoard(run: (board: ReturnType<typeof createBoard>, dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-board-tools-"));
	try {
		await run(createBoard({ dir }), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("publish records the session as author, not the caller's text", async () => {
	await withBoard(async (board) => {
		const result = await runBoardAction(board, "S-42", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" } });
		assert.equal(result.ok, true);
		assert.match(result.text, /Publicado #1/);
		const [entry] = await board.query();
		assert.equal(entry?.by, "S-42");
	});
});

test("an anonymous session cannot publish", async () => {
	await withBoard(async (board) => {
		const result = await runBoardAction(board, "   ", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api" });
		assert.equal(result.ok, false);
		assert.match(result.text, /autor/);
		assert.equal((await board.query()).length, 0);
	});
});

test("a duplicate publish says it was already there and who has it", async () => {
	await withBoard(async (board) => {
		await runBoardAction(board, "S-1", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" } });
		const first = await board.query();
		await runBoardAction(board, "S-2", { action: "claim", seq: first[0]?.seq ?? 0, ttlMs: 60_000 });

		const again = await runBoardAction(board, "S-3", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" } });
		assert.equal(again.ok, true);
		assert.match(again.text, /Ya estaba/);
		assert.match(again.text, /en curso por S-2/);
		assert.equal(again.details.created, false);
	});
});

test("claim tells the second agent who is holding the item", async () => {
	await withBoard(async (board) => {
		await runBoardAction(board, "S-1", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api" });
		assert.equal((await runBoardAction(board, "S-2", { action: "claim", seq: 1, ttlMs: 60_000 })).ok, true);
		const second = await runBoardAction(board, "S-3", { action: "claim", seq: 1, ttlMs: 60_000 });
		assert.equal(second.ok, false);
		assert.match(second.text, /en curso por S-2/);
	});
});

test("claim and release need a positive seq", async () => {
	await withBoard(async (board) => {
		const claim = await runBoardAction(board, "S-1", { action: "claim", seq: 0 });
		assert.equal(claim.ok, false);
		assert.match(claim.text, /seq/);
		const missing = await runBoardAction(board, "S-1", { action: "claim", seq: 7 });
		assert.equal(missing.ok, false);
		assert.match(missing.text, /No existe/);
		assert.equal((await runBoardAction(board, "S-1", { action: "release", seq: 7 })).ok, false);
	});
});

test("since returns only what is newer and reports the new head", async () => {
	await withBoard(async (board) => {
		await runBoardAction(board, "S-1", { action: "publish", kind: "host", target: "https://one.acme.com" });
		await runBoardAction(board, "S-1", { action: "publish", kind: "host", target: "https://two.acme.com" });

		const fresh = await runBoardAction(board, "S-2", { action: "since", cursor: 1 });
		assert.equal(fresh.ok, true);
		assert.match(fresh.text, /two\.acme\.com/);
		assert.doesNotMatch(fresh.text, /one\.acme\.com/);
		assert.equal(fresh.details.headSeq, 2);

		const quiet = await runBoardAction(board, "S-2", { action: "since", cursor: 2 });
		assert.match(quiet.text, /Sin novedades/);
		assert.equal(quiet.details.count, 0);
	});
});

test("query filters by kind and target", async () => {
	await withBoard(async (board) => {
		await runBoardAction(board, "S-1", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api" });
		await runBoardAction(board, "S-1", { action: "publish", kind: "host", target: "https://a.acme.com" });
		const endpoints = await runBoardAction(board, "S-2", { action: "query", kind: "endpoint" });
		assert.equal(endpoints.details.count, 1);
		assert.match(endpoints.text, /endpoint/);
		assert.doesNotMatch(endpoints.text, /host/);
	});
});

test("a payload that belongs in the evidence store is refused", async () => {
	await withBoard(async (board) => {
		const big = { body: "x".repeat(5000) };
		const result = await runBoardAction(board, "S-1", { action: "publish", kind: "endpoint", target: "https://a.acme.com/api", data: big });
		assert.equal(result.ok, false);
		assert.match(result.text, /bounty_evidence/);
		assert.equal((await board.query()).length, 0);
	});
});

test("publish without kind or target is refused", async () => {
	await withBoard(async (board) => {
		const noKind = await runBoardAction(board, "S-1", { action: "publish", target: "https://a.acme.com/api" });
		assert.equal(noKind.ok, false);
		const noTarget = await runBoardAction(board, "S-1", { action: "publish", kind: "endpoint" });
		assert.equal(noTarget.ok, false);
		assert.equal((await board.query()).length, 0);
	});
});

test("an unknown action is refused instead of guessed", async () => {
	await withBoard(async (board) => {
		const result = await runBoardAction(board, "S-1", { action: "subscribe" as never });
		assert.equal(result.ok, false);
		assert.match(result.text, /Acción desconocida/);
	});
});
