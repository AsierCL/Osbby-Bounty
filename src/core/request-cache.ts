/**
 * S6-S8: when five agents start against the same bundle, the target must see one request, not five,
 * and the program's rate budget must be spent once.
 *
 * Two mechanisms, both needed:
 *
 * - **In-flight coalescing** lives in memory: a promise keyed by signature. A second caller in the same
 *   process waits on it instead of launching a second subprocess.
 * - **TTL cache** lives on disk (`work/<program>/.http-cache.json`) so a later call in another process
 *   of the same program can reuse a fresh answer. Writes are atomic and serialized with a lockfile,
 *   the same pattern the blackboard and the rate limiter already use.
 *
 * What is cacheable is deliberately narrow: idempotent reads only, successful or meaningful responses
 * only, and never when the caller asks for real traffic (`bypassCache`). The verifier is the loudest
 * case: its two reproductions must hit the target.
 */
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "./evidence.ts";

export const CACHE_FILE = ".http-cache.json";
export const CACHE_LOCK_FILE = ".http-cache.lock";
const TIMEOUT_MS = 5_000;
const STALE_MS = 10_000;
const RETRY_MS = 5;
const MAX_STORED_STDOUT = 64 * 1024;

export const DEFAULT_TTL_MS = 60_000;
const IDEMPOTENT_READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Statuses worth remembering: success, redirect, and "it answered but refused". 5xx never is. */
const CACHEABLE_STATUSES = new Set([200, 201, 202, 204, 301, 302, 303, 304, 307, 308, 401, 403]);

export interface RequestCacheEntry {
	signature: string;
	method: string;
	url: string;
	/** HTTP status when the response had one; `null` when it did not. */
	status: number | null;
	stdout: string;
	stderr: string;
	at: string;
}

export interface RequestCacheOptions {
	/** `work/<program>`. */
	dir: string;
	program: string;
	ttlMs?: number;
	clock?: () => number;
}

export interface RequestCache {
	/** S6: what identifies "the same request". */
	signature(method: string, url: string, authContext: string): string;
	/** S7: a fresh entry, or null. Never touches the network. */
	lookup(signature: string): Promise<RequestCacheEntry | null>;
	/** S7: the promise of an execution already in flight in this process, if any. */
	inFlight(signature: string): Promise<RequestCacheEntry> | undefined;
	/** Registers this caller as the one executing; resolves the in-flight promise for the others. */
	track(signature: string): { finish(entry: RequestCacheEntry): Promise<void>; fail(error: Error): void };
	/** Storage decision shared by every caller. */
	isCacheable(method: string, status: number | null): boolean;
	file(): string;
}

export function isIdempotentRead(method: string): boolean {
	return IDEMPOTENT_READS.has(method.trim().toUpperCase());
}

/** `-X PUT`, `--request=PUT`; anything else is a GET in curl's world. */
export function methodFromArgs(args: string[]): string {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		if (token === "-X" || token === "--request") {
			const value = args[index + 1];
			if (value !== undefined && value.trim().length > 0) return value.trim().toUpperCase();
		}
		if (token.startsWith("--request=")) return token.slice("--request=".length).trim().toUpperCase();
		if (token.startsWith("-X") && token.length > 2) return token.slice(2).trim().toUpperCase();
	}
	return "GET";
}

/** S6: SHA256(method|normalizedUrl|authContext). The auth context keeps roles from sharing answers. */
export function requestSignature(method: string, url: string, authContext: string): string {
	const normalizedUrl = (() => {
		try {
			const parsed = new URL(url);
			parsed.hash = "";
			return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
		} catch {
			return url.trim();
		}
	})();
	return sha256([method.trim().toUpperCase(), normalizedUrl, authContext.trim()].join("|"));
}

