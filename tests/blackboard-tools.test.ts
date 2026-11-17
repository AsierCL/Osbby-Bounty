/**
 * S4: the tool the model actually calls. The author comes from the harness, reads are pruned, and a
 * duplicate publish tells the agent to stop repeating work instead of silently accepting it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSharedBlackboard } from "../src/core/blackboard.ts";
import { runBlackboardAction } from "../src/pi/blackboard-tools.ts";

async function withBoard(run: (board: ReturnType<typeof createSharedBlackboard>) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-blackboard-tools-"));
	try {
		await run(createSharedBlackboard({ dir, program: "acme" }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("publish records the session as author, not the caller's text", async () => {
	await withBoard(async (board) => {
		const result = await runBlackboardAction(board, "S-42", { action: "publish", category: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" } });
		assert.equal(result.ok, true);
		assert.match(result.text, /Publicado/);
		const [artifact] = await board.query();
		assert.equal(artifact?.discoveredBy, "S-42");
	});
});

test("an anonymous session cannot publish", async () => {
	await withBoard(async (board) => {
		const result = await runBlackboardAction(board, "   ", { action: "publish", category: "endpoint", target: "https://a.acme.com/api" });
		assert.equal(result.ok, false);
		assert.match(result.text, /autor/);
		assert.equal((await board.query()).length, 0);
	});
});

test("a duplicate publish says it was already there", async () => {
	await withBoard(async (board) => {
		await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" } });
		const again = await runBlackboardAction(board, "S-2", { action: "publish", category: "endpoint", target: "https://a.acme.com/api", data: { param: "org_id" } });
		assert.equal(again.ok, true);
		assert.match(again.text, /Ya estaba/);
		assert.equal(again.details.created, false);
	});
});

test("publish without a category or with an invalid one is refused", async () => {
	await withBoard(async (board) => {
		const missing = await runBlackboardAction(board, "S-1", { action: "publish", target: "https://a.acme.com/api" });
		assert.equal(missing.ok, false);
		assert.match(missing.text, /Falta category/);
		const invalid = await runBlackboardAction(board, "S-1", { action: "publish", category: "cookie" as never, target: "https://a.acme.com/api" });
		assert.equal(invalid.ok, false);
		assert.match(invalid.text, /invalid category/);
		assert.equal((await board.query()).length, 0);
	});
});

test("a payload that belongs in the evidence store is refused", async () => {
	await withBoard(async (board) => {
		const result = await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://a.acme.com/api", data: { body: "x".repeat(5000) } });
		assert.equal(result.ok, false);
		assert.match(result.text, /bounty_evidence/);
		assert.equal((await board.query()).length, 0);
	});
});

test("query filters by category, target and limit", async () => {
	await withBoard(async (board) => {
		await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://a.acme.com/api" });
		await runBlackboardAction(board, "S-1", { action: "publish", category: "hidden_param", target: "https://a.acme.com/api", data: { param: "debug" } });
		await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://b.acme.com/api" });
		const endpoints = await runBlackboardAction(board, "S-2", { action: "query", category: "endpoint" });
		assert.equal(endpoints.details.count, 2);
		assert.equal((await runBlackboardAction(board, "S-2", { action: "query", target: "https://a.acme.com/api" })).details.count, 2);
		assert.equal((await runBlackboardAction(board, "S-2", { action: "query", limit: 1 })).details.count, 1);
	});
});

test("claim and release need a real artifact id", async () => {
	await withBoard(async (board) => {
		const published = await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://a.acme.com/api" });
		const id = String(published.details.id);
		assert.equal((await runBlackboardAction(board, "S-2", { action: "claim", id, ttlMs: 60_000 })).ok, true);
		const blocked = await runBlackboardAction(board, "S-3", { action: "claim", id, ttlMs: 60_000 });
		assert.equal(blocked.ok, false);
		assert.match(blocked.text, /en curso por S-2/);
		assert.equal((await runBlackboardAction(board, "S-3", { action: "release", id })).ok, false);
		assert.equal((await runBlackboardAction(board, "S-2", { action: "release", id })).ok, true);
		const missing = await runBlackboardAction(board, "S-1", { action: "claim", id: "0000000000000000" });
		assert.equal(missing.ok, false);
		assert.match(missing.text, /No existe/);
	});
});

test("since returns only what is newer, with its head", async () => {
	await withBoard(async (board) => {
		const first = await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://one.acme.com/api" });
		const firstTs = String((await board.query())[0]?.ts);
		await runBlackboardAction(board, "S-1", { action: "publish", category: "endpoint", target: "https://two.acme.com/api" });

		const fresh = await runBlackboardAction(board, "S-2", { action: "since", ts: firstTs });
		assert.equal(fresh.ok, true);
		assert.match(fresh.text, /two\.acme\.com/);
		assert.doesNotMatch(fresh.text, /one\.acme\.com/);
		assert.equal(fresh.details.count, 1);
		assert.ok(first.details.id);
	});
});

test("an unknown action is refused instead of guessed", async () => {
	await withBoard(async (board) => {
		const result = await runBlackboardAction(board, "S-1", { action: "subscribe" as never });
		assert.equal(result.ok, false);
		assert.match(result.text, /Acción desconocida/);
	});
});
