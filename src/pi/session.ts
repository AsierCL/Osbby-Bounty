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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classifyDestructive } from "../core/destructive.ts";
import { resolveConfirm } from "./confirm.ts";
import { createBudget, type BudgetPolicy } from "./budget.ts";
import { createStopController, type StopController } from "./stop.ts";
import { createEvidenceStore, sha256, type EvidenceStore } from "../core/evidence.ts";
import { createFindingsStore, type Finding, type FindingsStore } from "../core/findings.ts";
import { gate, type DnsResolver, type GateRequest } from "../core/gate.ts";
import { createRateLimiter, type Limiter } from "../core/ratelimit.ts";
import { requestViewForModel, responseViewForModel, type RedactionMode } from "../core/redact.ts";
import { parseScope, evaluate, type ScopePolicy } from "../core/scope.ts";
import { scoreVector } from "../core/cvss.ts";
import { renderReport, validateReport } from "../core/report.ts";
import { createStatusStore, renderStatus, writeStatusFile, type BountyPhase, type ProgramState, type StatusStore } from "../core/status.ts";

export interface ProgramConfig {
	/** Workspace root. `work/<program>/` is created inside it. */
	root: string;
	program: string;
	redaction?: RedactionMode;
	budget?: BudgetPolicy;
	/** S66: only a verifier session may move a finding to verified/rejected. */
	verifier?: boolean;
	now?: () => number;
}

export interface ToolExecution {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Reported by Pi when it knows: used for the run budget (S37). */
	tokens?: number;
}

export interface SessionDeps {
	/** Injected environment, so the stub guardrail is testable without touching process.env. */
	env?: NodeJS.ProcessEnv;
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
	stopController: StopController;
	/** Emergency stop: kills the children of bounty_run and records it. */
	stop(reason: string): Promise<ToolResult>;
	scope(input: { file: string; confirm?: boolean }): Promise<ToolResult>;
	run(input: {
		tool: string;
		args: string[];
		target: string;
		technique?: string;
		method?: string;
		followRedirects?: boolean;
		/** Per-call confirmation, so the adapter can hand over the live UI callback. */
		confirm?: (question: string) => Promise<boolean>;
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
		cvss?: string;
		score?: number;
		reason?: string;
	}): Promise<ToolResult>;
	phase(input: { phase: BountyPhase; nextStep?: string }): Promise<ToolResult>;
	report(input: {
		findingId: string;
		metrics: Record<string, string>;
		summary?: string;
		steps?: string[];
		impact?: string;
		remediation?: string;
	}): Promise<ToolResult>;
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
	const budget = createBudget(config.budget ?? {}, now);
	const stopController = createStopController({ now });

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
		stopController,

		async stop(reason) {
			const result = stopController.stop(reason);
			await evidence.append({ kind: "stopped", payload: { reason, killed: result.killed, at: result.at } });
			await status.note(`parada de emergencia: ${reason} (${result.killed} proceso(s) terminado(s))`);
			await refresh("Parada de emergencia. No se ejecuta nada más hasta que lo pidas.");
			const verified = await evidence.verify();
			return {
				ok: true,
				text: `Parada de emergencia ejecutada: ${result.killed} proceso(s) terminado(s). El evidence store quedó ${verified.ok ? `consistente (${verified.count} registros)` : `INCONSISTENTE: ${verified.reason}`}.`,
			};
		},

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

			// S47: the confirmation stub is a test affordance and only ever answers inside a lab.
			const stub = resolveConfirm({ env: deps.env, lab: parsed.policy.lab });
			if (stub.stubRequested && parsed.policy.lab !== true) {
				await status.note("scope rechazado: el stub de confirmación está activo y el scope no es lab: true");
				await refresh("Corregí el scope o sacá las variables del stub.");
				return {
					ok: false,
					text: "El stub de confirmación está activo y este scope no está marcado como laboratorio (lab: true). No cargo el alcance.",
				};
			}

