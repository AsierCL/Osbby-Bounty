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
import { parseScope, evaluate, summarizeScope, type ScopePolicy } from "../core/scope.ts";
import { scoreVector } from "../core/cvss.ts";
import { extractEvidence, renderReport, validateReport, validateReportText } from "../core/report.ts";
import { randomUUID } from "node:crypto";
import { signExecution, verifyExecutionSignature } from "../core/attestation.ts";
import { createStatusStore, renderStatus, writeStatusFile, type BountyPhase, type ProgramState, type StatusStore } from "../core/status.ts";

export interface ProgramConfig {
	/** Workspace root. `work/<program>/` is created inside it. */
	root: string;
	program: string;
	redaction?: RedactionMode;
	budget?: BudgetPolicy;
	/** D1: identity of this session, used in chain records. Set by the runner for children. */
	sessionId?: string;
	/** Task 7: the runner's per-invocation token. When set, execution records are signed. */
	invocationToken?: string;
	/** S75/task 3d: redact the written report. Operator-level, default on. */
	reportRedact?: boolean;
	/** S75/task 3f: written report language. Operator-level, default "en". */
	reportLang?: "en" | "es";
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
	/** Absent means "there is no UI": the confirmation outcome is reported as unavailable (B3). */
	confirm?: (question: string) => Promise<boolean>;
}

export interface ToolResult {
	ok: boolean;
	text: string;
}

export interface ProgramSession {
	paths: { workspace: string; statusFile: string; evidenceDir: string; findingsDir: string };
	sessionId: string;
	stopController: StopController;
	/** D1: the only path that can move a finding to verified/rejected. Called by code, never by the model. */
	applyVerifierVerdict(input: {
		findingId: string;
		verdict: "REPRODUCIDO" | "NO_REPRODUCIDO" | null;
		seqs: number[];
		reason: string;
		verifierSessionId: string;
		/** Task 7: the runner's token for this invocation; without it the verdict is refused. */
		invocationToken?: string;
	}): Promise<ToolResult>;
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
		cwe?: string;
		sensitiveData?: string;
	}): Promise<ToolResult>;
	status(): Promise<ToolResult>;
}

/** Kinds the model may append itself (7b). Everything else is written by code. */
export const MODEL_EVIDENCE_KINDS = new Set(["observation", "recon-note", "erratum"]);

