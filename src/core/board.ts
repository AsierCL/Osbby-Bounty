/**
 * S3/S5: the shared board is how several agents of the same program stop working blind.
 *
 * Two decisions shape it and neither is interchangeable with the design it replaces:
 *
 * 1. **Filesystem, not a broker.** Swarm children are separate `pi` processes spawned by
 *    `src/pi/runner.ts`; there is no live channel between them and no process to host a pub/sub
 *    server. The coordination substrate is therefore the same one `shared-ratelimit.ts` and
 *    `evidence.ts` already use: a file, a lock, and a stale-lock recovery. No Redis.
 * 2. **Pull, not push.** A child reads `since(cursor)` at a tool-call boundary. There is nothing to
 *    subscribe to, and pretending otherwise would be a callback that never fires.
 *
 * The board is deliberately NOT the evidence chain (`evidence.ts`). Evidence is proof of what the
 * tool observed; the board is where the swarm says "I found this, I am working on it". Proof never
 * depends on the board, and the board may be pruned or rebuilt without touching a finding.
 */
import { open, readFile, rename, stat, unlink, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./evidence.ts";

const LOG_FILE = "board.jsonl";
const CLAIMS_FILE = "claims.json";
const LOCK_FILE = ".board.lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;

/** A lease long enough for a serious attempt on one item, short enough to unblock the swarm. */
export const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;

export interface BoardEntry {
	/** Monotonic within the program, starting at 1. */
	seq: number;
	at: string;
	/** "host" | "endpoint" | "param" | "hypothesis" | "finding" | "note" … open by design. */
	kind: string;
	target: string;
	data: Record<string, unknown>;
	/** Session or role id. Never empty: a discovery with no author cannot be challenged. */
	by: string;
	fingerprint: string;
}

export interface BoardClaim {
	by: string;
	at: string;
	until: string;
}

export interface PublishInput {
	kind: string;
	target: string;
	data?: Record<string, unknown>;
	by: string;
}

export type PublishResult =
	| { created: true; entry: BoardEntry }
	/** Already known. `by` is the author of the original discovery, not the caller. */
	| { created: false; entry: BoardEntry; claimedBy: string | null };

export interface ClaimOptions {
	by: string;
	ttlMs?: number;
}

export type ClaimResult =
	| { ok: true; entry: BoardEntry; claim: BoardClaim }
	| { ok: false; reason: "not-found" | "claimed"; claimedBy?: string };

export type ReleaseResult = { released: true } | { released: false; reason: "not-found" | "not-claimed" | "not-claimant" };

export interface BoardQuery {
	kind?: string;
	target?: string;
}

export interface BoardState {
	count: number;
	headSeq: number;
}

export interface Board {
	publish(input: PublishInput): Promise<PublishResult>;
	claim(seq: number, options: ClaimOptions): Promise<ClaimResult>;
	release(seq: number, by: string): Promise<ReleaseResult>;
	since(seq: number): Promise<BoardEntry[]>;
	query(filter?: BoardQuery): Promise<BoardEntry[]>;
	claims(): Promise<Record<string, BoardClaim>>;
	state(): Promise<BoardState>;
}

function sleep(ms: number): Promise<void> {
	// Not unref'd: a store waiting on the lock must keep the process alive, or a contended publish
	// looks like a hung promise.
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function required(value: string, field: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`board: "${field}" is required`);
	return trimmed;
}

/** `kind|target|data` under canonical JSON: the same discovery from two agents is one entry. */
export function fingerprintOf(kind: string, target: string, data: Record<string, unknown>): string {
	return sha256([kind, target, canonicalJson(data)].join("\n")).slice(0, 32);
}

export function createBoard(options: { dir: string; now?: () => number }): Board {
	const now = options.now ?? (() => Date.now());
	const logPath = join(options.dir, LOG_FILE);
	const claimsPath = join(options.dir, CLAIMS_FILE);
	const lockPath = join(options.dir, LOCK_FILE);

	async function acquireLock(): Promise<void> {
		await mkdir(options.dir, { recursive: true });
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				const handle = await open(lockPath, "wx");
				await handle.close();
				return;
			} catch (error) {
				if ((error as { code?: string }).code !== "EEXIST") throw error;
				try {
					const info = await stat(lockPath);
					if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
						await unlink(lockPath);
						continue;
					}
				} catch {
					continue;
				}
				if (Date.now() > deadline) throw new Error(`board lock is held: ${lockPath}`);
				await sleep(LOCK_RETRY_MS);
			}
		}
	}

	async function releaseLock(): Promise<void> {
		try {
			await unlink(lockPath);
		} catch {
			// Releasing an already-removed lock is not an error.
		}
	}

	async function withLock<T>(run: () => Promise<T>): Promise<T> {
		await acquireLock();
		try {
			return await run();
		} finally {
			await releaseLock();
		}
	}

	/**
	 * The log is the authority. A malformed line is an error, never a line to skip: skipping it would
	 * silently forget a discovery, and forgetting a discovery is duplicate work later.
	 */
	async function readEntries(): Promise<BoardEntry[]> {
		let text: string;
		try {
			text = await readFile(logPath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
		const entries: BoardEntry[] = [];
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] as string;
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				throw new Error(`board log is corrupt at line ${index + 1}: ${(error as Error).message}`);
			}
			if (typeof parsed !== "object" || parsed === null) throw new Error(`board log is corrupt at line ${index + 1}: not an entry`);
			const record = parsed as Record<string, unknown>;
			if (
				typeof record.seq !== "number" ||
				typeof record.at !== "string" ||
				typeof record.kind !== "string" ||
				typeof record.target !== "string" ||
				typeof record.by !== "string" ||
				typeof record.fingerprint !== "string" ||
				typeof record.data !== "object" ||
				record.data === null ||
				Array.isArray(record.data)
			) {
				throw new Error(`board log is corrupt at line ${index + 1}: incomplete entry`);
			}
			entries.push(record as unknown as BoardEntry);
		}
		return entries;
	}

	async function readClaims(): Promise<Record<string, BoardClaim>> {
		try {
			const parsed = JSON.parse(await readFile(claimsPath, "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const claims: Record<string, BoardClaim> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value !== "object" || value === null) continue;
				const claim = value as Record<string, unknown>;
				if (typeof claim.by !== "string" || typeof claim.at !== "string" || typeof claim.until !== "string") continue;
				claims[key] = { by: claim.by, at: claim.at, until: claim.until };
			}
			return claims;
		} catch {
			// Missing or unreadable claims are recoverable state, not evidence: leases are advisory
			// scheduling, and losing them can only cause repeated work, never lost work.
			return {};
		}
	}

	async function writeClaims(claims: Record<string, BoardClaim>): Promise<void> {
		const temporary = `${claimsPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(claims)}\n`, "utf8");
		await rename(temporary, claimsPath);
	}

	function live(claim: BoardClaim | undefined, at: number): boolean {
		return claim !== undefined && Date.parse(claim.until) > at;
	}

	return {
		async publish(input) {
			const kind = required(input.kind, "kind");
			const target = required(input.target, "target");
			const by = required(input.by, "by");
			const data = input.data ?? {};
			const fingerprint = fingerprintOf(kind, target, data);

			return withLock(async () => {
				const entries = await readEntries();
				const existing = entries.find((entry) => entry.fingerprint === fingerprint);
				if (existing !== undefined) {
					const claims = await readClaims();
					const holder = claims[String(existing.seq)];
					return { created: false as const, entry: existing, claimedBy: live(holder, now()) ? (holder as BoardClaim).by : null };
				}
				const entry: BoardEntry = {
					seq: entries.length + 1,
					at: new Date(now()).toISOString(),
					kind,
					target,
					data,
					by,
					fingerprint,
				};
				await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
				return { created: true as const, entry };
			});
		},

		async claim(seq, claimOptions) {
			const by = required(claimOptions.by, "by");
			const ttlMs = typeof claimOptions.ttlMs === "number" && Number.isFinite(claimOptions.ttlMs) && claimOptions.ttlMs > 0 ? claimOptions.ttlMs : DEFAULT_CLAIM_TTL_MS;

			return withLock(async () => {
				const entries = await readEntries();
				const entry = entries.find((item) => item.seq === seq);
				if (entry === undefined) return { ok: false as const, reason: "not-found" as const };

				const at = now();
				const claims = await readClaims();
				const current = claims[String(seq)];
				if (live(current, at) && current?.by !== by) {
					return { ok: false as const, reason: "claimed" as const, claimedBy: (current as BoardClaim).by };
				}
				const claim: BoardClaim = { by, at: new Date(at).toISOString(), until: new Date(at + ttlMs).toISOString() };
				claims[String(seq)] = claim;
				await writeClaims(claims);
				return { ok: true as const, entry, claim };
			});
		},

		async release(seq, by) {
			const owner = required(by, "by");
			return withLock(async () => {
				const entries = await readEntries();
				if (!entries.some((item) => item.seq === seq)) return { released: false as const, reason: "not-found" as const };
				const claims = await readClaims();
				const current = claims[String(seq)];
				if (current === undefined) return { released: false as const, reason: "not-claimed" as const };
				if (current.by !== owner) return { released: false as const, reason: "not-claimant" as const };
				delete claims[String(seq)];
				await writeClaims(claims);
				return { released: true as const };
			});
		},

		async since(seq) {
			return withLock(async () => (await readEntries()).filter((entry) => entry.seq > seq).sort((left, right) => left.seq - right.seq));
		},

		async query(filter = {}) {
			return withLock(async () => {
				const entries = await readEntries();
				return entries.filter(
					(entry) => (filter.kind === undefined || entry.kind === filter.kind) && (filter.target === undefined || entry.target === filter.target),
				);
			});
		},

		async claims() {
			return withLock(() => readClaims());
		},

		async state() {
			return withLock(async () => {
				const entries = await readEntries();
				return { count: entries.length, headSeq: entries.reduce((max, entry) => Math.max(max, entry.seq), 0) };
			});
		},
	};
}
