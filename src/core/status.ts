/**
 * `work/<program>/status.md` (S29) and the program state behind it.
 *
 * This file is the product requirement, not a log: it must be readable on its own, in plain language,
 * without opening the task document or any log. Every phase transition and every finding state change
 * rewrites it. `bounty_status` returns the same text, so the model and the human read one thing.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Finding } from "./findings.ts";

export type BountyPhase = "scope" | "recon" | "hypothesis" | "validate" | "triage" | "report" | "close";

export type PendingKind = "scope" | "destructive" | "report";

export interface PendingConfirmation {
	kind: PendingKind;
	detail: string;
	since: string;
}

export interface ConfirmationEvent {
	outcome: "confirmed" | "denied" | "unavailable";
	at: string;
	detail: string;
}

export interface ProgramState {
	program: string;
	phase: BountyPhase;
	scopeConfirmedAt: string | null;
	/** sha256 of the scope file the last time it was confirmed (S63). */
	scopeConfirmedHash: string | null;
	/** sha256 of the scope file as it sits on disk right now (S63). */
	scopeHash: string | null;
	pending: PendingConfirmation | null;
	/** B2: the last destructive confirmation, as a dated event instead of a stuck pending item. */
	lastConfirmation: ConfirmationEvent | null;
	/** Task 3: retired "the scope changed" notes, kept as dated history instead of live noise. */
	scopeEvents: { at: string; text: string }[];
	/** S75/task 2: the last verifier verdict, so status.md shows verification as a dated event. */
	lastVerification: { at: string; finding: string; event: string; detail: string } | null;
	nextStep: string;
	notes: string[];
	updatedAt: string;
}

const PHASE_TEXT: Record<BountyPhase, string> = {
	scope: "Estoy leyendo el alcance del programa y comprobando que entendí las reglas.",
	recon: "Estoy viendo qué hay publicado en el alcance: hosts, endpoints, tecnologías.",
	hypothesis: "Estoy decidiendo dónde vale la pena mirar primero, y por qué.",
	validate: "Estoy comprobando si una debilidad concreta es real, con la prueba más chica posible.",
	triage: "Estoy midiendo el impacto y descartando duplicados y falsos positivos.",
	report: "Estoy escribiendo el reporte del hallazgo confirmado.",
	close: "El programa quedó cerrado por ahora: no hay trabajo pendiente.",
};

const STATE_TEXT: Record<Finding["state"], string> = {
	candidate: "sin confirmar",
	verified: "confirmado",
	reported: "reportado",
	duplicate: "duplicado",
	rejected: "descartado",
};

const NEXT_PHASE: Record<BountyPhase, string> = {
	scope: "Confirmame el alcance y arranco el reconocimiento.",
	recon: "Con el inventario listo, paso a priorizar dónde mirar.",
	hypothesis: "Voy a validar la hipótesis más prometedora.",
	validate: "Si se confirma, lo paso a triage y escribo el reporte.",
	triage: "Con severidad y descarte de duplicados, escribo el reporte.",
	report: "El reporte queda listo para que lo revises y lo mandes vos.",
	close: "Decime si abrimos otro programa.",
};

