/**
 * S4: the model-facing half of the blackboard.
 *
 * The author is the harness, never the model: `discoveredBy` comes from the session id, so a child
 * cannot publish as somebody else. Reads are pruned at the source — the blackboard coordinates on
 * shape, and the raw bytes stay in the evidence chain.
 */
import type { BlackboardArtifact, BlackboardCategory, SharedBlackboard } from "../core/blackboard.ts";

export type BlackboardAction = "publish" | "query" | "claim" | "release" | "since";

export interface BlackboardToolInput {
	action: BlackboardAction;
	category?: BlackboardCategory;
	target?: string;
	data?: Record<string, unknown>;
	/** Claim/release: the artifact id, or `seq`-like index is not used here. */
	id?: string;
	ttlMs?: number;
	/** Since: return artifacts newer than this ISO timestamp. */
	ts?: string;
	limit?: number;
}

export interface BlackboardToolResult {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
}

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
	return text === "{}" ? "" : text.length <= MAX_RENDERED_DATA ? text : `${text.slice(0, MAX_RENDERED_DATA)}…`;
}

export function renderArtifact(artifact: BlackboardArtifact): string {
	const data = renderData(artifact.data);
	return `${artifact.id} · ${artifact.category} · ${artifact.target}${data === "" ? "" : ` · ${data}`} · ${artifact.discoveredBy}`;
}

function renderList(artifacts: BlackboardArtifact[], empty: string): string {
	if (artifacts.length === 0) return empty;
	const shown = artifacts.slice(0, RENDER_LIMIT);
	const hidden = artifacts.length - shown.length;
	const lines = shown.map(renderArtifact);
	if (hidden > 0) lines.push(`… ${hidden} más (filtrá por target o usá limit)`);
	return lines.join("\n");
}

function positiveInteger(value: unknown, field: string): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`"${field}" must be a positive integer`);
	return parsed;
}

export async function runBlackboardAction(blackboard: SharedBlackboard, author: string, input: BlackboardToolInput): Promise<BlackboardToolResult> {
	const discoveredBy = author.trim();
	if (discoveredBy.length === 0) return { ok: false, text: "La pizarra necesita un autor y esta sesión no tiene id.", details: {} };

	try {
		if (input.action === "publish") {
			if (input.category === undefined) return { ok: false, text: "Falta category. Valores válidos: endpoint, hidden_param, auth_schema, header_anomaly, tech_fingerprint, state_invariant.", details: {} };
			const data = input.data ?? {};
			if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, text: "data tiene que ser un objeto JSON.", details: {} };
			const size = Buffer.byteLength(JSON.stringify(data), "utf8");
			if (size > MAX_DATA_BYTES) {
				return { ok: false, text: `data ocupa ${size} bytes, el máximo de la pizarra es ${MAX_DATA_BYTES}. El payload crudo va a bounty_evidence, no acá.`, details: {} };
			}
			const result = await blackboard.publish({ category: input.category, target: String(input.target ?? ""), data, discoveredBy });
			if (result.created) return { ok: true, text: `Publicado ${renderArtifact(result.artifact)}`, details: { created: true, id: result.artifact.id } };
			return {
				ok: true,
				text: `Ya estaba en la pizarra: ${renderArtifact(result.artifact)}. No lo repitas: consultalo o reclamalo.`,
				details: { created: false, id: result.artifact.id },
			};
		}

		if (input.action === "query") {
			const artifacts = await blackboard.query({
				...(input.category === undefined ? {} : { category: input.category }),
				...(input.target === undefined ? {} : { target: String(input.target) }),
				...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, "limit") }),
			});
			return { ok: true, text: renderList(artifacts, "La pizarra no tiene artefactos con ese filtro."), details: { count: artifacts.length } };
		}

		if (input.action === "claim") {
			if (input.id === undefined) return { ok: false, text: "Falta id para reclamar un artefacto.", details: {} };
			const result = await blackboard.claim(String(input.id), { discoveredBy, ...(input.ttlMs === undefined ? {} : { ttlMs: positiveInteger(input.ttlMs, "ttl_ms") }) });
			if (result.ok) return { ok: true, text: `Reclamado ${result.artifact.id} hasta ${result.claim.until}. Publicá lo que descubras.`, details: { id: result.artifact.id, until: result.claim.until } };
			if (result.reason === "not-found") return { ok: false, text: `No existe el artefacto ${String(input.id)}.`, details: { id: String(input.id) } };
			return { ok: false, text: `${String(input.id)} está en curso por ${result.claimedBy ?? "otro agente"}. Elegí otro.`, details: { id: String(input.id), claimedBy: result.claimedBy ?? null } };
		}

		if (input.action === "release") {
			if (input.id === undefined) return { ok: false, text: "Falta id para liberar.", details: {} };
			const result = await blackboard.release(String(input.id), discoveredBy);
			if (result.released) return { ok: true, text: `Liberado ${String(input.id)}.`, details: { id: String(input.id) } };
			const reason = result.reason === "not-found" ? "no existe" : result.reason === "not-claimed" ? "nadie lo tenía" : "lo tiene otro agente";
			return { ok: false, text: `No liberé ${String(input.id)}: ${reason}.`, details: { id: String(input.id), reason: result.reason } };
		}

		if (input.action === "since") {
			const ts = input.ts === undefined ? new Date(0).toISOString() : String(input.ts);
			const artifacts = (await blackboard.since(ts)).sort((left, right) => (left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0));
			const head = artifacts.length === 0 ? ts : (artifacts[artifacts.length - 1]?.ts ?? ts);
			return { ok: true, text: renderList(artifacts, "Sin novedades en la pizarra."), details: { head, count: artifacts.length } };
		}

		return { ok: false, text: `Acción desconocida: ${String((input as { action?: unknown }).action)}`, details: {} };
	} catch (error) {
		return { ok: false, text: `Pizarra: ${(error as Error).message}`, details: {} };
	}
}