			// S63: the confirmation is bound to the exact bytes, never to what the model claims.
			const hash = sha256(text);
			await status.setScopeHash(hash);
			const previous = await status.read();
			const alreadyConfirmed = previous.scopeConfirmedHash === hash;

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
				`Programa: ${parsed.policy.program}${parsed.policy.lab ? " (laboratorio)" : " (programa real)"}`,
				`En alcance: ${parsed.policy.inScope.length} regla(s)`,
				...parsed.policy.inScope.map((rule) => `  - ${rule.raw}`),
				`Fuera de alcance: ${parsed.policy.outOfScope.length} regla(s)`,
				...parsed.policy.outOfScope.map((rule) => `  - ${rule.raw}`),
				`Ritmo declarado: ${parsed.policy.limits.rateRps ?? "sin declarar"} req/s`,
				`Métodos: ${parsed.policy.limits.allowedMethods.join(", ") || "sin restricción"}`,
				...(parsed.warnings.length > 0 ? ["Avisos:", ...parsed.warnings.map((warning) => `  - ${warning}`)] : []),
				...(ambiguities.length > 0 ? ["A confirmar:", ...ambiguities.map((item) => `  - ${item}`)] : []),
			].join("\n");

			if (alreadyConfirmed) {
				await refresh("El alcance ya estaba confirmado para este mismo archivo: sigo.");
				return {
					ok: true,
					text: `${summary}\n\nEste alcance ya lo confirmaste (hash ${hash.slice(0, 12)}…): no te vuelvo a preguntar.`,
				};
			}

			// Ask the human. `input.confirm === true` from the model is not an answer (S63).
			const uiConfirm = typeof input.confirm === "function" ? input.confirm : deps.confirm;
			const resolved = resolveConfirm({ env: deps.env, lab: parsed.policy.lab, uiConfirm });
			const approved = await resolved.confirm(
				`Alcance de ${parsed.policy.program} (hash ${hash.slice(0, 12)}…)\n\n${summary}\n\n¿Confirmás este alcance?`,
			);

			if (!approved) {
				// Nothing loaded: the gate will refuse every bounty_run until a human confirms.
				policy = null;
				limiter = null;
				await status.setPending({ kind: "scope", detail: `alcance de ${parsed.policy.program}`, since: "" });
				await refresh("El alcance no está confirmado: no voy a ejecutar nada hasta que lo confirmes.");
				return {
					ok: false,
					text: `${summary}\n\nNo cargo el alcance: no hay confirmación humana (el "confirm" del modelo no alcanza). Quedó pendiente en ${status.file()}.`,
				};
			}

			await status.confirmScope(hash);
			await refresh("Con el alcance confirmado, arranco el reconocimiento.");
			return { ok: true, text: `${summary}\n\nAlcance confirmado por un humano (hash ${hash.slice(0, 12)}…). Arranco.` };
		},

		async run(input) {
			await mkdir(workspace, { recursive: true });
			if (stopController.isStopped()) {
				return { ok: false, text: `Parada de emergencia activa (${stopController.reason() ?? "sin motivo"}): no se ejecuta nada.` };
			}
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

			// S63: the scope on disk must be the one a human confirmed. Edited scope => denied.
			if (scopePath !== null) {
				let onDisk: string | null = null;
				try {
					onDisk = await deps.readFile(scopePath);
				} catch {
					onDisk = null;
				}
				const state = await status.read();
				if (onDisk === null || state.scopeConfirmedHash !== sha256(onDisk)) {
					await status.note("bloqueado: el scope cambió desde la última confirmación");
					await refresh("Volvé a cargar y confirmar el alcance antes de seguir.");
					return {
						ok: false,
						text: "El scope cambió desde la última confirmación (hash distinto): no ejecuto nada. Volvé a cargarlo con bounty_scope y confirmalo.",
					};
				}
			}

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

			// S64: a class the program forbids is a hard denial, not a pause. There is no confirmation
			// that can override it: to allow it, the scope has to be edited.
			const forbiddenHit = classification.classes.filter((item) => current.limits.forbidden.includes(item));
			if (forbiddenHit.length > 0) {
				await status.note(`denegado por el programa: ${forbiddenHit.join(", ")} (${input.tool})`);
				await refresh("El programa prohíbe esa clase: no se ejecuta.");
				return {
					ok: false,
					text: `Denegado por el alcance: el programa prohíbe ${forbiddenHit.join(", ")}. No hay confirmación que lo habilite; para permitirlo hay que editar el scope.`,
				};
			}

			if (classification.destructive) {
				await status.setPending({
					kind: "destructive",
					detail: `${input.tool} ${input.args.join(" ")} contra ${input.target} — ${classification.reason ?? "señal destructiva"}`,
					since: "",
				});
				await refresh("Esperando tu OK explícito para la acción destructiva.");
				const question = `Esto puede romper algo (${classification.reason ?? "clasificada como destructiva"}): ${input.tool} ${input.args.join(" ")} contra ${input.target}. ¿Lo autorizás?`;
				const resolved = resolveConfirm({ env: deps.env, lab: current.lab, uiConfirm: input.confirm ?? deps.confirm });
				const approved = await resolved.confirm(question);
				if (!approved) {
					return {
						ok: false,
						text: `Pausado: es una acción de clase destructiva y no tengo tu OK. No se ejecutó nada.\nLo dejé pedido en ${status.file()}.`,
					};
				}
				await status.setPending(null);
			}

			// S37: the wall clock is checked before anything else costs time or money.
			const wallHit = budget.exceeded();
			if (wallHit !== null) {
				await status.note(`presupuesto agotado: ${wallHit.message}`);
				await refresh("Presupuesto de la corrida agotado. Decime si abrimos otra.");
				return { ok: false, text: `Presupuesto agotado: ${wallHit.message}. Quedó anotado en ${status.file()}.` };
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

			const budgetHit = budget.toolCall();
			if (budgetHit !== null) {
				await status.note(`presupuesto agotado: ${budgetHit.message}`);
				await refresh("Presupuesto de la corrida agotado. Decime si abrimos otra.");
				return { ok: false, text: `Presupuesto agotado: ${budgetHit.message}. No se ejecutó nada.` };
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

			if (typeof execution.tokens === "number") budget.tokens(execution.tokens);

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
				// S66: the agent that found something does not get to call it verified.
				if ((input.state === "verified" || input.state === "rejected") && config.verifier !== true) {
					return {
						ok: false,
						text: `Un hallazgo solo pasa a ${input.state} por el verificador independiente (lanza bounty-verify con el id y la evidencia). El agente que lo encontró no puede marcarlo.`,
					};
				}
				try {
					const updated = await findings.update(
						input.id,
						{
							state: input.state,
							confidence: input.confidence,
							sensitive: input.sensitive,
							...(input.cvss === undefined ? {} : { cvss: input.cvss }),
							...(input.score === undefined ? {} : { score: input.score }),
						},
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

		async report(input) {
			const finding = await findings.get(input.findingId);
			if (!finding) return { ok: false, text: `No existe el hallazgo ${input.findingId}.` };
			if (finding.state !== "verified") {
				return {
					ok: false,
					text: `No reporto un hallazgo en estado ${finding.state}: primero tiene que verificarlo el verificador independiente.`,
				};
			}

			// S67: the model passes base metrics, never a score. M* metrics are rejected on purpose.
			const BASE = ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"];
			const keys = Object.keys(input.metrics);
			const modified = keys.filter((key) => key.startsWith("M"));
			if (modified.length > 0) {
				return { ok: false, text: `Métricas modificadas no soportadas: ${modified.join(", ")}. Se rechazan en vez de ignorarlas.` };
			}
			const unknown = keys.filter((key) => !BASE.includes(key));
			if (unknown.length > 0) return { ok: false, text: `Métricas desconocidas: ${unknown.join(", ")}.` };
			const missing = BASE.filter((key) => input.metrics[key] === undefined);
			if (missing.length > 0) return { ok: false, text: `Faltan métricas base: ${missing.join(", ")}.` };

			const vector = `CVSS:4.0/${BASE.map((key) => `${key}:${input.metrics[key]}`).join("/")}`;
			const scored = scoreVector(vector);
			if ("ok" in scored) return { ok: false, text: `El vector no es válido: ${scored.errors.join("; ")}` };

			const records = await evidence.read();
			const markdown = renderReport({
				finding: { ...finding, cvss: vector, score: scored.score },
				evidence: records.filter((record) => ["execution", "execution-result", "request", "response", "http-request", "http-response", "observation"].includes(record.kind)),
				program: config.program,
				reproductionSteps: input.steps ?? [],
				impact: input.impact ?? "",
				remediation: input.remediation ?? "",
			});
			const check = validateReport(markdown);
			if (!check.ok) return { ok: false, text: `El reporte no cumple la checklist: falta ${check.missing.join(", ")}.` };

			await mkdir(join(workspace, "reports"), { recursive: true });
			const path = join(workspace, "reports", `${finding.id}.md`);
			await writeFile(path, markdown, "utf8");
			await findings.update(finding.id, { cvss: vector, score: scored.score, notes: [input.summary ?? "reporte generado"] }, "reporte");
			await status.note(`reporte ${finding.id} escrito en ${path} (espera envío humano)`);
			await refresh("El reporte está escrito: lo revisás y lo mandás vos.");
			return {
				ok: true,
				text: `Reporte escrito en ${path}\nSeveridad calculada: ${scored.score.toFixed(1)} (${scored.severity}) — ${vector}\nNo se envió a ninguna plataforma: eso lo hacés vos.`,
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
