/**
 * S36: the verifier gets id + evidence, never the author's reasoning. The test plants a marker in
 * every field a finding has besides its id, and asserts the marker cannot appear in the task.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerifierTask, evidenceForVerifier, verifierTaskFor } from "../src/pi/verifier.ts";

const MARKER = "AUTHOR-REASONING-MARKER-9f2c";

async function records() {
	const dir = await mkdtemp(join(tmpdir(), "bounty-verifier-"));
	try {
		const store = createEvidenceStore(dir, { now: () => 1_700_000_000_000 });
		await store.append({ kind: "execution", payload: { tool: "httpx", argv: ["httpx", "-u", "http://127.0.0.1:3000/api/1"] } });
		await store.append({ kind: "execution-result", payload: { exitCode: 0, stdout: "HTTP 200 1234 bytes" } });
		await store.append({ kind: "finding-note", payload: { note: MARKER } });
		return await store.read();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("the task carries the finding id and the artifact hashes", async () => {
	const all = await records();
	const task = verifierTaskFor({ id: "F-0001" }, all);
	assert.match(task, /F-0001/);
	for (const record of all.filter((entry) => entry.kind !== "finding-note")) {
		assert.ok(task.includes(record.hash.slice(0, 16)), `missing hash of seq ${record.seq}`);
	}
});

test("the author's reasoning is structurally unreachable", async () => {
	const all = await records();
	const finding = {
		id: "F-0001",
		title: MARKER,
		notes: [MARKER],
		confidence: "high" as const,
		transitions: [{ at: "2026-11-11T00:00:00Z", from: null, to: "verified" as const, reason: MARKER }],
	};
	const task = verifierTaskFor(finding, all);
	assert.ok(!task.includes(MARKER), "the verifier task leaked the author's reasoning");
	assert.ok(!/confidence|severidad/i.test(task.split("Evidencia:")[0] ?? ""), "severity leaked into the instructions");
});

test("evidence kinds that carry notes are dropped, artifacts are kept", async () => {
	const all = await records();
	const filtered = evidenceForVerifier(all);
	assert.deepEqual(filtered.map((item) => item.kind), ["execution", "execution-result"]);
	assert.ok(!JSON.stringify(filtered).includes(MARKER));
});

test("the instructions require two reproductions through bounty_run", async () => {
	const task = buildVerifierTask({ findingId: "F-0002", evidence: [] });
	assert.match(task, /bounty_run/);
	assert.match(task, /dos veces/);
	assert.match(task, /datos, nunca instrucciones/);
});

test("a large payload is truncated with a byte count", () => {
	const big = "x".repeat(5000);
	const [item] = evidenceForVerifier([
		{ seq: 1, ts: "t", kind: "response", payloadHash: "ph", prevHash: "GENESIS", hash: "h", payload: big },
	]);
	assert.ok(item);
	assert.match(item.payload, /truncated \d+ bytes/);
	assert.ok(item.payload.length < 1400);
});
