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
import { gate, isHttpInvocation, type DnsResolver, type GateRequest } from "../core/gate.ts";
import type { Limiter, Reservation } from "../core/ratelimit.ts";
import { createSharedRateLimiter } from "../core/shared-ratelimit.ts";
import { createPendingQueue, type PendingQueue } from "../core/pending.ts";
import { requestViewForModel, responseViewForModel, type RedactionMode } from "../core/redact.ts";
import { describeRequiredHeaders, parseScope, evaluate, summarizeScope, type ScopePolicy } from "../core/scope.ts";
import { scoreVector } from "../core/cvss.ts";
import { extractEvidence, renderReport, validateReport, validateReportText } from "../core/report.ts";
import { randomUUID } from "node:crypto";
import { signExecution } from "../core/attestation.ts";
import { decideVerdict, inspectVerifierExecutions } from "../core/verdict.ts";
import { createStatusStore, renderStatus, writeStatusFile, type BountyPhase, type ProgramState, type StatusStore } from "../core/status.ts";

export interface ProgramConfig {
	/** Workspace root. `work/<program>/` is created inside it. */
	root: string;
	program: string;
	redaction?: RedactionMode;
	budget?: BudgetPolicy;
	/** S91: used to resolve a relative scope path (and to suggest the absolute one). */
	cwd?: string;
	/** D1: identity of this session, used in chain records. Set by the runner for children. */
	sessionId?: string;
	/** Task 7: the runner's per-invocation token. When set, execution records are signed. */
	invocationToken?: string;
	/** S90: nobody is at the keyboard. A destructive action is queued, not approved, not executed. */
	nightMode?: boolean;
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
	/** S76/task 2d: the verdict that actually applied, and whether it was converted. */
	effective?: "REPRODUCIDO" | "NO_REPRODUCIDO" | "INCONCLUSO";
	converted?: boolean;
	state?: string;
}

export interface ProgramSession {
	paths: {
		workspace: string;
		statusFile: string;
		evidenceDir: string;
		findingsDir: string;
		/** The scope file this session loaded, or null before the first load. */
		scopeFile: () => string | null;
	};
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
export const MODEL_EVIDENCE_KINDS = new Set(["observation", "recon-note", "recon-intelligence", "erratum"]);

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

/** S79: `-H "Name: value"` / `--header=Name: value` in argv, as the request headers. */
export function headersFromArgs(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		let raw: string | undefined;
		if (token === "-H" || token === "--header") raw = args[index + 1];
		else if (token.startsWith("--header=")) raw = token.slice("--header=".length);
		else if (token.startsWith("-H") && token.length > 2) raw = token.slice(2);
		if (raw === undefined) continue;
		const separator = raw.indexOf(":");
		if (separator <= 0) continue;
		const name = raw.slice(0, separator).trim().toLowerCase();
		const value = raw.slice(separator + 1).trim();
		if (name.length === 0) continue;
		out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
	}
	return out;
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
	// S89: the limit belongs to the program, not to this process. Two sessions of the same program
	// share one bucket on disk (proven: two in-memory limiters doubled the declared rate).
	let limiter: { reserve(host: string): Promise<Reservation> } | null = null;
	const budget = createBudget(config.budget ?? {}, now);
	const stopController = createStopController({ now });

	// S89: per-host volume cap and the loop detector. Neither replaces the human pauses: they stop a
	// session that is grinding, and say why.
	const MAX_PER_HOST_DEFAULT = 300;
	const hostCounts = new Map<string, number>();
	let streak: { key: string; count: number } | null = null;
	let stuck: { key: string; count: number; at: string } | null = null;

	async function markStuck(key: string, count: number): Promise<void> {
		stuck = { key, count, at: new Date(now()).toISOString() };
		const state = await status.read();
		state.stuck = stuck;
		await status.write(state);
		await status.note(`atascado: ${count} bloqueos seguidos por "${key}". La sesión se detuvo sola.`);
		await refresh("Estoy atascado: no sigo con variaciones del mismo bloqueo. Necesito tu decisión para continuar.");
	}

