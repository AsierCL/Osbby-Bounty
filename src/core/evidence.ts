/**
 * Hash-chained evidence store.
 *
 * Layout of a store directory:
 *   log.jsonl  one record per line, append-only
 *   head.json  { seq, hash } of the last record, written atomically
 *   .lock      exclusive creation marker used to serialize appends
 *
 * The chain is `hash = sha256(prevHash, seq, ts, kind, payloadHash)`. Editing, deleting or reordering
 * any record breaks the recomputation. The separate head pointer exists because a chain alone cannot
 * detect **tail truncation**: lopping off the last records leaves a perfectly valid prefix.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface EvidenceRecord {
	seq: number;
	ts: string;
	kind: string;
	payloadHash: string;
	prevHash: string;
	hash: string;
	payload: unknown;
}

export interface EvidenceHead {
	seq: number;
	hash: string;
}

export type EvidenceVerification =
	| { ok: true; count: number }
	| { ok: false; reason: string; seq?: number };

export interface EvidenceStore {
	append(input: { kind: string; payload: unknown }): Promise<EvidenceRecord>;
	read(): Promise<EvidenceRecord[]>;
	head(): Promise<EvidenceHead | null>;
	verify(): Promise<EvidenceVerification>;
}

const GENESIS = "GENESIS";
const LOG_FILE = "log.jsonl";
const HEAD_FILE = "head.json";
const LOCK_FILE = ".lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable JSON: sorted keys, no whitespace, so a hash survives a re-serialization. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function chainHash(fields: {
	prevHash: string;
	seq: number;
	ts: string;
	kind: string;
	payloadHash: string;
}): string {
	return sha256([fields.prevHash, String(fields.seq), fields.ts, fields.kind, fields.payloadHash].join("\n"));
}

function sleep(ms: number): Promise<void> {
	// Do not unref this timer: a store waiting on the lock must keep the process (and a test runner)
	// alive, otherwise a contended append looks like a hung promise.
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function createEvidenceStore(dir: string, deps: { now?: () => number } = {}): EvidenceStore {
	const now = deps.now ?? (() => Date.now());
	const logPath = join(dir, LOG_FILE);
	const headPath = join(dir, HEAD_FILE);
	const lockPath = join(dir, LOCK_FILE);

	async function acquireLock(): Promise<void> {
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				const handle = await open(lockPath, "wx");
				await handle.close();
				return;
			} catch (error) {
				if ((error as { code?: string }).code !== "EEXIST") throw error;
				// A crashed append must not wedge the store forever.
				try {
					const info = await stat(lockPath);
					if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
						await unlink(lockPath);
						continue;
					}
				} catch {
					continue;
				}
				if (Date.now() > deadline) throw new Error(`evidence store lock is held: ${lockPath}`);
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

	async function readRaw(): Promise<string> {
		try {
			return await readFile(logPath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return "";
			throw error;
		}
	}

	async function readHeadFile(): Promise<EvidenceHead | null> {
		try {
			const parsed = JSON.parse(await readFile(headPath, "utf8")) as EvidenceHead;
			if (typeof parsed.seq !== "number" || typeof parsed.hash !== "string") return null;
			return parsed;
		} catch {
			return null;
		}
	}

	async function writeHead(head: EvidenceHead): Promise<void> {
		const temporary = `${headPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(head)}\n`, "utf8");
		await rename(temporary, headPath);
	}

	const store: EvidenceStore = {
		async append({ kind, payload }) {
			await mkdir(dir, { recursive: true });
			await acquireLock();
			try {
				const text = await readRaw();
				const lines = text.split("\n").filter((line) => line.length > 0);
				const last = lines.length > 0 ? (JSON.parse(lines[lines.length - 1] as string) as EvidenceRecord) : null;
				const head = await readHeadFile();

				// The log is the authority for the chain. A head that disagrees with it means the store
				// was tampered with: refuse to extend it and say why.
				if (head !== null && (last === null ? head.seq !== 0 : head.seq !== last.seq || head.hash !== last.hash)) {
					throw new Error(
						`evidence store is inconsistent: head points at seq ${head.seq} but the log ends at seq ${last?.seq ?? 0}; run verify()`,
					);
				}

				const seq = (last?.seq ?? 0) + 1;
				const prevHash = last?.hash ?? GENESIS;
				const ts = new Date(now()).toISOString();
				const payloadHash = sha256(canonicalJson(payload));
				const hash = chainHash({ prevHash, seq, ts, kind, payloadHash });
				const record: EvidenceRecord = { seq, ts, kind, payloadHash, prevHash, hash, payload };
				await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
				await writeHead({ seq, hash });
				return record;
			} finally {
				await releaseLock();
			}
		},

		async read() {
			const text = await readRaw();
			return text
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as EvidenceRecord);
		},

		head: readHeadFile,

		async verify() {
			const text = await readRaw();
			const lines = text.split("\n").filter((line) => line.length > 0);
			let prevHash = GENESIS;
			let last: EvidenceRecord | null = null;

			for (let index = 0; index < lines.length; index += 1) {
				let record: EvidenceRecord;
				try {
					record = JSON.parse(lines[index] as string) as EvidenceRecord;
				} catch {
					return { ok: false, reason: `unparseable record at seq ${index + 1}`, seq: index + 1 };
				}
				if (record.seq !== index + 1) {
					return { ok: false, reason: `sequence gap: expected seq ${index + 1}, found ${record.seq}`, seq: index + 1 };
				}
				if (record.prevHash !== prevHash) {
					return { ok: false, reason: `broken chain at seq ${record.seq}: prev hash does not match`, seq: record.seq };
				}
				const expectedPayloadHash = sha256(canonicalJson(record.payload));
				if (record.payloadHash !== expectedPayloadHash) {
					return { ok: false, reason: `payload hash mismatch at seq ${record.seq}`, seq: record.seq };
				}
				const expectedHash = chainHash({
					prevHash: record.prevHash,
					seq: record.seq,
					ts: record.ts,
					kind: record.kind,
					payloadHash: record.payloadHash,
				});
				if (record.hash !== expectedHash) {
					return { ok: false, reason: `hash mismatch at seq ${record.seq}`, seq: record.seq };
				}
				prevHash = record.hash;
				last = record;
			}

			const head = await readHeadFile();
			if (last === null) {
				if (head !== null && head.seq !== 0) {
					return { ok: false, reason: `log is empty but head points at seq ${head.seq}` };
				}
				return { ok: true, count: 0 };
			}
			if (head === null) {
				return { ok: false, reason: "missing head pointer: the log cannot prove its own length" };
			}
			if (head.seq !== last.seq || head.hash !== last.hash) {
				return {
					ok: false,
					reason: `truncated tail: head points at seq ${head.seq} but the log ends at seq ${last.seq}`,
					seq: last.seq,
				};
			}
			return { ok: true, count: lines.length };
		},
	};

	return store;
}
