/**
 * Per-host rate limiting (S8 "rate limiter por host", S17a "lógica pura con reloj inyectable
 * (se reutilizará en el proxy de Fase C)").
 *
 * No test here touches real time: the clock is a variable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter } from "../src/core/ratelimit.ts";

function fakeClock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
	};
}

test("the bucket starts full: the first reservations do not wait", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 2 }, clock.now);
	for (let i = 0; i < 2; i += 1) {
		const reservation = limiter.reserve("a.acme.com");
		assert.equal(reservation.allowed, true);
		if (reservation.allowed) assert.equal(reservation.delayMs, 0);
	}
});

test("once drained, the next reservation waits one token interval", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 2, burst: 2 }, clock.now);
	limiter.reserve("a.acme.com");
	limiter.reserve("a.acme.com");
	const third = limiter.reserve("a.acme.com");
	assert.equal(third.allowed, true);
	if (third.allowed) assert.equal(third.delayMs, 500);
});

test("advancing the injected clock refills the bucket", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 2, burst: 2 }, clock.now);
	limiter.reserve("a.acme.com");
	limiter.reserve("a.acme.com");
	clock.advance(1000);
	const after = limiter.reserve("a.acme.com");
	assert.equal(after.allowed, true);
	if (after.allowed) assert.equal(after.delayMs, 0);
});

test("hosts have independent buckets", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 1 }, clock.now);
	const first = limiter.reserve("a.acme.com");
	const other = limiter.reserve("b.acme.com");
	assert.equal(first.allowed && first.delayMs, 0);
	assert.equal(other.allowed && other.delayMs, 0);
});

test("a per-host override wins over the default rate", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 1, perHost: { "slow.acme.com": 0.5 }, burst: 1 }, clock.now);
	limiter.reserve("slow.acme.com");
	const second = limiter.reserve("slow.acme.com");
	assert.equal(second.allowed, true);
	if (second.allowed) assert.equal(second.delayMs, 2000);
});

test("the daily cap refuses instead of queueing", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 100, dailyCap: 3 }, clock.now);
	for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve("a.acme.com").allowed, true);
	const refused = limiter.reserve("a.acme.com");
	assert.equal(refused.allowed, false);
	if (!refused.allowed) assert.match(refused.reason, /daily cap/);
});

test("an invalid rate is rejected at construction, not at request time", () => {
	assert.throws(() => createRateLimiter({ defaultRps: 0 }, () => 0), /defaultRps/);
	assert.throws(() => createRateLimiter({ defaultRps: -1 }, () => 0), /defaultRps/);
	assert.throws(() => createRateLimiter({ defaultRps: 1, perHost: { "a.acme.com": 0 } }, () => 0), /perHost/);
});

test("stats report what was spent per host", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 10 }, clock.now);
	limiter.reserve("a.acme.com");
	limiter.reserve("a.acme.com");
	assert.equal(limiter.stats("a.acme.com").spent, 2);
	assert.equal(limiter.stats("b.acme.com").spent, 0);
});

test("delays never go negative and never shrink below the token interval", () => {
	const clock = fakeClock();
	const limiter = createRateLimiter({ defaultRps: 1, burst: 1 }, clock.now);
	const delays: number[] = [];
	for (let i = 0; i < 5; i += 1) {
		const reservation = limiter.reserve("a.acme.com");
		assert.equal(reservation.allowed, true);
		if (reservation.allowed) {
			assert.ok(reservation.delayMs >= 0);
			delays.push(reservation.delayMs);
		}
	}
	// S89: with a frozen clock the reservations queue up at one interval each, instead of each one
	// claiming "one interval from now" (which let two sessions sleep together and double the rate).
	assert.deepEqual(delays, [0, 1000, 2000, 3000, 4000]);
});
