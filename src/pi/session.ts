/**
 * Program session: the thin layer between the Pi tools and `bounty-core`.
 *
 * It owns the workspace layout (`work/<program>/`), keeps `status.md` in sync on every transition
 * (S29), applies the two red lines (S23), and is explicit about the one place a human is asked:
 * first scope load (S28a), destructive actions (S28b) and report sending (S28c).
 *
 * Everything that touches the outside world is injected: the DNS resolver, the file reader, the tool
 * executor and the confirmation callback. No test here spawns a process or resolves a host.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { classifyDestructive } from "../core/destructive.ts";
import { createEvidenceStore, type EvidenceStore } from "../core/evidence.ts";
import { createFindingsStore, type Finding, type FindingsStore } from "../core/findings.ts";
import { gate, type DnsResolver, type GateRequest } from "../core/gate.ts";
import { createRateLimiter, type Limiter } from "../core/ratelimit.ts";
import { requestViewForModel, responseViewForModel, type RedactionMode } from "../core/redact.ts";
import { parseScope, evaluate, type ScopePolicy } from "../core/scope.ts";
import { createStatusStore, renderStatus, writeStatusFile, type BountyPhase, type ProgramState, type StatusStore } from "../core/status.ts";

export interface ProgramConfig {
	/** Workspace root. `work/<program>/` is created inside it. */
	root: string;
	program: string;
	redaction?: RedactionMode;
	now?: () => number;
}

