/**
 * Per-host rate limiting as pure logic with an injected clock.
 *
 * Phase C reuses this same implementation inside the egress proxy, so it must not depend on timers,
 * `Date.now()` or the event loop: `reserve()` tells the caller how long to wait, and the caller
 * decides. A refusal (daily cap, invalid config) is a refusal, never a silent slowdown.
 */

export interface LimiterPolicy {
	defaultRps: number;
	perHost?: Record<string, number>;
	burst?: number;
	dailyCap?: number | null;
}

export type Reservation =
	| { allowed: true; host: string; delayMs: number }
	| { allowed: false; host: string; reason: string };

export interface LimiterStats {
	spent: number;
	tokens: number;
}

export interface Limiter {
	reserve(host: string): Reservation;
	stats(host: string): LimiterStats;
}

interface Bucket {
	tokens: number;
	last: number;
	spent: number;
}

function assertPositiveRate(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive number of requests per second, got ${String(value)}`);
	}
}

export function createRateLimiter(policy: LimiterPolicy, clock: () => number): Limiter {
	assertPositiveRate(policy.defaultRps, "defaultRps");
	for (const [host, rate] of Object.entries(policy.perHost ?? {})) {
		assertPositiveRate(rate, `perHost[${host}]`);
	}
	if (policy.burst !== undefined && (!Number.isInteger(policy.burst) || policy.burst < 1)) {
		throw new Error(`burst must be a positive integer, got ${String(policy.burst)}`);
	}
	if (policy.dailyCap !== undefined && policy.dailyCap !== null) {
		if (!Number.isInteger(policy.dailyCap) || policy.dailyCap < 0) {
			throw new Error(`dailyCap must be a non-negative integer, got ${String(policy.dailyCap)}`);
		}
	}

	const buckets = new Map<string, Bucket>();
	const dailyCap = policy.dailyCap ?? null;

	function rateFor(host: string): number {
		return policy.perHost?.[host] ?? policy.defaultRps;
	}

	function capacityFor(rate: number): number {
		return policy.burst ?? Math.max(1, Math.ceil(rate));
	}

	return {
		reserve(host: string): Reservation {
			const rate = rateFor(host);
			const capacity = capacityFor(rate);
			const now = clock();
			let bucket = buckets.get(host);
			if (!bucket) {
				bucket = { tokens: capacity, last: now, spent: 0 };
				buckets.set(host, bucket);
			}

			// Refill. A clock that moves backwards must not create tokens.
			const elapsed = Math.max(0, now - bucket.last);
			bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * rate) / 1000);
			bucket.last = Math.max(bucket.last, now);

			if (dailyCap !== null && bucket.spent >= dailyCap) {
				return { allowed: false, host, reason: `daily cap of ${dailyCap} requests reached for ${host}` };
			}

			bucket.spent += 1;
			if (bucket.tokens >= 1) {
				bucket.tokens -= 1;
				return { allowed: true, host, delayMs: 0 };
			}

			const needed = 1 - bucket.tokens;
			const delayMs = Math.ceil((needed / rate) * 1000);
			bucket.tokens = 0;
			bucket.last = Math.max(bucket.last, now + delayMs);
			return { allowed: true, host, delayMs };
		},

		stats(host: string): LimiterStats {
			const bucket = buckets.get(host);
			if (!bucket) return { spent: 0, tokens: capacityFor(rateFor(host)) };
			return { spent: bucket.spent, tokens: Math.max(0, bucket.tokens) };
		},
	};
}