export function renderStatus(input: {
	state: ProgramState;
	findings: Finding[];
	scopePath: string | null;
	scopeAuthorizedOn?: string | null;
}): string {
	const { state, findings, scopePath } = input;
	const scopeAuthorizedOn = input.scopeAuthorizedOn ?? null;
	const lines: string[] = [];

	lines.push(`# ${state.program} — estado`, "");
	lines.push(`**Fase actual:** ${state.phase}`);
	lines.push(`**Qué está pasando:** ${PHASE_TEXT[state.phase]}`);
	if (scopePath) {
		const confirmed = state.scopeConfirmedHash !== null && state.scopeHash !== null && state.scopeConfirmedHash === state.scopeHash;
		const suffix = confirmed
			? ` (confirmado el ${(state.scopeConfirmedAt ?? "").replace(".000Z", "Z")} — UTC; hash ${(state.scopeHash ?? "").slice(0, 12)}…)`
			: state.scopeConfirmedHash === null
				? " (todavía sin confirmar)"
				: " (cambió desde la última confirmación: hay que volver a confirmarlo)";
		lines.push(`**Alcance:** \`${scopePath}\`${suffix}`);
	if (scopeAuthorizedOn !== null) lines.push(`**Fecha declarada en el scope:** ${scopeAuthorizedOn} (la escribe el operador, no el reloj de la sesión)`);
	}
	lines.push("");

	lines.push(`## Hallazgos (${findings.length})`);
	if (findings.length === 0) {
		lines.push("", "Todavía no hay nada anotado.");
	} else {
		lines.push("");
		for (const finding of findings) {
			const severity = finding.score === null ? "" : ` — severidad ${finding.score.toFixed(1)}`;
			lines.push(`- **${finding.id}** ${finding.title} — ${STATE_TEXT[finding.state]}${severity}`);
			lines.push(`  - dónde: ${finding.endpoint}${finding.parameter === null ? "" : ` (parámetro ${finding.parameter})`}`);
			if (finding.sensitive) lines.push("  - hallazgo sensible — revisar antes de reportar");
		}
	}
	lines.push("");

	lines.push("## Esperando tu confirmación");
	lines.push("");
	const lastConfirmation = state.lastConfirmation ?? null;
	if (state.pending === null && lastConfirmation === null) {
		lines.push("Nada pendiente: sigo solo.");
	} else if (state.pending === null) {
		lines.push("Nada pendiente ahora.");
	}
	if (lastConfirmation !== null) {
		const label =
			lastConfirmation.outcome === "confirmed"
				? "confirmaste"
				: lastConfirmation.outcome === "denied"
					? "denegaste"
					: "no había UI para confirmar";
		const when = (lastConfirmation.at ?? "").slice(11, 16);
		lines.push(`- Última acción destructiva: ${label} a las ${when} — ${lastConfirmation.detail}`);
	}
	if (state.pending !== null) {
		const kind =
			state.pending.kind === "scope"
				? "Confirmación del alcance de este programa"
				: state.pending.kind === "destructive"
					? "Una acción de clase destructiva necesita tu OK explícito"
					: "Revisión del reporte antes de mandarlo";
		lines.push(`- **${kind}**: ${state.pending.detail}`);
		lines.push(`  - pedido el ${state.pending.since.slice(0, 16).replace("T", " ")}`);
	}
	lines.push("");

	lines.push("## Qué sigue");
	lines.push("");
	lines.push(state.nextStep || NEXT_PHASE[state.phase]);
	const disputed = findings.filter((finding) => finding.state === "disputed");
	if (disputed.length > 0) {
		lines.push("", "## Disputas (las resolvés vos)");
		lines.push("");
		for (const finding of disputed) lines.push(`- ${finding.id} — ${finding.title}: el verificador no lo reprodujo sobre un hallazgo ya verificado. No se degrada solo.`);
	}
	const lastVerification = state.lastVerification ?? null;
	if (lastVerification !== null) {
		lines.push("", "## Verificación");
		lines.push("");
		lines.push(`- ${lastVerification.finding}: ${lastVerification.event} — ${lastVerification.detail}`);
		lines.push(`- Cuándo: ${lastVerification.at.replace("T", " ").slice(0, 19)} UTC`);
	}
	const scopeEvents = state.scopeEvents ?? [];
	if (scopeEvents.length > 0) {
		lines.push("", "## Historial del alcance");
		lines.push("");
		for (const event of scopeEvents.slice(-5)) lines.push(`- ${event.at.slice(0, 16).replace("T", " ")} — ${event.text}`);
	}
	if (state.notes.length > 0) {
		lines.push("", "## Notas");
		lines.push("");
		for (const note of state.notes.slice(-8)) lines.push(`- ${note}`);
	}
	lines.push("");
	return lines.join("\n");
}

export interface StatusStore {
	read(): Promise<ProgramState>;
	write(state: ProgramState): Promise<void>;
	setPhase(phase: BountyPhase, nextStep?: string): Promise<ProgramState>;
	setPending(pending: PendingConfirmation | null): Promise<ProgramState>;
	confirmScope(hash?: string): Promise<ProgramState>;
	setScopeHash(hash: string | null): Promise<ProgramState>;
	setLastConfirmation(event: ConfirmationEvent | null): Promise<ProgramState>;
	setLastVerification(event: { at: string; finding: string; event: string; detail: string } | null): Promise<ProgramState>;
	retireScopeNotes(): Promise<ProgramState>;
	note(text: string): Promise<ProgramState>;
	file(): string;
}

