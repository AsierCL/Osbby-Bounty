/**
 * S1-S3: the shared blackboard is how several agents of the same program stop working blind.
 *
 * It copies the cross-process pattern that already works in this repo (`shared-ratelimit.ts`): one
 * JSON file, one lockfile created with `open(lockPath, "wx")`, a stale window, and writes that go to
 * a temporary file and are renamed into place. There is no broker: swarm children are separate `pi`
 * processes with no live channel, so the substrate has to be the filesystem.
 *
 * The store is canonical: there is exactly one blackboard per program. It is NOT the evidence chain —
 * evidence proves what a tool observed; the blackboard says what the swarm knows. Proof never depends
 * on it.
 */
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./evidence.ts";

export const BLACKBOARD_FILE = "blackboard.json";
export const BLACKBOARD_LOCK_FILE = ".blackboard.lock";
const TIMEOUT_MS = 5_000;
const STALE_MS = 10_000;
const RETRY_MS = 5;

export type BlackboardCategory =
	| "endpoint"
	| "hidden_param"
	| "auth_schema"
	| "header_anomaly"
	| "tech_fingerprint"
	| "state_invariant";

export const BLACKBOARD_CATEGORIES: BlackboardCategory[] = [
	"endpoint",
	"hidden_param",
	"auth_schema",
	"header_anomaly",
	"tech_fingerprint",
	"state_invariant",
];

export interface BlackboardArtifact {
	/** First 16 hex characters of the deterministic fingerprint. */
	id: string;
	category: BlackboardCategory;
	target: string;
	data: Record<string, unknown>;
	/** sessionId or agent role. Never empty: a discovery with no author cannot be challenged. */
	discoveredBy: string;
	ts: string;
}

export interface PublishInput {
	category: BlackboardCategory;
	target: string;
	data?: Record<string, unknown>;
	discoveredBy: string;
}

export type PublishResult = { created: true; artifact: BlackboardArtifact } | { created: false; artifact: BlackboardArtifact };

export interface QueryFilter {
	category?: BlackboardCategory;
	target?: string;
	limit?: number;
}

/** D2: leases are additive to the requested contract; the swarm uses them to avoid duplicated work. */
export interface BlackboardClaim {
	discoveredBy: string;
	at: string;
	until: string;
}

export type ClaimResult = { ok: true; artifact: BlackboardArtifact; claim: BlackboardClaim } | { ok: false; reason: "not-found" | "claimed"; claimedBy?: string };

export type ReleaseResult = { released: true } | { released: false; reason: "not-found" | "not-claimed" | "not-claimant" };

export interface BlackboardState {
	program: string | null;
	count: number;
}

export interface SharedBlackboard {
	/** S3. Idempotent by fingerprint; the same artifact twice is one artifact. */
	publish(input: PublishInput): Promise<PublishResult>;
	/** S3. Filtered, ordered by ts ascending. */
	query(filter?: QueryFilter): Promise<BlackboardArtifact[]>;
	/** Additive (D2): everything, for the fan-in. */
	artifacts(): Promise<BlackboardArtifact[]>;
	since(ts: string): Promise<BlackboardArtifact[]>;
	claim(id: string, options: { discoveredBy: string; ttlMs?: number }): Promise<ClaimResult>;
	release(id: string, discoveredBy: string): Promise<ReleaseResult>;
	claims(): Promise<Record<string, BlackboardClaim>>;
	state(): Promise<BlackboardState>;
	file(): string;
}

export const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;

