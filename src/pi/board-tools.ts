/**
 * S3/S5: the model-facing half of the board.
 *
 * Two rules live here and they are the reason this is not just a thin wrapper:
 *
 * 1. **The author is the harness, never the model.** `by` comes from the session id, so a child
 *    cannot publish as somebody else and a discovery is always attributable.
 * 2. **Reads are pruned at the source.** `since`/`query` return the shape of a discovery, not its
 *    payload: the swarm coordinates on fingerprints and targets, and the raw bytes stay in the
 *    evidence chain. A board that returned full HTML would be a context bomb with six readers.
 */
import type { Board, BoardEntry } from "../core/board.ts";

export type BoardAction = "publish" | "claim" | "release" | "since" | "query";

export interface BoardToolInput {
	action: BoardAction;
	kind?: string;
	target?: string;
	data?: Record<string, unknown>;
	seq?: number;
	ttlMs?: number;
	cursor?: number;
}

export interface BoardToolResult {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
}

/** A discovery payload is a hint, not a document. Anything bigger belongs in the evidence store. */
const MAX_DATA_BYTES = 4096;
const MAX_RENDERED_DATA = 240;
const RENDER_LIMIT = 40;

function renderData(data: Record<string, unknown>): string {
	let text: string;
	try {
		text = JSON.stringify(data);
	} catch {
		return "[unserializable]";
	}
	if (text === "{}") return "";
	return text.length <= MAX_RENDERED_DATA ? text : `${text.slice(0, MAX_RENDERED_DATA)}…`;
}

function renderEntry(entry: BoardEntry): string {
	const data = renderData(entry.data);
	return `#${entry.seq} · ${entry.kind} · ${entry.target}${data === "" ? "" : ` · ${data}`} · ${entry.by}`;
}

function renderList(entries: BoardEntry[], empty: string): string {
	if (entries.length === 0) return empty;
	const shown = entries.slice(0, RENDER_LIMIT);
	const hidden = entries.length - shown.length;
	const lines = shown.map(renderEntry);
	if (hidden > 0) lines.push(`… ${hidden} más (consultá con cursor más alto)`);
	return lines.join("\n");
}

function integer(value: unknown, field: string): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`"${field}" must be a positive integer`);
	return parsed;
}

export async function runBoardAction(board: Board, author: string, input: BoardToolInput): Promise<BoardToolResult> {
	const trimmedAuthor = author.trim();
	if (trimmedAuthor.length === 0) return { ok: false, text: "La pizarra necesita un autor y esta sesión no tiene id.", details: {} };

	try {
		if (input.action === "publish") {
			const data = input.data ?? {};
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return { ok: false, text: "data tiene que ser un objeto JSON.", details: {} };
			}
			const size = Buffer.byteLength(JSON.stringify(data), "utf8");
			if (size > MAX_DATA_BYTES) {
				return { ok: false, text: `data ocupa ${size} bytes, el máximo de la pizarra es ${MAX_DATA_BYTES}. El payload crudo va a bounty_evidence, no acá.`, details: {} };
			}
			const result = await board.publish({ kind: String(input.kind ?? ""), target: String(input.target ?? ""), data, by: trimmedAuthor });
			if (result.created) {
				return { ok: true, text: `Publicado ${renderEntry(result.entry)}`, details: { created: true, seq: result.entry.seq, fingerprint: result.entry.fingerprint } };
			}
			const holder = result.claimedBy === null ? "" : ` · en curso por ${result.claimedBy}`;
			return {
				ok: true,
				text: `Ya estaba en la pizarra: ${renderEntry(result.entry)}${holder}. No lo repitas: leelo o reclamalo.`,
				details: { created: false, seq: result.entry.seq, fingerprint: result.entry.fingerprint, claimedBy: result.claimedBy },
			};
		}

		if (input.action === "claim") {
			const seq = integer(input.seq, "seq");
			const result = await board.claim(seq, { by: trimmedAuthor, ...(input.ttlMs === undefined ? {} : { ttlMs: integer(input.ttlMs, "ttl_ms") }) });
			if (result.ok) {
				return { ok: true, text: `Reclamado #${seq} hasta ${result.claim.until}. Publicá lo que descubras con bounty_board publish.`, details: { seq, until: result.claim.until } };
			}
			if (result.reason === "not-found") return { ok: false, text: `No existe el ítem #${seq} en la pizarra.`, details: { seq } };
			return { ok: false, text: `#${seq} está en curso por ${result.claimedBy ?? "otro agente"}. Elegí otro ítem.`, details: { seq, claimedBy: result.claimedBy ?? null } };
		}

		if (input.action === "release") {
			const seq = integer(input.seq, "seq");
			const result = await board.release(seq, trimmedAuthor);
			if (result.released) return { ok: true, text: `Liberado #${seq}.`, details: { seq } };
			const reason = result.reason === "not-found" ? "no existe" : result.reason === "not-claimed" ? "nadie lo tenía" : "lo tiene otro agente";
			return { ok: false, text: `No liberé #${seq}: ${reason}.`, details: { seq, reason: result.reason } };
		}

		if (input.action === "since") {
			const cursor = input.cursor === undefined ? 0 : integer(input.cursor, "cursor");
			const entries = await board.since(cursor);
			const headSeq = entries.length === 0 ? cursor : Math.max(...entries.map((entry) => entry.seq));
			return {
				ok: true,
				text: renderList(entries, "Sin novedades en la pizarra."),
				details: { cursor, headSeq, count: entries.length },
			};
		}

		if (input.action === "query") {
			const entries = await board.query({
				...(input.kind === undefined ? {} : { kind: String(input.kind) }),
				...(input.target === undefined ? {} : { target: String(input.target) }),
			});
			return { ok: true, text: renderList(entries, "La pizarra no tiene ítems con ese filtro."), details: { count: entries.length } };
		}

		return { ok: false, text: `Acción desconocida: ${String((input as { action?: unknown }).action)}`, details: {} };
	} catch (error) {
		return { ok: false, text: `Pizarra: ${(error as Error).message}`, details: {} };
	}
}