/** The HTTP status a tool printed, when it printed one. No status is not a status. */
export function statusOf(stdout: string): number | null {
	const match = /(?:^|\s)(\d{3})\s/.exec(`${stdout} `);
	if (match?.[1] !== undefined) {
		const value = Number.parseInt(match[1], 10);
		if (value >= 100 && value <= 599) return value;
	}
	const trailing = /(\d{3})\s*$/.exec(stdout.trim());
	if (trailing?.[1] !== undefined) {
		const value = Number.parseInt(trailing[1], 10);
		if (value >= 100 && value <= 599) return value;
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StoredCache {
	program: string;
	entries: Record<string, RequestCacheEntry>;
}

export function createRequestCache(options: RequestCacheOptions): RequestCache {
	const clock = options.clock ?? (() => Date.now());
	const ttlMs = typeof options.ttlMs === "number" && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
	const statePath = join(options.dir, CACHE_FILE);
	const lockPath = join(options.dir, CACHE_LOCK_FILE);
	const inFlight = new Map<string, { promise: Promise<RequestCacheEntry>; resolve: (entry: RequestCacheEntry) => void; reject: (error: Error) => void }>();

	async function withLock<T>(run: () => Promise<T>): Promise<T> {
		await mkdir(options.dir, { recursive: true });
		const deadline = Date.now() + TIMEOUT_MS;
		for (;;) {
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
				if (Date.now() > deadline) throw new Error(`http cache lock is held: ${lockPath}`);
				await sleep(RETRY_MS);
			}
		}
	}

	async function readState(): Promise<StoredCache> {
		try {
			const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null) return { program: options.program, entries: {} };
			const record = parsed as Record<string, unknown>;
			const entries = typeof record.entries === "object" && record.entries !== null ? (record.entries as Record<string, RequestCacheEntry>) : {};
			return { program: typeof record.program === "string" ? record.program : options.program, entries };
		} catch {
			// A cache is not evidence: a corrupt one is discarded, and the worst case is one more request.
			return { program: options.program, entries: {} };
		}
	}

	async function writeState(state: StoredCache): Promise<void> {
		const temporary = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
		await rename(temporary, statePath);
	}

	return {
		file: () => statePath,

		signature: requestSignature,

		isCacheable(method, status) {
			if (!isIdempotentRead(method)) return false;
			return status === null || CACHEABLE_STATUSES.has(status);
		},

		async lookup(signature) {
			return withLock(async () => {
				const state = await readState();
				const entry = state.entries[signature];
				if (entry === undefined) return null;
				const age = clock() - Date.parse(entry.at);
				if (!Number.isFinite(age) || age > ttlMs) {
					delete state.entries[signature];
					await writeState(state);
					return null;
				}
				return entry;
			});
		},

		inFlight(signature) {
			return inFlight.get(signature)?.promise;
		},

		track(signature) {
			if (inFlight.has(signature)) throw new Error(`request already in flight: ${signature.slice(0, 8)}`);
			let resolvePromise: (entry: RequestCacheEntry) => void = () => undefined;
			let rejectPromise: (error: Error) => void = () => undefined;
			const promise = new Promise<RequestCacheEntry>((resolve, reject) => {
				resolvePromise = resolve;
				rejectPromise = reject;
			});
			// Waiters must not crash the process with an unhandled rejection.
			promise.catch(() => undefined);
			inFlight.set(signature, { promise, resolve: resolvePromise, reject: rejectPromise });
			return {
				async finish(entry) {
					// Write first, then wake the waiters: a caller that arrives in between must find the
					// entry on disk, not a signature that vanished and is about to be executed again.
					try {
						await withLock(async () => {
							const state = await readState();
							const now = clock();
							for (const [key, stored] of Object.entries(state.entries)) {
								if (now - Date.parse(stored.at) > ttlMs) delete state.entries[key];
							}
							state.entries[signature] = { ...entry, stdout: entry.stdout.slice(0, MAX_STORED_STDOUT) };
							await writeState(state);
						});
					} catch {
						// A failed cache write is not a failed request: the execution already happened.
					}
					inFlight.get(signature)?.resolve(entry);
					inFlight.delete(signature);
				},
				fail(error) {
					inFlight.get(signature)?.reject(error);
					inFlight.delete(signature);
				},
			};
		},
	};
}