/** B4: the question must be hard to answer wrong: class first, full command, explicit labels. */
export function confirmQuestion(
	classification: { classes: string[]; reason: string | null },
	command: string,
	target: string,
): string {
	const classes = classification.classes.length === 0 ? "sin clase inferida" : classification.classes.join(", ");
	return [
		`ACCIÓN DESTRUCTIVA — clase: ${classes}`,
		`Motivo: ${classification.reason ?? "señal destructiva"}`,
		`Comando completo: ${command}`,
		`Objetivo: ${target}`,
		"",
		"¿La autorizás? Elegí NO si tenés cualquier duda.",
	].join("\n");
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
	const sessionId = config.sessionId ?? randomUUID();
	const invocationToken = config.invocationToken ?? null;
	const reportRedact = config.reportRedact ?? true;
	const reportLang: "en" | "es" = config.reportLang ?? "en";

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
		sessionId,
		stopController,

		async applyVerifierVerdict(input) {
			const finding = await findings.get(input.findingId);
			if (!finding) return { ok: false, text: `No existe el hallazgo ${input.findingId}.` };

			const settle = async (event: string, detail: string, applied: boolean): Promise<ToolResult> => {
				await evidence.append({
					kind: "verification",
					payload: { event, finding: input.findingId, verdict: input.verdict, seqs: input.seqs, verifierSessionId: input.verifierSessionId, detail, at: new Date(now()).toISOString(), sessionId },
				});
				await status.setLastVerification({ at: new Date(now()).toISOString(), finding: input.findingId, event, detail });
				await status.note(`verificación ${input.findingId}: ${event} — ${detail}`);
				await refresh(applied ? "El veredicto se aplicó: revisá status.md." : "El veredicto no se pudo aplicar: el hallazgo sigue como candidato.");
				return { ok: applied, text: detail };
			};

			if (input.verdict === null) {
				return settle("unusable", "El verificador no devolvió un veredicto legible: el hallazgo sigue como candidato.", false);
			}

			if (input.verdict === "NO_REPRODUCIDO") {
				await findings.update(finding.id, { state: "rejected" }, `verificador: ${input.reason || "no reproducido"}`);
				return settle("rejected", `NO_REPRODUCIDO: el hallazgo pasó a rejected. Motivo: ${input.reason || "(sin motivo)"}`, true);
			}

			// Task 7: without the invocation token the parent cannot prove the executions are the ones its
			// own child produced, so REPRODUCIDO is refused instead of trusted.
			if (input.invocationToken === undefined || input.invocationToken.length === 0) {
				return settle(
					"unattested",
					"No puedo demostrar que esta invocación del verificador sea la que lancé (falta el token de invocación): el hallazgo sigue como candidato.",
					false,
				);
			}

			// REPRODUCIDO only counts if the chain has the verifier's own execution against this endpoint.
			const records = await evidence.read();
			const executions = records.filter(
				(record) => record.kind === "execution" && (record.payload as { sessionId?: string }).sessionId === input.verifierSessionId,
			);
			const unsigned = executions.filter((record) => {
				const payload = record.payload as { signature?: string; tool?: string; argv?: string[]; endpoint?: string; at?: string };
				return (
					(payload.endpoint === finding.endpoint || (payload.argv ?? []).join(" ").includes(finding.endpoint)) &&
					!verifyExecutionSignature(input.invocationToken as string, {
						sessionId: input.verifierSessionId,
						tool: payload.tool ?? "",
						argv: payload.argv ?? [],
						endpoint: payload.endpoint ?? "",
						at: payload.at ?? "",
					}, payload.signature)
				);
			});
			if (unsigned.length > 0) {
				return settle(
					"unattested",
					`La ejecución seq ${unsigned.map((record) => record.seq).join(", ")} de la sesión del verificador no lleva una firma válida de esta invocación (${input.verifierSessionId.slice(0, 8)}…): el hallazgo sigue como candidato.`,
					false,
				);
			}

			const matching = executions.filter((record) => {
				const payload = record.payload as { endpoint?: string; argv?: string[] };
				const endpoint = payload.endpoint ?? "";
				const argv = (payload.argv ?? []).join(" ");
				return endpoint === finding.endpoint || argv.includes(finding.endpoint);
			});
			const claimed = input.seqs.length > 0 ? matching.filter((record) => input.seqs.includes(record.seq)) : matching;
			if (claimed.length === 0) {
				return settle(
					"unsupported",
					`El veredicto dice REPRODUCIDO pero la cadena no tiene ninguna ejecución de la sesión del verificador (${input.verifierSessionId.slice(0, 8)}…) contra ${finding.endpoint}. El hallazgo sigue como candidato.`,
					false,
				);
			}

			await findings.update(finding.id, { state: "verified" }, `verificador: reproducido en seq ${claimed.map((record) => record.seq).join(", ")}`);
			return settle("verified", `REPRODUCIDO: verified con la evidencia seq ${claimed.map((record) => record.seq).join(", ")} de la sesión del verificador.`, true);
		},

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

			const summary = summarizeScope(parsed.policy, parsed.warnings, ambiguities);

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

			await status.retireScopeNotes();
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
					// Task 5: "never confirmed" and "confirmed then edited" are different situations and
					// deserve different words; both block, but for different reasons.
					const neverConfirmed = state.scopeConfirmedHash === null || state.scopeConfirmedHash === undefined;
					if (neverConfirmed) {
						await status.note("bloqueado: el alcance nunca fue confirmado en esta máquina");
						await refresh("Cargá el alcance con bounty_scope y confirmalo.");
						return {
							ok: false,
							text: "El alcance nunca fue confirmado para este archivo: no ejecuto nada. Cargalo con bounty_scope y confirmalo.",
						};
					}
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
				// 7a/R9: a gate block is a system fact, so the chain records it, not only the model's prose.
				await evidence.append({
					kind: "gate",
					payload: {
						event: "gate-blocked",
						reason: decision.reason,
						detail: decision.detail ?? null,
						tool: input.tool,
						argv,
						target: input.target,
						at: new Date(now()).toISOString(),
						sessionId,
					},
				});
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
				await evidence.append({
					kind: "gate",
					payload: {
						event: "forbidden-class",
						classes: forbiddenHit,
						tool: input.tool,
						argv,
						target: input.target,
						at: new Date(now()).toISOString(),
						sessionId,
					},
				});
				await status.note(`denegado por el programa: ${forbiddenHit.join(", ")} (${input.tool})`);
				await refresh("El programa prohíbe esa clase: no se ejecuta.");
				return {
					ok: false,
					text: `Denegado por el alcance: el programa prohíbe ${forbiddenHit.join(", ")}. No hay confirmación que lo habilite; para permitirlo hay que editar el scope.`,
				};
			}

			const confirmation = { note: "" };

			if (classification.destructive) {
				const requestedAt = new Date(now()).toISOString();
				const command = `${input.tool} ${input.args.join(" ")}`.trim();
				await status.setPending({
					kind: "destructive",
					detail: `${command} contra ${input.target} — ${classification.reason ?? "señal destructiva"}`,
					since: requestedAt,
				});
				await evidence.append({
					kind: "confirmation",
					payload: {
						event: "requested",
						classes: classification.classes,
						reason: classification.reason,
						command,
						target: input.target,
						at: requestedAt,
						sessionId,
					},
				});
				await refresh("Esperando tu OK explícito para la acción destructiva.");

				const resolved = resolveConfirm({ env: deps.env, lab: current.lab, uiConfirm: input.confirm ?? deps.confirm });
				const approved = await resolved.confirm(confirmQuestion(classification, command, input.target));
				const outcome = resolved.source === "none" ? "unavailable" : approved ? "granted" : "denied";
				const at = new Date(now()).toISOString();
				const hhmm = at.slice(11, 16);

				// B2: the pending item is cleared AND status.md is rewritten, so nothing stays stale.
				await status.setPending(null);
				await status.setLastConfirmation({
					outcome: outcome === "granted" ? "confirmed" : outcome === "denied" ? "denied" : "unavailable",
					at,
					detail: `${command} — ${classification.reason ?? "clase destructiva"}`,
				});
				await evidence.append({
					kind: "confirmation",
					payload: { event: outcome, classes: classification.classes, command, target: input.target, at, sessionId },
				});

				if (outcome !== "granted") {
					const text =
						outcome === "denied"
							? `Acción destructiva denegada por el humano a las ${hhmm}. No se ejecutó nada.`
							: `Acción destructiva sin UI: no confirmada a las ${hhmm}. No se ejecutó nada.`;
					await refresh("La acción destructiva quedó denegada. Decime si querés otro camino.");
					return { ok: false, text };
				}
				// B3: the outcome is part of what the model sees, always.
				confirmation.note = `Acción destructiva confirmada por el humano a las ${hhmm}.`;
				await refresh("Ejecuto la acción destructiva que confirmaste.");
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

			const executionAt = new Date(now()).toISOString();
			const endpoint = new URL(input.target).pathname;
			await evidence.append({
				kind: "execution",
				payload: {
					tool: input.tool,
					argv,
					contacts: decision.contacts,
					technique: input.technique ?? null,
					endpoint,
					at: executionAt,
					sessionId,
					// Task 7: signed with the token the runner gave this session, if any.
					...(invocationToken === null ? {} : { signature: signExecution(invocationToken, { sessionId, tool: input.tool, argv, endpoint, at: executionAt }) }),
				},
			});

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
					...(confirmation.note === "" ? [] : [confirmation.note]),
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
				// 7b: system kinds (execution, gate, confirmation, …) are written by code only.
				if (!MODEL_EVIDENCE_KINDS.has(input.kind)) {
					return {
						ok: false,
						text: `El kind "${input.kind}" está reservado al sistema. Vos podés anotar: ${[...MODEL_EVIDENCE_KINDS].join(", ")}.`,
					};
				}
				if (input.kind === "erratum") {
					const refSeq = (input.payload as { refSeq?: unknown } | undefined)?.refSeq;
					if (typeof refSeq !== "number") return { ok: false, text: "Un erratum necesita payload.refSeq (el número de seq al que corrige)." };
					const exists = (await evidence.read()).some((record) => record.seq === refSeq);
					if (!exists) return { ok: false, text: `No existe el seq ${refSeq}: no puedo colgar un erratum de la nada.` };
				}
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
			const errata = records
				.filter((record) => record.kind === "erratum")
				.map((record) => ({ refSeq: Number((record.payload as { refSeq?: number }).refSeq), text: String((record.payload as { note?: string }).note ?? "") }));
			const lines = records
				.filter((record) => record.kind !== "erratum")
				.map((record) => {
					const corrections = errata.filter((item) => item.refSeq === record.seq).map((item) => `  ↳ erratum: ${item.text}`);
					return [`${record.seq}. ${record.kind} (${record.ts})`, ...corrections].join("\n");
				});
			return { ok: true, text: lines.join("\n") || "Sin evidencia todavía." };
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
				// D1: the model never moves a finding to verified/rejected. Only the verifier verdict,
				// applied by code in applyVerifierVerdict, can do it.
				if (input.state === "verified" || input.state === "rejected") {
					return {
						ok: false,
						text: `Un hallazgo solo pasa a ${input.state} por el veredicto del verificador (bounty_verify). El agente que lo encontró no puede marcarlo.`,
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
			const all = await evidence.read();
			const lastVerification = [...all].reverse().find((record) => record.kind === "verification");
			const reproSeqs = lastVerification === undefined ? [] : ((lastVerification.payload as { seqs?: number[] }).seqs ?? []);
			const initialSeq =
				records
					.filter((record) => record.kind === "execution")
					.map((record) => ({ record, payload: record.payload as { endpoint?: string; argv?: string[] } }))
					.find(({ payload }) => payload.endpoint === finding.endpoint || (payload.argv ?? []).join(" ").includes(finding.endpoint))?.record.seq ?? null;

			const summary = input.summary ?? "";
			const textCheck = validateReportText({ title: finding.title, summary, impact: input.impact ?? "", vector, lang: reportLang });
			if (!textCheck.ok) return { ok: false, text: `El reporte no cumple la checklist: ${textCheck.errors.join("; ")}.` };

			const markdown = renderReport({
				finding: { ...finding, cvss: vector, score: scored.score },
				records,
				program: config.program,
				summary,
				steps: input.steps ?? [],
				impact: input.impact ?? "",
				remediation: input.remediation ?? "",
				cwe: input.cwe ?? null,
				sensitiveData: input.sensitiveData ?? null,
				lang: reportLang,
				redact: reportRedact,
				reproSeqs,
				initialSeq,
				warnings: textCheck.warnings,
			});
			const check = validateReport(markdown, reportLang);
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