export interface ToolExecution {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SessionDeps {
	dns: DnsResolver;
	readFile: (path: string) => Promise<string>;
	runTool: (argv: string[]) => Promise<ToolExecution>;
	confirm: (question: string) => Promise<boolean>;
}

export interface ToolResult {
	ok: boolean;
	text: string;
}

export interface ProgramSession {
	paths: { workspace: string; statusFile: string; evidenceDir: string; findingsDir: string };
	scope(input: { file: string; confirm?: boolean }): Promise<ToolResult>;
	run(input: {
		tool: string;
		args: string[];
		target: string;
		technique?: string;
		method?: string;
		followRedirects?: boolean;
	}): Promise<ToolResult>;
	evidence(input: { action: "append" | "verify" | "list"; kind?: string; payload?: unknown }): Promise<ToolResult>;
	finding(input: {
		action: "create" | "update" | "list";
		id?: string;
		title?: string;
		class?: string;
		endpoint?: string;
		parameter?: string;
		state?: Finding["state"];
		confidence?: Finding["confidence"];
		sensitive?: boolean;
		reason?: string;
	}): Promise<ToolResult>;
	phase(input: { phase: BountyPhase; nextStep?: string }): Promise<ToolResult>;
	status(): Promise<ToolResult>;
}

export function createSession(config: ProgramConfig, deps: SessionDeps): ProgramSession {
	const now = config.now ?? (() => Date.now());
	const workspace = join(config.root, "work", config.program);
	const evidenceDir = join(workspace, "evidence");
	const findingsDir = join(workspace, "findings");

	const status: StatusStore = createStatusStore({ workDir: workspace, program: config.program, now });
	const findings: FindingsStore = createFindingsStore({ dir: findingsDir, program: config.program, now });
	const evidence: EvidenceStore = createEvidenceStore(evidenceDir, { now });
	const redaction: RedactionMode = config.redaction ?? "off";

	let policy: ScopePolicy | null = null;
	let scopePath: string | null = null;
	let limiter: Limiter | null = null;

	async function refresh(next?: string): Promise<string> {
		const state = await status.read();
		if (next !== undefined) state.nextStep = next;
		await status.write(state);
		const all = await findings.list();
		return writeStatusFile({ workDir: workspace, state, findings: all, scopePath });
	}

	function requirePolicy(): ScopePolicy {
		if (policy === null) throw new Error("no scope loaded: call bounty_scope with the program's scope file first");
		return policy;
	}

	return {
		paths: { workspace, statusFile: status.file(), evidenceDir, findingsDir },

		async scope(input) {
			await mkdir(workspace, { recursive: true });
			let text: string;
			try {
				text = await deps.readFile(input.file);
			} catch (error) {
				return { ok: false, text: `No pude leer el alcance ${input.file}: ${(error as Error).message}` };
			}
			const parsed = parseScope(text);
			if (!parsed.ok) {
				return { ok: false, text: `El alcance no parsea, así que no lo uso:\n- ${parsed.errors.join("\n- ")}` };
			}

			policy = parsed.policy;
			scopePath = input.file;
			limiter = createRateLimiter(
				{ defaultRps: parsed.policy.limits.rateRps ?? 1, dailyCap: parsed.policy.limits.maxRequestsPerDay },
				now,
			);

			const ambiguities: string[] = [];
			if (parsed.policy.inScope.some((rule) => rule.wildcard)) {
				ambiguities.push("hay reglas con wildcard: cubren todos los puertos de los nombres que matchean");
			}
			if (parsed.policy.outOfScope.length === 0) ambiguities.push("el programa no declara nada fuera de alcance");
			if (parsed.policy.requiredHeaders && Object.keys(parsed.policy.requiredHeaders).length > 0) {
				ambiguities.push(`el programa exige cabeceras: ${Object.keys(parsed.policy.requiredHeaders).join(", ")}`);
			}

			const summary = [
				`Programa: ${parsed.policy.program}`,
				`En alcance: ${parsed.policy.inScope.length} regla(s)`,
				...parsed.policy.inScope.map((rule) => `  - ${rule.raw}`),
				`Fuera de alcance: ${parsed.policy.outOfScope.length} regla(s)`,
				...parsed.policy.outOfScope.map((rule) => `  - ${rule.raw}`),
				`Ritmo declarado: ${parsed.policy.limits.rateRps ?? "sin declarar"} req/s`,
				`Métodos: ${parsed.policy.limits.allowedMethods.join(", ") || "sin restricción"}`,
				...(parsed.warnings.length > 0 ? ["Avisos:", ...parsed.warnings.map((warning) => `  - ${warning}`)] : []),
				...(ambiguities.length > 0 ? ["A confirmar:", ...ambiguities.map((item) => `  - ${item}`)] : []),
			].join("\n");

			if (input.confirm === true) {
				await status.confirmScope();
				await refresh("Con el alcance confirmado, arranco el reconocimiento.");
				return { ok: true, text: `${summary}\n\nAlcance confirmado. Arranco.` };
			}

			await status.setPending({ kind: "scope", detail: `alcance de ${parsed.policy.program}`, since: "" });
			const rendered = await refresh("Esperando tu OK del alcance para arrancar.");
			void rendered;
			return {
				ok: true,
				text: `${summary}\n\nEsperando tu confirmación del alcance (decime "confirmo" y sigo). Mientras tanto escribí el resumen en ${status.file()}.`,
			};
		},

		async run(input) {
			await mkdir(workspace, { recursive: true });
			let current: ScopePolicy;
			try {
				current = requirePolicy();
			} catch (error) {
				return { ok: false, text: (error as Error).message };
			}
			const argv = [input.tool, ...input.args];
			const request: GateRequest = {
				target: input.target,
				argv: input.args,
				method: input.method,
				technique: input.technique,
				followRedirects: input.followRedirects,
				headers: current.requiredHeaders,
			};

			const decision = await gate(current, request, { dns: deps.dns, readFile: deps.readFile });
			if (!decision.allowed) {
				await status.note(`bloqueado: ${decision.reason} (${input.tool} ${input.args.join(" ")})`);
				await refresh(`Corregí el alcance o el comando: el gate bloqueó ${input.tool}.`);
				return {
					ok: false,
					text: `Bloqueado por el gate: ${decision.reason}${decision.detail === undefined ? "" : `\n${decision.detail}`}\n\nQuedó anotado en ${status.file()}.`,
				};
			}

			// S35: inferred from binary name and argv, never trusted from the model's claim alone.
			const classification = classifyDestructive({
				tool: input.tool,
				args: input.args,
				technique: input.technique,
				scopeRateRps: current.limits.rateRps,
				forbidden: current.limits.forbidden,
				targetPath: (() => {
					try {
						return new URL(input.target).pathname;
					} catch {
						return "";
					}
				})(),
			});

			if (classification.destructive) {
				await status.setPending({
					kind: "destructive",
					detail: `${input.tool} ${input.args.join(" ")} contra ${input.target} — ${classification.reason ?? "señal destructiva"}`,
					since: "",
				});
				await refresh("Esperando tu OK explícito para la acción destructiva.");
				const question = `Esto puede romper algo (${classification.reason ?? "clasificada como destructiva"}): ${input.tool} ${input.args.join(" ")} contra ${input.target}. ¿Lo autorizás?`;
				const approved = await deps.confirm(question);
				if (!approved) {
					return {
						ok: false,
						text: `Pausado: es una acción de clase destructiva y no tengo tu OK. No se ejecutó nada.\nLo dejé pedido en ${status.file()}.`,
					};
				}
				await status.setPending(null);
			}

			if (limiter !== null) {
				const host = decision.contacts[0]?.host ?? "unknown";
				const reservation = limiter.reserve(host);
				if (!reservation.allowed) {
					await status.note(`frenado por ritmo: ${reservation.reason}`);
					await refresh();
					return { ok: false, text: `Frenado por el límite del programa: ${reservation.reason}` };
				}
				if (reservation.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, reservation.delayMs));
			}

			await evidence.append({ kind: "execution", payload: { tool: input.tool, argv, contacts: decision.contacts, technique: input.technique ?? null } });

			let execution: ToolExecution;
			try {
				execution = await deps.runTool(argv);
			} catch (error) {
				await evidence.append({ kind: "execution-error", payload: { tool: input.tool, error: (error as Error).message } });
				return { ok: false, text: `No pude ejecutar ${input.tool}: ${(error as Error).message}` };
			}

			await evidence.append({
				kind: "execution-result",
				payload: { tool: input.tool, exitCode: execution.exitCode, stdout: execution.stdout, stderr: execution.stderr },
			});

			const viewed = responseViewForModel(
				{ status: execution.exitCode, headers: {}, body: execution.stdout || execution.stderr },
				{ redaction, maxBodyBytes: 4000 },
			);
			const contactLines = decision.contacts.map((contact) => `${contact.host} (${contact.source})`).join(", ");
			return {
				ok: execution.exitCode === 0,
				text: [
					`${input.tool} terminó con código ${execution.exitCode}.`,
					`Contactado: ${contactLines || "nada"}.`,
					viewed.body === null ? "(sin salida)" : viewed.body,
					...(decision.notes.length > 0 ? [`Notas del gate: ${decision.notes.join("; ")}`] : []),
					`La salida cruda quedó en el evidence store de ${evidenceDir}.`,
				].join("\n"),
			};
		},

		async evidence(input) {
			if (input.action === "append") {
				if (typeof input.kind !== "string") return { ok: false, text: "Falta kind para anotar evidencia." };
				const record = await evidence.append({ kind: input.kind, payload: input.payload });
				return { ok: true, text: `Evidencia anotada: seq ${record.seq}, hash ${record.hash.slice(0, 12)}…` };
			}
			if (input.action === "verify") {
				const result = await evidence.verify();
				return result.ok
					? { ok: true, text: `Cadena de evidencia intacta: ${result.count} registros.` }
					: { ok: false, text: `La cadena de evidencia está rota: ${result.reason}` };
			}
			const records = await evidence.read();
			return { ok: true, text: records.map((record) => `${record.seq}. ${record.kind} (${record.ts})`).join("\n") || "Sin evidencia todavía." };
		},

		async finding(input) {
			if (input.action === "create") {
				if (!input.title || !input.class || !input.endpoint) return { ok: false, text: "Para crear un hallazgo necesito title, class y endpoint." };
				const { finding, duplicateOf } = await findings.create({
					title: input.title,
					class: input.class,
					endpoint: input.endpoint,
					parameter: input.parameter ?? null,
					confidence: input.confidence,
					sensitive: input.sensitive,
				});
				const rendered = await refresh();
				void rendered;
				return {
					ok: true,
					text: duplicateOf === null
						? `Hallazgo ${finding.id} anotado como candidato. Estado en ${status.file()}.`
						: `Ya lo tenía: ${duplicateOf}. No lo dupliqué.`,
				};
			}
			if (input.action === "update") {
				if (!input.id || !input.state) return { ok: false, text: "Para actualizar necesito id y state." };
				try {
					const updated = await findings.update(
						input.id,
						{ state: input.state, confidence: input.confidence, sensitive: input.sensitive },
						input.reason ?? "sin motivo",
					);
					if (updated.sensitive) await status.note(`${updated.id}: hallazgo sensible — revisar antes de reportar`);
					const rendered = await refresh();
					void rendered;
					return { ok: true, text: `${updated.id} ahora está en estado ${updated.state}.` };
				} catch (error) {
					return { ok: false, text: (error as Error).message };
				}
			}
			const all = await findings.list();
			return {
				ok: true,
				text: all.map((finding) => `${finding.id} [${finding.state}] ${finding.title} — ${finding.endpoint}`).join("\n") || "Sin hallazgos todavía.",
			};
		},

		async phase(input) {
			await status.setPhase(input.phase, input.nextStep);
			const rendered = await refresh();
			return { ok: true, text: rendered };
		},

		async status() {
			const state: ProgramState = await status.read();
			const all = await findings.list().catch(() => [] as Finding[]);
			return { ok: true, text: renderStatus({ state, findings: all, scopePath }) };
		},
	};
}

/** Re-exported so the extension and the tests share one definition. */
export { evaluate };
