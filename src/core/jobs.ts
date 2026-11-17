/**
 * S108/T6: recon blocks the session until subfinder and httpx finish, which on a real program is
 * minutes of a tool call that could be a background job.
 *
 * The job is a file on disk, not a promise in memory: the child is a separate process, the session
 * may end, and the human may come back later. A job record is the only thing both sides share, so it
 * is written atomically and its states are a closed set.
 *
 * A job is scheduling, never authorization: it does not grant scope, rate or a destructive class. The
 * child still goes through the gate like any other session.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JobState = "queued" | "running" | "done" | "failed" | "stopped";

export const JOB_STATES: JobState[] = ["queued", "running", "done", "failed", "stopped"];

export interface JobRecord {
	/** `J-<yyyyMMddHHmmss>-<6 hex>`. Unique without a counter, safe with parallel creation. */
	id: string;
	kind: "recon";
	program: string;
	state: JobState;
	/** What the job was asked to look at, e.g. the domain. */
	subject: string;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	pid: number | null;
	/** One line for status.md: what it found or why it stopped. */
	summary: string;
	error: string | null;
	artifacts: string[];
}

export interface CreateJobInput {
	kind: JobRecord["kind"];
	program: string;
	subject: string;
}

export interface JobStore {
	create(input: CreateJobInput): Promise<JobRecord>;
	update(id: string, patch: Partial<Omit<JobRecord, "id" | "createdAt">>): Promise<JobRecord>;
	read(id: string): Promise<JobRecord | null>;
	list(): Promise<JobRecord[]>;
	/** The most recent job, which is what a session resuming a program wants. */
	latest(): Promise<JobRecord | null>;
	dir(): string;
}

const STALE_RUNNING_MS = 30 * 60 * 1000;

function isState(value: unknown): value is JobState {
	return typeof value === "string" && (JOB_STATES as string[]).includes(value);
}

export function newJobId(now: number, random: () => number = Math.random): string {
	const date = new Date(now);
	const pad = (value: number, size = 2) => String(value).padStart(size, "0");
	const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
	const suffix = Math.floor(random() * 0xffffff)
		.toString(16)
		.padStart(6, "0");
	return `J-${stamp}-${suffix}`;
}

export function createJobStore(options: { workspace: string; now?: () => number }): JobStore {
	const now = options.now ?? (() => Date.now());
	const directory = join(options.workspace, "jobs");

	async function write(record: JobRecord): Promise<void> {
		await mkdir(directory, { recursive: true });
		const target = join(directory, `${record.id}.json`);
		const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		await rename(temporary, target);
	}

	async function read(id: string): Promise<JobRecord | null> {
		if (!/^J-[0-9]{14}-[0-9a-f]{6}$/.test(id)) return null;
		try {
			const parsed = JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null) return null;
			const record = parsed as Record<string, unknown>;
			if (typeof record.id !== "string" || !isState(record.state) || typeof record.program !== "string") return null;
			return parsed as JobRecord;
		} catch {
			return null;
		}
	}

	return {
		dir: () => directory,

		async create(input) {
			const at = new Date(now()).toISOString();
			const record: JobRecord = {
				id: newJobId(now()),
				kind: input.kind,
				program: input.program,
				state: "queued",
				subject: input.subject,
				createdAt: at,
				updatedAt: at,
				startedAt: null,
				finishedAt: null,
				pid: null,
				summary: "en cola",
				error: null,
				artifacts: [],
			};
			await write(record);
			return record;
		},

		async update(id, patch) {
			const current = await read(id);
			if (current === null) throw new Error(`job ${id} does not exist`);
			if (patch.state !== undefined && !isState(patch.state)) throw new Error(`invalid job state: ${String(patch.state)}`);
			const next: JobRecord = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date(now()).toISOString() };
			await write(next);
			return next;
		},

		read,

		async list() {
			let files: string[];
			try {
				files = await readdir(directory);
			} catch {
				return [];
			}
			const records: JobRecord[] = [];
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const record = await read(file.slice(0, -".json".length));
				if (record !== null) records.push(record);
			}
			return records.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
		},

		async latest() {
			const [first] = await this.list();
			return first ?? null;
		},
	};
}

/**
 * A job left `running` by a killed process would block the operator forever. After a generous window
 * it is reported as failed, with the reason written where the human will read it.
 */
export function reconcileStaleJobs(jobs: JobRecord[], at: number): JobRecord[] {
	return jobs.map((job) => {
		if (job.state !== "running" || job.startedAt === null) return job;
		const started = Date.parse(job.startedAt);
		if (!Number.isFinite(started) || at - started <= STALE_RUNNING_MS) return job;
		return {
			...job,
			state: "failed" as const,
			finishedAt: new Date(at).toISOString(),
			updatedAt: new Date(at).toISOString(),
			summary: "el proceso del job desapareció sin terminar",
			error: `sin señal desde ${new Date(started).toISOString()}`,
		};
	});
}

export function renderJob(job: JobRecord): string {
	const when = job.finishedAt ?? job.updatedAt;
	const pid = job.pid === null ? "" : ` · pid ${job.pid}`;
	return `${job.id} · ${job.kind} ${job.subject} · ${job.state}${pid} · ${when}\n  ${job.summary}${job.error === null ? "" : `\n  error: ${job.error}`}`;
}
