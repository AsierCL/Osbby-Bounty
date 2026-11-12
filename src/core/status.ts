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

export interface ProgramState {
	program: string;
	phase: BountyPhase;
	scopeConfirmedAt: string | null;
	pending: PendingConfirmation | null;
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

export function renderStatus(input: { state: ProgramState; findings: Finding[]; scopePath: string | null }): string {
	const { state, findings, scopePath } = input;
	const lines: string[] = [];

	lines.push(`# ${state.program} — estado`, "");
	lines.push(`**Fase actual:** ${state.phase}`);
	lines.push(`**Qué está pasando:** ${PHASE_TEXT[state.phase]}`);
	if (scopePath) lines.push(`**Alcance:** \`${scopePath}\`${state.scopeConfirmedAt ? ` (confirmado el ${state.scopeConfirmedAt.slice(0, 10)})` : " (todavía sin confirmar)"}`);
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
	if (state.pending === null) {
		lines.push("Nada pendiente: sigo solo.");
	} else {
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
	confirmScope(): Promise<ProgramState>;
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
			pending: null,
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
			if (nextStep !== undefined) state.nextStep = nextStep;
			await this.write(state);
			return state;
		},

		async setPending(pending) {
			const state = await this.read();
			state.pending = pending === null ? null : { ...pending, since: pending.since || new Date(now()).toISOString() };
			await this.write(state);
			return state;
		},

		async confirmScope() {
			const state = await this.read();
			state.scopeConfirmedAt = new Date(now()).toISOString();
			if (state.pending?.kind === "scope") state.pending = null;
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