	/** Returns a refusal when this block is the fifth in a row with the same cause. */
	async function noteBlock(key: string): Promise<ToolResult | null> {
		if (stuck !== null) {
			return { ok: false, text: `La sesión está atascada (${stuck.key}, ${stuck.count} veces). No ejecuto nada más hasta que decidas algo: cambiá de enfoque o cerrá el programa.` };
		}
		streak = streak !== null && streak.key === key ? { key, count: streak.count + 1 } : { key, count: 1 };
		if (streak.count < 5) return null;
		await markStuck(key, streak.count);
		return { ok: false, text: `Cinco bloqueos seguidos por el mismo motivo (${key}): paro sola. Quedó anotado en ${status.file()}. No insisto con variaciones de lo mismo.` };
	}

	function noteSuccess(): void {
		streak = null;
	}

	const pending = createPendingQueue({ dir: workspace, now });

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
		paths: { workspace, statusFile: status.file(), evidenceDir, findingsDir, scopeFile: () => scopePath },
		sessionId,
		stopController,

		pendingQueue: pending,
		async applyVerifierVerdict(input) {
			const finding = await findings.get(input.findingId);
			if (!finding) return { ok: false, text: `No existe el hallazgo ${input.findingId}.` };

			// S76/task 2: a verdict counts only through the verifier's own signed executions with a
			// complete HTTP response. Otherwise the effective verdict is INCONCLUSO and nothing moves.
			const records = await evidence.read();
			const inspection = inspectVerifierExecutions(records, {
				verifierSessionId: input.verifierSessionId,
				token: input.invocationToken,
				endpoint: finding.endpoint,
			});
			const decision = decideVerdict({
				verdict: input.verdict,
				seqs: input.seqs,
				reason: input.reason,
				state: finding.state,
				inspection,
				tokenMissing: input.invocationToken === undefined || input.invocationToken.length === 0,
			});

			const at = new Date(now()).toISOString();
			await evidence.append({
				kind: "verification",
				payload: {
					event: decision.event,
					finding: input.findingId,
					verdict: input.verdict,
					effective: decision.effective,
					converted: decision.converted,
					seqs: input.seqs,
					verifierSessionId: input.verifierSessionId,
					detail: decision.detail,
					at,
					sessionId,
				},
			});
			if (decision.nextState !== null) {
				await findings.update(finding.id, { state: decision.nextState }, `verificador: ${decision.effective}`);
			}
			await status.setLastVerification({ at, finding: input.findingId, event: decision.event, detail: decision.detail });
			await status.note(`verificación ${input.findingId}: ${decision.effective}${decision.converted ? " (convertido)" : ""} — ${decision.detail}`);
			await refresh(
				decision.effective === "INCONCLUSO"
					? "El veredicto fue INCONCLUSO: el hallazgo no cambió. Revisá el motivo en status.md."
					: "El veredicto se aplicó: revisá status.md.",
			);
			const prefix =
				decision.converted && input.verdict !== null
					? `Veredicto del verificador: ${input.verdict}. Veredicto efectivo: ${decision.effective} (convertido por el código).`
					: `Veredicto efectivo: ${decision.effective}.`;
			return {
				ok: decision.effective !== "INCONCLUSO",
				text: `${prefix} ${decision.detail}`,
				effective: decision.effective,
				converted: decision.converted,
				state: decision.nextState ?? finding.state,
			};
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
			// S91: a relative path is resolved against the session's working directory instead of
			// failing with a bare ENOENT; the error names the absolute path it tried and the one it
			// suggests.
			const { isAbsolute, resolve } = await import("node:path");
			const absolute = isAbsolute(input.file) ? input.file : resolve(deps.cwd ?? process.cwd(), input.file);
			try {
				text = await deps.readFile(absolute);
			} catch (error) {
				const suggested = resolve(deps.cwd ?? process.cwd(), "work", config.program, "scope.yaml");
				return {
					ok: false,
					text: `No pude leer el alcance ${absolute}: ${(error as Error).message}. Usá una ruta absoluta; la de este programa suele ser ${suggested}.`,
				};
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
			limiter = createSharedRateLimiter({
				dir: workspace,
				policy: { defaultRps: parsed.policy.limits.rateRps ?? 1, dailyCap: parsed.policy.limits.maxRequestsPerDay },
				clock: now,
			});

			const ambiguities: string[] = [];
			if (parsed.policy.inScope.some((rule) => rule.wildcard)) {
				ambiguities.push("hay reglas con wildcard: cubren todos los puertos de los nombres que matchean");
			}
			if (parsed.policy.outOfScope.length === 0) ambiguities.push("el programa no declara nada fuera de alcance");
			if (parsed.policy.requiredHeaders && Object.keys(parsed.policy.requiredHeaders).length > 0) {
				// S85/task 2: the mode travels with the name; a bare name hides why it is enforced.
				ambiguities.push(`el programa exige cabeceras: ${describeRequiredHeaders(parsed.policy)}`);
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
			if (stuck !== null) {
				return { ok: false, text: `La sesión está atascada (${stuck.key}, ${stuck.count} veces): no ejecuto nada más hasta que decidas algo.` };
			}
			let current: ScopePolicy;
			try {
				current = requirePolicy();
			} catch (error) {
				const blocked = await noteBlock("no scope loaded");
				return blocked ?? { ok: false, text: (error as Error).message };
			}
			// S78/task 2: `args` is what the tool receives, never the tool name. A model that repeats the
			// tool inside args once produced `curl curl …`, and curl fetched both positionally: the gate
			// validated both (it validates every host-shaped token), but the recorded argv lied.
			const args = input.args[0] === input.tool ? input.args.slice(1) : input.args;
			const argv = [input.tool, ...args];
			const request: GateRequest = {
				target: input.target,
				argv: args,
				method: input.method,
				technique: input.technique,
				followRedirects: input.followRedirects,
				// S79/S82: the gate checks the required headers against what the tool will send, not
				// against the requirement itself.
				headers: headersFromArgs(args),
				http: isHttpInvocation(input.tool, args),
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
				const nightMode = config.nightMode === true || deps.env?.GENTLE_BOUNTY_NIGHT_MODE === "1";
				// S90: without a human at the keyboard the action is QUEUED, never approved. Night mode
				// queues even when a UI exists: the point of night mode is that nobody is there.
				if (resolved.source === "none" || nightMode) {
					const item = await pending.append({
						tool: input.tool,
						argv: args,
						target: input.target,
						classes: classification.classes,
						reason: classification.reason ?? "clase destructiva",
						why: input.why ?? "",
						sessionId,
					});
					await status.setPending(null);
					await status.note(`acción destructiva encolada: ${item.id} — ${command}`);
					await refresh("Acción destructiva encolada: sigo con otras líneas hasta que la resuelvas.");
					return {
						ok: false,
						text: `Acción destructiva encolada como ${item.id} en ${pending.file()}: no hay diálogo humano disponible${nightMode ? " (modo nocturno)" : ""}. No se ejecutó nada y la sesión sigue. La cola no autoriza nada: se resuelve con tu tecla.`,
					};
				}
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
				const reservation = await limiter.reserve(host);
				if (!reservation.allowed) {
					await status.note(`frenado por ritmo: ${reservation.reason}`);
					await refresh();
					const blocked = await noteBlock(`rate: ${reservation.reason}`);
					return blocked ?? { ok: false, text: `Frenado por el límite del programa: ${reservation.reason}` };
				}
				if (reservation.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, reservation.delayMs));
			}

			const primaryHost = decision.contacts[0]?.host ?? "unknown";
			const perHostCap = current.limits.maxRequestsPerHost ?? MAX_PER_HOST_DEFAULT;
			const used = hostCounts.get(primaryHost) ?? 0;
			if (used >= perHostCap) {
				const blocked = await noteBlock(`per-host cap on ${primaryHost}`);
				return (
					blocked ?? {
						ok: false,
						text: `Tope por host alcanzado: ${perHostCap} ejecuciones contra ${primaryHost} en esta corrida (limits.max_requests_per_host). No ejecuto más contra ese host; puedo seguir con otros hosts del alcance.`,
					}
				);
			}
			hostCounts.set(primaryHost, used + 1);

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

			// S89 loop detector: a 403/429 or an anti-bot marker is a block signal; a normal response resets.
			const statusMatch = /(?:^|\s)(\d{3})\s*$/.exec(execution.stdout.trim()) ?? /^HTTP\/[\d.]+\s+(\d{3})/m.exec(execution.stdout);
			const httpStatus = statusMatch?.[1] ?? null;
			const antiBot = /captcha-delivery|datadome|cf-challenge|perimeterx|hcaptcha|recaptcha/i.exec(execution.stdout);
			if (execution.exitCode === 0 && (httpStatus === null || (/^[23]/.test(httpStatus) && antiBot === null))) {
				noteSuccess();
			} else if (httpStatus === "403" || httpStatus === "429" || antiBot !== null) {
				await noteBlock(`http:${httpStatus ?? "?"}:${antiBot?.[0]?.toLowerCase() ?? "no-marker"}`);
			}

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
			if (input.action === "resolve") {
				if (!input.id) return { ok: false, text: "Para resolver por criterio necesito id." };
				const reason = (input.reason ?? "").trim();
				if (reason.length === 0) return { ok: false, text: "Para resolver por criterio necesito un motivo escrito: queda en la ficha del hallazgo." };
				// S92: a decision-only state needs the human's own words, not the agent's summary.
				if (input.reasonSource !== "human-verbatim") {
					return {
						ok: false,
						text: "Resolver por criterio exige un motivo citado textualmente del humano (reasonSource: \"human-verbatim\"). Un motivo redactado o resumido por el agente no habilita este estado, ni siquiera si el canal dice ser el humano.",
					};
				}
				const finding = await findings.get(input.id);
				if (!finding) return { ok: false, text: `No existe el hallazgo ${input.id}.` };
				const resolved = resolveConfirm({ env: deps.env, lab: true, uiConfirm: input.confirm ?? deps.confirm });
				if (resolved.source !== "ui") {
					return {
						ok: false,
						text: "Resolver por criterio exige tu confirmación en el diálogo (o tu terminal en --pending): sin tu tecla no se mueve nada (y no hay atajo por chat).",
					};
				}
				const approved = await resolved.confirm(
					`Resolver ${finding.id} (${finding.title}) como dismissed, por criterio humano.\n\nMotivo: ${reason}\n\n¿Confirmás? Esto no es un veredicto del verificador: es tu criterio.`,
				);
				if (!approved) return { ok: false, text: `No resolví ${finding.id}: no confirmaste en el diálogo.` };
				const updated = await findings.update(finding.id, { state: "dismissed" }, `criterio humano: ${reason}`);
				await refresh("Hallazgo resuelto por criterio humano.");
				return { ok: true, text: `${updated.id} quedó en dismissed por criterio humano. Motivo: ${reason}` };
			}
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
				if (!input.id) return { ok: false, text: "Para actualizar necesito id." };
				// D1/S76: the model never moves a finding to verified, rejected or disputed. Only the
				// verifier verdict, applied by code, and the operator, can do it.
				if (input.state === "verified" || input.state === "rejected" || input.state === "disputed") {
					return {
						ok: false,
						text: `Un hallazgo solo pasa a ${input.state} por el veredicto del verificador (bounty_verify). El agente que lo encontró no puede marcarlo.`,
					};
				}
				if (input.state === undefined && input.title === undefined && input.confidence === undefined && input.sensitive === undefined) {
					return { ok: false, text: "Para actualizar necesito algo: state, title, confidence o sensitive." };
				}
				try {
					const updated = await findings.update(
						input.id,
						{
							...(input.state === undefined ? {} : { state: input.state }),
							...(input.title === undefined ? {} : { title: input.title }),
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

			const base = {
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
			};
			// S78/task 1: the platform copy does not presuppose access to the evidence chain; the
			// internal copy (with seqs, hashes and the not-documented list) stays in evidence/.
			const internal = renderReport({ ...base, audience: "internal" });
			const external = renderReport({ ...base, audience: "external" });
			const checkInternal = validateReport(internal, reportLang, "internal");
			const checkExternal = validateReport(external, reportLang, "external");
			if (!checkInternal.ok) return { ok: false, text: `El reporte interno no cumple la checklist: falta ${checkInternal.missing.join(", ")}.` };
			if (!checkExternal.ok) return { ok: false, text: `El reporte externo no cumple la checklist: falta ${checkExternal.missing.join(", ")}.` };

			await mkdir(join(workspace, "reports"), { recursive: true });
			const path = join(workspace, "reports", `${finding.id}.md`);
			await writeFile(path, external, "utf8");
			const internalPath = join(evidenceDir, `${finding.id}.report-internal.md`);
			await writeFile(internalPath, internal, "utf8");
			await findings.update(finding.id, { cvss: vector, score: scored.score, notes: [input.summary ?? "reporte generado"] }, "reporte");
			await status.note(`reporte ${finding.id} escrito en ${path} (espera envío humano)`);
			await refresh("El reporte está escrito: lo revisás y lo mandás vos.");
			return {
				ok: true,
				text: `Reporte escrito en ${path} (copia con seqs y hashes: ${internalPath})\nSeveridad calculada: ${scored.score.toFixed(1)} (${scored.severity}) — ${vector}\nNo se envió a ninguna plataforma: eso lo hacés vos.`,
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
