/**
 * S89: the program's rate belongs to the program, not to a process. Two sessions on the same program
 * share one bucket on disk, and reservations queue instead of waking together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSharedRateLimiter } from "../src/core/shared-ratelimit.ts";

function fakeClock(start = 1_700_000_000_000) {
	let value = start;
	return { now: () => value, advance: (ms: number) => (value += ms) };
}

test("two limiters on the same directory share the bucket", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-shared-rate-"));
	try {
		const clock = fakeClock();
		const first = createSharedRateLimiter({ dir, policy: { defaultRps: 1, burst: 1 }, clock: clock.now });
		const second = createSharedRateLimiter({ dir, policy: { defaultRps: 1, burst: 1 }, clock: clock.now });

		const one = await first.reserve("a.acme.com");
		const two = await second.reserve("a.acme.com");
		assert.equal(one.allowed && one.delayMs, 0, "the burst slot goes to the first");
		assert.equal(two.allowed && two.delayMs, 1000, "the second session must wait for the next slot, not get its own burst");

		const state = JSON.parse(await readFile(join(dir, ".rate-limit.json"), "utf8")) as Record<string, { spent: number }>;
		assert.equal(state["a.acme.com"]?.spent, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("advancing the clock matches the queued reservations", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-shared-rate2-"));
	try {
		const clock = fakeClock();
		const limiter = createSharedRateLimiter({ dir, policy: { defaultRps: 2, burst: 2 }, clock: clock.now });
		const delays: number[] = [];
		for (let index = 0; index < 6; index += 1) {
			const reservation = await limiter.reserve("a.acme.com");
			assert.equal(reservation.allowed, true);
			if (reservation.allowed) delays.push(reservation.delayMs);
			clock.advance(500);
		}
		assert.deepEqual(delays, [0, 0, 0, 0, 0, 0], "at 2/s each 500ms step refills exactly one token");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
