/**
 * Finding lifecycle: `candidate → verified → reported | duplicate | rejected`.
 *
 * The state machine is enforced, not advisory: a finding cannot jump from `candidate` to `reported`
 * without a verification step, because that is the difference between a hunch and a report. Dedupe is
 * a fingerprint over class + endpoint + parameter, so the same weakness found twice does not become
 * two reports.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export type FindingState = "candidate" | "verified" | "disputed" | "reported" | "duplicate" | "rejected";

export type Confidence = "low" | "medium" | "high";

export interface FindingTransition {
	at: string;
	from: FindingState | null;
	to: FindingState;
	reason: string;
}

export interface Finding {
	id: string;
	program: string;
	title: string;
	state: FindingState;
	class: string;
	endpoint: string;
	parameter: string | null;
	confidence: Confidence;
	cvss: string | null;
	score: number | null;
	/** A secret belonging to a third party, found during recon (S26). */
	sensitive: boolean;
	notes: string[];
	fingerprint: string;
	transitions: FindingTransition[];
	createdAt: string;
	updatedAt: string;
}

const ALLOWED: Record<FindingState, FindingState[]> = {
	candidate: ["verified", "rejected"],
	// S76: a valid NO_REPRODUCIDO over a verified finding disputes it; only the operator resolves that.
	verified: ["reported", "duplicate", "rejected", "disputed"],
	disputed: ["verified", "reported", "rejected"],
	reported: [],
	duplicate: [],
	rejected: [],
};

export interface FindingsStore {
	create(input: {
		title: string;
		class: string;
		endpoint: string;
		parameter?: string | null;
		confidence?: Confidence;
		sensitive?: boolean;
		notes?: string[];
	}): Promise<{ finding: Finding; duplicateOf: string | null }>;
	update(
		id: string,
		patch: {
			state?: FindingState;
			/** S81/task 3: renaming corrects the wording; it is neither evidence nor a state change. */
			title?: string;
			confidence?: Confidence;
			cvss?: string;
			score?: number;
			sensitive?: boolean;
			notes?: string[];
		},
		reason: string,
	): Promise<Finding>;
	get(id: string): Promise<Finding | null>;
	list(): Promise<Finding[]>;
}

export function fingerprint(input: { class: string; endpoint: string; parameter?: string | null }): string {
	const normalized = [input.class.trim().toLowerCase(), input.endpoint.trim().toLowerCase(), (input.parameter ?? "").trim().toLowerCase()].join("|");
	return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	await rename(temporary, path);
}

export function createFindingsStore(options: { dir: string; program: string; now?: () => number }): FindingsStore {
	const now = options.now ?? (() => Date.now());
	const dir = options.dir;

	async function pathFor(id: string): Promise<string> {
		return join(dir, `${id}.json`);
	}

	async function list(): Promise<Finding[]> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
		const findings: Finding[] = [];
		for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
			const finding = await readFile(join(dir, name), "utf8").then((text) => JSON.parse(text) as Finding);
			findings.push(finding);
		}
		return findings;
	}

	async function get(id: string): Promise<Finding | null> {
		try {
			return JSON.parse(await readFile(await pathFor(id), "utf8")) as Finding;
		} catch {
			return null;
		}
	}

	return {
		async create(input) {
			await mkdir(dir, { recursive: true });
			const existing = await list();
			const print = fingerprint(input);
			const duplicate = existing.find((finding) => finding.fingerprint === print);
			if (duplicate) return { finding: duplicate, duplicateOf: duplicate.id };

			const ts = new Date(now()).toISOString();
			const finding: Finding = {
				id: `F-${String(existing.length + 1).padStart(4, "0")}`,
				program: options.program,
				title: input.title,
				state: "candidate",
				class: input.class,
				endpoint: input.endpoint,
				parameter: input.parameter ?? null,
				confidence: input.confidence ?? "medium",
				cvss: null,
				score: null,
				sensitive: input.sensitive ?? false,
				notes: input.notes ?? [],
				fingerprint: print,
				transitions: [{ at: ts, from: null, to: "candidate", reason: "created" }],
				createdAt: ts,
				updatedAt: ts,
			};
			await writeJsonAtomic(await pathFor(finding.id), finding);
			return { finding, duplicateOf: null };
		},

		async update(id, patch, reason) {
			const finding = await get(id);
			if (!finding) throw new Error(`unknown finding ${id}`);
			const ts = new Date(now()).toISOString();
			if (patch.state && patch.state !== finding.state) {
				if (!ALLOWED[finding.state].includes(patch.state)) {
					throw new Error(`invalid transition ${finding.state} → ${patch.state} for ${id} (allowed: ${ALLOWED[finding.state].join(", ") || "none"})`);
				}
				finding.transitions.push({ at: ts, from: finding.state, to: patch.state, reason });
				finding.state = patch.state;
			}
			if (patch.title !== undefined && patch.title.trim().length > 0) finding.title = patch.title.trim();
			if (patch.confidence) finding.confidence = patch.confidence;
			if (patch.cvss !== undefined) finding.cvss = patch.cvss;
			if (patch.score !== undefined) finding.score = patch.score;
			if (patch.sensitive !== undefined) finding.sensitive = patch.sensitive;
			if (patch.notes) finding.notes.push(...patch.notes);
			finding.updatedAt = ts;
			await writeJsonAtomic(await pathFor(id), finding);
			return finding;
		},

		get,
		list,
	};
}
