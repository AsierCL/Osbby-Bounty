/**
 * Hash-chained evidence store (S8 "evidencia con cadena de hashes", S17a "además del hash previo,
 * guarda aparte un puntero de cabeza (último hash + contador) para detectar truncado de cola; append
 * atómico con bloqueo").
 *
 * The threat model is not a network attacker: it is a compromised or careless agent editing its own
 * evidence before a report is filed. Every mutation of the log must be detectable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";

async function withStore<T>(run: (dir: string, store: ReturnType<typeof createEvidenceStore>) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-evidence-"));
	try {
		return await run(dir, createEvidenceStore(dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("the first record chains from the genesis hash and gets seq 1", () =>
	withStore(async (_dir, store) => {
		const record = await store.append({ kind: "request", payload: { url: "http://localhost:3000/a" } });
		assert.equal(record.seq, 1);
		assert.equal(record.prevHash, "GENESIS");
		assert.match(record.hash, /^[0-9a-f]{64}$/);
	}));

test("each record links to the previous hash", () =>
	withStore(async (_dir, store) => {
		const first = await store.append({ kind: "request", payload: { n: 1 } });
		const second = await store.append({ kind: "response", payload: { n: 2 } });
		assert.equal(second.prevHash, first.hash);
		assert.equal(second.seq, 2);
	}));

test("the head pointer tracks the last record separately", () =>
	withStore(async (dir, store) => {
		const first = await store.append({ kind: "request", payload: { n: 1 } });
		await store.append({ kind: "request", payload: { n: 2 } });
		const head = JSON.parse(await readFile(join(dir, "head.json"), "utf8"));
		assert.equal(head.seq, 2);
		const records = await store.read();
		assert.equal(head.hash, records[records.length - 1]?.hash);
		assert.notEqual(head.hash, first.hash);
	}));

test("an intact log verifies", () =>
	withStore(async (_dir, store) => {
		await store.append({ kind: "request", payload: { n: 1 } });
		await store.append({ kind: "request", payload: { n: 2 } });
		const result = await store.verify();
		assert.deepEqual(result, { ok: true, count: 2 });
	}));

test("editing a payload breaks verification at that record", () =>
	withStore(async (dir, store) => {
		await store.append({ kind: "request", payload: { n: 1 } });
		await store.append({ kind: "request", payload: { n: 2 } });
		const logPath = join(dir, "log.jsonl");
		const text = await readFile(logPath, "utf8");
		await writeFile(logPath, text.replace('"n":2', '"n":3'), "utf8");
		const result = await store.verify();
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.reason, /hash mismatch|payload/);
			assert.equal(result.seq, 2);
		}
	}));

test("truncating the tail is detected by the head pointer", () =>
	withStore(async (dir, store) => {
		await store.append({ kind: "request", payload: { n: 1 } });
		await store.append({ kind: "request", payload: { n: 2 } });
		const logPath = join(dir, "log.jsonl");
		const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
		await writeFile(logPath, `${lines[0]}\n`, "utf8");
		const result = await store.verify();
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /truncat/);
	}));

test("deleting the head pointer with a non-empty log fails closed", () =>
	withStore(async (dir, store) => {
		await store.append({ kind: "request", payload: { n: 1 } });
		await rm(join(dir, "head.json"));
		const result = await store.verify();
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /head/);
	}));

test("reordering records breaks the chain", () =>
	withStore(async (dir, store) => {
		await store.append({ kind: "request", payload: { n: 1 } });
		await store.append({ kind: "request", payload: { n: 2 } });
		await store.append({ kind: "request", payload: { n: 3 } });
		const logPath = join(dir, "log.jsonl");
		const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
		await writeFile(logPath, `${lines[1]}\n${lines[0]}\n${lines[2]}\n`, "utf8");
		const result = await store.verify();
		assert.equal(result.ok, false);
	}));

test("concurrent appends are serialized: unique sequence numbers, valid chain", () =>
	withStore(async (_dir, store) => {
		await Promise.all(
			Array.from({ length: 20 }, (_unused, index) => store.append({ kind: "request", payload: { index } })),
		);
		const records = await store.read();
		assert.equal(records.length, 20);
		const seqs = records.map((record) => record.seq).sort((a, b) => a - b);
		assert.deepEqual(seqs, Array.from({ length: 20 }, (_unused, index) => index + 1));
		const result = await store.verify();
		assert.equal(result.ok, true);
	}));

test("every appended line is complete JSON (no interleaved writes)", () =>
	withStore(async (dir, store) => {
		await Promise.all(Array.from({ length: 10 }, (_unused, index) => store.append({ kind: "request", payload: { index } })));
		const text = await readFile(join(dir, "log.jsonl"), "utf8");
		for (const line of text.trimEnd().split("\n")) {
			assert.doesNotThrow(() => JSON.parse(line));
		}
	}));

test("an empty store verifies with count 0 and no head", () =>
	withStore(async (_dir, store) => {
		assert.equal(await store.head(), null);
		assert.deepEqual(await store.verify(), { ok: true, count: 0 });
	}));