interface StoredBlackboard {
	program: string | null;
	artifacts: BlackboardArtifact[];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function required(value: string | undefined, field: string): string {
	const trimmed = (value ?? "").trim();
	if (trimmed.length === 0) throw new Error(`blackboard: "${field}" is required`);
	return trimmed;
}

export function isCategory(value: unknown): value is BlackboardCategory {
	return typeof value === "string" && (BLACKBOARD_CATEGORIES as string[]).includes(value);
}

/** S2: sha256(category|target|canonicalJson(data)), first 16 hex characters. */
export function artifactId(category: string, target: string, data: Record<string, unknown>): string {
	return sha256([category, target, canonicalJson(data)].join("|")).slice(0, 16);
}

function emptyState(program: string | null): StoredBlackboard {
	return { program, artifacts: [] };
}

export function createSharedBlackboard(options: { dir: string; program?: string; clock?: () => number }): SharedBlackboard {
	const clock = options.clock ?? (() => Date.now());
	const statePath = join(options.dir, BLACKBOARD_FILE);
	const lockPath = join(options.dir, BLACKBOARD_LOCK_FILE);
	const claimsPath = join(options.dir, ".blackboard.claims.json");
	const expectedProgram = options.program?.trim() || null;

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
				// A crashed writer must not wedge the blackboard: after the stale window the lock is ours.
				if (info !== null && Date.now() - info.mtimeMs > STALE_MS) {
					await unlink(lockPath).catch(() => undefined);
					continue;
				}
				if (Date.now() > deadline) throw new Error(`blackboard lock is held: ${lockPath}`);
				await sleep(RETRY_MS);
			}
		}
	}

	/** D3: the program is part of the stored state, so a file cannot be read by another program. */
	function checkProgram(stored: StoredBlackboard): void {
		if (expectedProgram === null) return;
		if (stored.program === null) {
			stored.program = expectedProgram;
			return;
		}
		if (stored.program !== expectedProgram) {
			throw new Error(`blackboard de "${stored.program}": esta sesión es "${expectedProgram}" y no toca otra pizarra`);
		}
	}

	async function readState(): Promise<StoredBlackboard> {
		let text: string;
		try {
			text = await readFile(statePath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return emptyState(expectedProgram);
			throw error;
		}
		if (text.trim().length === 0) return emptyState(expectedProgram);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			// A corrupt blackboard is an error, not an empty board: forgetting artifacts is duplicated work.
			throw new Error(`blackboard is corrupt (${statePath}): ${(error as Error).message}`);
		}
		if (typeof parsed !== "object" || parsed === null) throw new Error(`blackboard is corrupt (${statePath}): not an object`);
		const record = parsed as Record<string, unknown>;
		const program = typeof record.program === "string" ? record.program : null;
		const artifacts = Array.isArray(record.artifacts) ? (record.artifacts as BlackboardArtifact[]) : [];
		const stored: StoredBlackboard = { program, artifacts };
		checkProgram(stored);
		return stored;
	}

	async function writeState(state: StoredBlackboard): Promise<void> {
		const temporary = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, 1)}\n`, "utf8");
		await rename(temporary, statePath);
	}

	async function readClaims(): Promise<Record<string, BlackboardClaim>> {
		try {
			const parsed = JSON.parse(await readFile(claimsPath, "utf8")) as unknown;
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, BlackboardClaim>) : {};
		} catch {
			// Leases are scheduling, not proof: losing them can only repeat work, never lose it.
			return {};
		}
	}

	async function writeClaims(claims: Record<string, BlackboardClaim>): Promise<void> {
		const temporary = `${claimsPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(claims)}\n`, "utf8");
		await rename(temporary, claimsPath);
	}

	function live(claim: BlackboardClaim | undefined, at: number): boolean {
		return claim !== undefined && Date.parse(claim.until) > at;
	}

	return {
		file: () => statePath,

		async publish(input) {
			const category = input.category;
			if (!isCategory(category)) throw new Error(`blackboard: invalid category "${String(category)}"`);
			const target = required(input.target, "target");
			const discoveredBy = required(input.discoveredBy, "discoveredBy");
			const data = input.data ?? {};
			const id = artifactId(category, target, data);

			return withLock(async () => {
				const state = await readState();
				const existing = state.artifacts.find((artifact) => artifact.id === id);
				if (existing !== undefined) return { created: false as const, artifact: existing };
				const artifact: BlackboardArtifact = { id, category, target, data, discoveredBy, ts: new Date(clock()).toISOString() };
				state.artifacts.push(artifact);
				await writeState(state);
				return { created: true as const, artifact };
			});
		},

		async query(filter = {}) {
			return withLock(async () => {
				const state = await readState();
				const filtered = state.artifacts
					.filter((artifact) => (filter.category === undefined || artifact.category === filter.category) && (filter.target === undefined || artifact.target === filter.target))
					.sort((left, right) => (left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0));
				return filter.limit === undefined || filter.limit <= 0 ? filtered : filtered.slice(0, filter.limit);
			});
		},

		async artifacts() {
			return this.query();
		},

		async since(ts) {
			return withLock(async () => (await readState()).artifacts.filter((artifact) => artifact.ts > ts));
		},

		async claim(id, claimOptions) {
			const discoveredBy = required(claimOptions.discoveredBy, "discoveredBy");
			const ttlMs = typeof claimOptions.ttlMs === "number" && Number.isFinite(claimOptions.ttlMs) && claimOptions.ttlMs > 0 ? claimOptions.ttlMs : DEFAULT_CLAIM_TTL_MS;
			return withLock(async () => {
				const state = await readState();
				const artifact = state.artifacts.find((item) => item.id === id);
				if (artifact === undefined) return { ok: false as const, reason: "not-found" as const };
				const at = clock();
				const claims = await readClaims();
				const current = claims[id];
				if (live(current, at) && current?.discoveredBy !== discoveredBy) return { ok: false as const, reason: "claimed" as const, claimedBy: current?.discoveredBy };
				const claim: BlackboardClaim = { discoveredBy, at: new Date(at).toISOString(), until: new Date(at + ttlMs).toISOString() };
				claims[id] = claim;
				await writeClaims(claims);
				return { ok: true as const, artifact, claim };
			});
		},

		async release(id, discoveredBy) {
			const owner = required(discoveredBy, "discoveredBy");
			return withLock(async () => {
				const state = await readState();
				if (!state.artifacts.some((artifact) => artifact.id === id)) return { released: false as const, reason: "not-found" as const };
				const claims = await readClaims();
				const current = claims[id];
				if (current === undefined) return { released: false as const, reason: "not-claimed" as const };
				if (current.discoveredBy !== owner) return { released: false as const, reason: "not-claimant" as const };
				delete claims[id];
				await writeClaims(claims);
				return { released: true as const };
			});
		},

		async claims() {
			return withLock(() => readClaims());
		},

		async state() {
			return withLock(async () => {
				const state = await readState();
				return { program: state.program, count: state.artifacts.length };
			});
		},
	};
}
