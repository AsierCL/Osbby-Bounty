/**
 * S89: the program's rate is a property of the PROGRAM, not of the process.
 *
 * Two sessions on the same program each kept their own in-memory bucket, so the aggregate was double
 * the declared rate (proven: rate_rps 5, eight executions in one second with two workers). This limiter
 * persists the buckets next to the program's workspace and serializes updates with a lock, so every
 * session of the same program shares one budget.
 */
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { capacityFor, rateFor, reserveInBucket, type LimiterBucket, type LimiterPolicy, type Reservation } from "./ratelimit.ts";

const TIMEOUT_MS = 5_000;
const STALE_MS = 10_000;
const RETRY_MS = 5;

export interface SharedLimiter {
	reserve(host: string): Promise<Reservation>;
	stats(host: string): Promise<{ spent: number; tokens: number }>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSharedRateLimiter(options: { dir: string; policy: LimiterPolicy; clock?: () => number }): SharedLimiter {
	const clock = options.clock ?? (() => Date.now());
	const statePath = join(options.dir, ".rate-limit.json");
	const lockPath = join(options.dir, ".rate-limit.lock");

	async function withLock<T>(run: () => Promise<T>): Promise<T> {
		const deadline = Date.now() + TIMEOUT_MS;
		while (true) {
			try {
				const handle = await open(lockPath, "wx");
				try {
					return await run();
				} finally {
					await handle.close();
					await unlink(lockPath).catch(() => undefined);
				}
			} catch (error) {
				if ((error as { code?: string }).code !== "EEXIST") throw error;
				const info = await stat(lockPath).catch(() => null);
				if (info !== null && Date.now() - info.mtimeMs > STALE_MS) {
					await unlink(lockPath).catch(() => undefined);
					continue;
				}
				if (Date.now() > deadline) throw new Error(`rate limiter lock timeout for ${statePath}`);
				await sleep(RETRY_MS);
			}
		}
	}

	async function readState(): Promise<Record<string, LimiterBucket>> {
		try {
			return JSON.parse(await readFile(statePath, "utf8")) as Record<string, LimiterBucket>;
		} catch {
			return {};
		}
	}

	async function writeState(state: Record<string, LimiterBucket>): Promise<void> {
		const temporary = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, JSON.stringify(state), "utf8");
		await rename(temporary, statePath);
	}

	return {
		async reserve(host: string): Promise<Reservation> {
			return withLock(async () => {
				const state = await readState();
				const rate = rateFor(options.policy, host);
				const capacity = capacityFor(options.policy, rate);
				const now = clock();
				const bucket: LimiterBucket = state[host] ?? { tokens: capacity, last: now, spent: 0 };
				const reservation = reserveInBucket(bucket, rate, capacity, options.policy.dailyCap ?? null, host, now);
				state[host] = bucket;
				await writeState(state);
				return reservation;
			});
		},

		async stats(host: string) {
			const state = await readState();
			const bucket = state[host];
			if (bucket === undefined) return { spent: 0, tokens: capacityFor(options.policy, rateFor(options.policy, host)) };
			return { spent: bucket.spent, tokens: Math.max(0, bucket.tokens) };
		},
	};
}