async function writeAtomic(path: string, text: string): Promise<void> {
	const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	await writeFile(temporary, text, "utf8");
	await rename(temporary, path);
}

export function createStatusStore(options: { workDir: string; program: string; now?: () => number }): StatusStore {
	const now = options.now ?? (() => Date.now());
	const statePath = join(options.workDir, "state.json");
	const statusPath = join(options.workDir, "status.md");

	function blank(): ProgramState {
		return {
			program: options.program,
			phase: "scope",
			scopeConfirmedAt: null,
			scopeConfirmedHash: null,
			scopeHash: null,
			pending: null,
			lastConfirmation: null,
			scopeEvents: [],
			lastVerification: null,
			nextStep: "",
			notes: [],
			updatedAt: new Date(now()).toISOString(),
		};
	}

	return {
		async read() {
			try {
				const parsed = JSON.parse(await readFile(statePath, "utf8")) as ProgramState;
				if (typeof parsed.program === "string" && typeof parsed.phase === "string") return parsed;
			} catch {
				// A missing or corrupt state file starts a fresh program state; status.md will say so.
			}
			return blank();
		},

		async write(state) {
			await mkdir(options.workDir, { recursive: true });
			state.updatedAt = new Date(now()).toISOString();
			await writeAtomic(statePath, `${JSON.stringify(state, null, "\t")}\n`);
		},

		async setPhase(phase, nextStep) {
			const state = await this.read();
			state.phase = phase;
			// A phase change invalidates the previous phase's "what next": keeping it is how a stale
			// line made the report phase say "score severity" (found while judging the samples, S39).
			state.nextStep = nextStep ?? "";
			await this.write(state);
			return state;
		},

		async setPending(pending) {
			const state = await this.read();
			state.pending = pending === null ? null : { ...pending, since: pending.since || new Date(now()).toISOString() };
			await this.write(state);
			return state;
		},

		async setLastConfirmation(event) {
			const state = await this.read();
			state.lastConfirmation = event;
			await this.write(state);
			return state;
		},

		async confirmScope(hash?: string) {
			const state = await this.read();
			state.scopeConfirmedAt = new Date(now()).toISOString();
			// S63: the confirmation is bound to the exact bytes that were confirmed.
			if (hash !== undefined) {
				state.scopeConfirmedHash = hash;
				state.scopeHash = hash;
			}
			if (state.pending?.kind === "scope") state.pending = null;
			await this.write(state);
			return state;
		},

		async setLastVerification(event: { at: string; finding: string; event: string; detail: string } | null) {
			const state = await this.read();
			state.lastVerification = event;
			await this.write(state);
			return state;
		},

		/** Task 3: a new confirmed hash retires the stale "scope changed" notes into dated history. */
		async retireScopeNotes() {
			const state = await this.read();
			const stale = state.notes.filter((note) => /el scope cambió/i.test(note));
			if (stale.length === 0) return state;
			state.notes = state.notes.filter((note) => !/el scope cambió/i.test(note));
			const at = new Date(now()).toISOString();
			state.scopeEvents = [...(state.scopeEvents ?? []), ...stale.map((text) => ({ at, text }))];
			await this.write(state);
			return state;
		},

		async setScopeHash(hash) {
			const state = await this.read();
			state.scopeHash = hash;
			await this.write(state);
			return state;
		},

		async note(text) {
			const state = await this.read();
			state.notes.push(text);
			await this.write(state);
			return state;
		},

		file() {
			return statusPath;
		},
	};
}

/** Rewrites `status.md` from the current state and findings. Returns the rendered text. */
export async function writeStatusFile(input: {
	workDir: string;
	state: ProgramState;
	findings: Finding[];
	scopePath: string | null;
}): Promise<string> {
	const text = renderStatus({ state: input.state, findings: input.findings, scopePath: input.scopePath });
	await mkdir(input.workDir, { recursive: true });
	await writeAtomic(join(input.workDir, "status.md"), text);
	return text;
}
