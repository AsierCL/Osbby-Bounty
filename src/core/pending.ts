/**
 * S90: the queue of destructive actions nobody could approve at the time.
 *
 * It is a QUEUE, never an authorization. An item waits here with the agent's reasoning; a read-only
 * annotator adds an opinion; the human resolves each one, one by one, with a real keystroke. Nothing in
 * this module (and nothing in bounty_run) reads an "approved" field: the only path to execution is the
 * human's confirmation at resolution time, followed by the normal gate.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** S94: a flag that can say "I could not verify it, but it is plausible" instead of forcing false. */
export type TriState = "no" | "yes" | "plausible";

export interface PendingItem {
	/** Stable id: P-0001, P-0002 … */
	id: string;
	at: string;
	tool: string;
	argv: string[];
	target: string;
	classes: string[];
	reason: string;
	/** The agent's own reasoning for proposing it. */
	why: string;
	sessionId: string;
	/** Written by the read-only annotator. An opinion, never an approval. */
	annotation?: {
		at: string;
		risk: "low" | "medium" | "high";
		/**
		 * S94: three states instead of a false-by-default boolean. "yes" needs an identified concrete
		 * observation; "plausible" is the honest middle ("no lo pude verificar, pero es posible").
		 */
		touchesThirdPartyData: TriState;
		financialEffect: TriState;
		/** S93: deletion/overwrite with no way back is its own axis, separate from data or money. */
		irreversible: boolean;
		whatCouldHappen: string;
		recommendation: "approve" | "hold" | "discard";
		note: string;
	};
	/** Set by the human resolution in the CLI, with the outcome. Never read as authorization. */
	resolution?: { at: string; outcome: "executed" | "declined" | "discarded"; detail: string };
}

export interface PendingQueue {
	list(): Promise<PendingItem[]>;
	pending(): Promise<PendingItem[]>;
	append(item: Omit<PendingItem, "id" | "at" | "annotation" | "resolution">): Promise<PendingItem>;
	annotate(id: string, annotation: PendingItem["annotation"]): Promise<PendingItem>;
	resolve(id: string, resolution: PendingItem["resolution"]): Promise<PendingItem>;
	file(): string;
}

export function createPendingQueue(options: { dir: string; now?: () => number }): PendingQueue {
	const now = options.now ?? (() => Date.now());
	const path = join(options.dir, "pending-destructive.jsonl");

	async function readAll(): Promise<PendingItem[]> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return [];
		}
		const items: PendingItem[] = [];
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				items.push(JSON.parse(trimmed) as PendingItem);
			} catch {
				// A malformed line is skipped, never invented into an item.
			}
		}
		return items;
	}

	async function rewrite(items: PendingItem[]): Promise<void> {
		await writeFile(path, items.map((item) => JSON.stringify(item)).join("\n") + (items.length === 0 ? "" : "\n"), "utf8");
	}

	return {
		file: () => path,
		list: readAll,
		async pending() {
			return (await readAll()).filter((item) => item.resolution === undefined);
		},
		async append(item) {
			await mkdir(options.dir, { recursive: true });
			const existing = await readAll();
			const next = `P-${String(existing.length + 1).padStart(4, "0")}`;
			const record: PendingItem = { ...item, id: next, at: new Date(now()).toISOString() };
			await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
			return record;
		},
		async annotate(id, annotation) {
			const items = await readAll();
			const index = items.findIndex((item) => item.id === id);
			if (index < 0) throw new Error(`no pending item ${id}`);
			items[index] = { ...(items[index] as PendingItem), annotation };
			await rewrite(items);
			return items[index] as PendingItem;
		},
		async resolve(id, resolution) {
			const items = await readAll();
			const index = items.findIndex((item) => item.id === id);
			if (index < 0) throw new Error(`no pending item ${id}`);
			items[index] = { ...(items[index] as PendingItem), resolution };
			await rewrite(items);
			return items[index] as PendingItem;
		},
	};
}
