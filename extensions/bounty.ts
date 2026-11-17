/**
 * Pi adapter (S30). This file is a shim: it registers six tools and hands every decision to
 * `src/pi/session.ts`, which is tested without Pi.
 *
 * Verification status: the registration shape (`registerTool` + `execute(toolCallId, params, signal,
 * onUpdate, ctx)` returning `{ content, details }`, and a plain JSON-schema `parameters` object cast
 * the way gentle-pi does) follows `docs/extensions.md:90-103` and `extensions/gentle-agents.ts:2622`.
 * **It has not been executed inside a live Pi session yet** — that is the first thing Phase E does.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { createSession, type ProgramSession } from "../src/pi/session.ts";
import { runProcess } from "../src/pi/process.ts";
import { resolveForGate } from "../src/pi/dns.ts";
import { createJobStore } from "../src/core/jobs.ts";
import { listJobs } from "../src/pi/recon-job.ts";
import { renderJob } from "../src/core/jobs.ts";
import { loadGlobalConfig, type GlobalConfig } from "../src/core/config.ts";
import { buildDomainPrompt } from "../src/pi/prompt.ts";
import { createPiRunner } from "../src/pi/runner.ts";
import { verifierTaskFor, parseVerdict } from "../src/pi/verifier.ts";
import { createEvidenceStore } from "../src/core/evidence.ts";
import { createSharedBlackboard } from "../src/core/blackboard.ts";
import { createRoleStore, normalizeRoleName } from "../src/core/roles.ts";
import { extractSurface, summarizeSurface, endpointBoardData, MAX_SURFACE_BYTES } from "../src/core/surface.ts";
import { runBlackboardAction, type BlackboardAction } from "../src/pi/blackboard-tools.ts";
import { runSwarm, SWARM_ROLES, summarizeSwarm, swarmTaskFor } from "../src/pi/swarm.ts";
import { extractJsonArray } from "../src/core/json-extract.ts";
import type { BountyPhase } from "../src/core/status.ts";
import type { RedactionMode } from "../src/core/redact.ts";

interface PiToolContext {
	ui?: { confirm?: (title: string, message?: string) => Promise<boolean> };
	cwd?: string;
}

interface PiLike {
	on?(event: "before_agent_start", handler: (event: { systemPromptOptions?: { sections?: Record<string, string> } }) => void): void;
	registerTool(spec: {
		name: string;
		label?: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: unknown,
			onUpdate?: unknown,
			ctx?: PiToolContext,
		) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
	}): void;
}

function text(value: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: value }], details };
}

function redactionMode(): RedactionMode {
	return process.env.GENTLE_BOUNTY_REDACTION === "on" ? "on" : "off";
}

// S68: the domain prompt is built once, from the assets, before any turn happens.
const assetsDir = fileURLToPath(new URL("../assets/", import.meta.url));
const domainPrompt = await buildDomainPrompt((path) => readFile(path, "utf8"), assetsDir).catch((error: Error) => {
	console.error(`gentle-bounty: no pude armar el prompt de dominio: ${error.message}`);
	return null;
});

export default function bountyExtension(pi: PiLike): void {
	pi.on?.("before_agent_start", (event) => {
		if (domainPrompt === null) return;
		const sections = event.systemPromptOptions?.sections;
		if (sections === undefined) return;
		// Least invasive injection: a named section, not a forced replacement of the whole prompt.
		sections["gentle-bounty-domain"] = domainPrompt;
	});

	const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
	const sessions = new Map<string, ProgramSession>();
	let config: GlobalConfig | null = null;

	async function globalConfig(): Promise<GlobalConfig | null> {
		if (config) return config;
		try {
			config = await loadGlobalConfig((path) => readFile(path, "utf8"), join(root, ".bounty", "config.json"));
			return config;
		} catch (error) {
			console.error(`gentle-bounty: config rejected, running with defaults: ${(error as Error).message}`);
			return null;
		}
	}

	/**
	 * S76/task 1: a child launched by the runner gets GENTLE_BOUNTY_PROGRAM. It is the default for every
	 * tool call and the only program those tools will accept: a verifier that wandered into another
	 * program's scope is exactly the failure this closes.
	 */
	function resolveProgram(requested: unknown): { ok: true; program: string } | { ok: false; text: string } {
		const locked = process.env.GENTLE_BOUNTY_PROGRAM;
		const asked = requested === undefined || requested === null ? "" : String(requested).trim();
		if (locked !== undefined && locked.length > 0) {
			if (asked.length === 0) return { ok: true, program: locked };
			if (asked !== locked) {
				return {
					ok: false,
					text: `Programa no permitido en esta sesión: pediste "${asked}" y esta sesión es "${locked}". Un verificador no toca otros programas ni otros alcances.`,
				};
			}
			return { ok: true, program: locked };
		}
		if (asked.length === 0) return { ok: false, text: "Falta el programa." };
		return { ok: true, program: asked };
	}

	async function sessionFor(program: string): Promise<ProgramSession> {
		const existing = sessions.get(program);
		if (existing) return existing;
		if (config === null) await globalConfig();
		const created = createSession(
			{
				root,
				program,
				...(process.env.GENTLE_BOUNTY_SESSION_ID === undefined ? {} : { sessionId: process.env.GENTLE_BOUNTY_SESSION_ID }),
				...(process.env.GENTLE_BOUNTY_INVOCATION_TOKEN === undefined ? {} : { invocationToken: process.env.GENTLE_BOUNTY_INVOCATION_TOKEN }),
				redaction: config?.redaction ?? redactionMode(),
				budget: config?.budget,
				reportRedact: config?.reportRedact ?? true,
				reportLang: config?.reportLang ?? "en",
			},
			{
				dns: resolveForGate,
				readFile: (path) => readFile(path, "utf8"),
				runTool: (argv) => runProcess(argv, root, config?.toolPath ?? []),
			},
		);
		sessions.set(program, created);
		// Test affordance (S43), gated by the same two-key opt-in as the confirmation stub: preload the
		// scope so a live run can exercise bounty_run without depending on the model doing two calls.
		const preload = process.env.GENTLE_BOUNTY_PRELOAD_SCOPE;
		if (preload && process.env.GENTLE_BOUNTY_ALLOW_CONFIRM_STUB === "1") {
			// Awaited: a fire-and-forget preload lost the race against the first tool call.
			await created.scope({ file: preload, confirm: true });
		}
		return created;
	}

	type UiContext = { ui?: { select?: (title: string, options: string[]) => Promise<string | undefined>; confirm?: (title: string, message?: string) => Promise<boolean> } };

	/** B4: yes/no through the UI. "No" goes first, and only the explicit yes approves. */
	function humanAsk(context: UiContext | undefined, title: string, detail: string): ((question: string) => Promise<boolean>) | undefined {
		const ui = context?.ui;
		if (typeof ui?.select === "function") {
			return async (question: string) => {
				const answer = await ui.select(`${title}\n\n${question}\n\n${detail}`, ["No, no ejecutar", "Sí, ejecutar"]);
				return answer === "Sí, ejecutar";
			};
		}
		if (typeof ui?.confirm === "function") {
			return async (question: string) => Boolean(await ui.confirm(title, `${question}\n\n${detail}\n\nSi tenés dudas, respondé que no.`));
		}
		return undefined;
	}

	pi.registerTool({
		name: "bounty_scope",
		label: "Bounty scope",
		description:
			"Load a program's scope file, show a plain-language summary of the rules, and pause for the human's one-time confirmation. Required before any other bounty tool.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string", description: "Program name, used for the work/<program>/ folder." },
				file: { type: "string", description: "Path to the program's scope YAML." },
				confirm: { type: "boolean", description: "Set true only when the human has confirmed the scope." },
			},
			required: ["program", "file"],
		} as never,
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			// S63: the model's `confirm` flag is not an answer. Only the human UI is.
			const confirm = humanAsk(context, "Confirmar alcance", "Es la única vez que te voy a preguntar por este archivo de alcance.");
			const result = await session.scope({ file: String(params.file), ...(confirm === undefined ? {} : { confirm }) });
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_run",
		label: "Bounty run",
		description:
			"The only way to touch a target. Validates every host in argv against the scope, applies the program's rate limit, asks for explicit confirmation on destructive classes, and records evidence.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				tool: { type: "string", description: "Executable name, for example nuclei or httpx." },
				args: { type: "array", items: { type: "string" }, description: "Arguments, as separate tokens." },
				target: { type: "string", description: "The URL or host the command is aimed at." },
				technique: { type: "string", description: "Optional class, for example idor or dos." },
				method: { type: "string" },
				follow_redirects: { type: "boolean" },
				burst: { type: "number", description: "Controlled burst of identical requests (1-12) for race-condition testing; each request reserves the program's rate." },
				mass_assignment: { type: "boolean", description: "Merge documented escalation keys into a JSON body and record which keys were added." },
				recon_tool: {
					type: "string",
					enum: ["subfinder", "httpx", "katana", "nuclei", "gobuster"],
					description: "Parse this recon tool's JSON/NDJSON output into structured recon-intelligence evidence.",
				},
				role: {
					type: "string",
					description: "Role session to inject (work/<program>/sessions/<role>.headers). curl only; the credential never enters argv.",
				},
			},
			required: ["program", "tool", "args", "target"],
		} as never,
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			// B4: title names the class and the full command; "No" is the first option.
			const confirm = humanAsk(
				context,
				"ACCIÓN DESTRUCTIVA — confirmá sólo si estás seguro",
				"Responder Sí ejecuta el comando tal cual. Responder No no ejecuta nada y queda registrado.",
			);
			const result = await session.run({
				tool: String(params.tool),
				args: Array.isArray(params.args) ? params.args.map(String) : [],
				target: String(params.target),
				confirm,
				...(params.technique === undefined ? {} : { technique: String(params.technique) }),
				...(typeof params.burst === "number" ? { burst: params.burst } : {}),
				...(params.mass_assignment === true ? { massAssignment: true } : {}),
				...(params.recon_tool === undefined ? {} : { reconTool: String(params.recon_tool) }),
				...(params.role === undefined ? {} : { role: String(params.role) }),
				...(params.method === undefined ? {} : { method: String(params.method) }),
				...(params.follow_redirects === undefined ? {} : { followRedirects: params.follow_redirects === true }),
			});
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_evidence",
		label: "Bounty evidence",
		description: "Append to, list, or verify the hash-chained evidence store of the program.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				action: { type: "string", enum: ["append", "list", "verify"] },
				kind: { type: "string" },
				payload: { type: "object" },
			},
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const result = await session.evidence({
				action: params.action as "append" | "list" | "verify",
				...(params.kind === undefined ? {} : { kind: String(params.kind) }),
				...(params.payload === undefined ? {} : { payload: params.payload }),
			});
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_surface",
		label: "Bounty surface",
		description:
			"Extract the surface from an artifact that is already captured under work/<program>/: a JavaScript bundle, an OpenAPI/Swagger document or a GraphQL introspection. Publishes endpoints (path, method, parameter NAMES) to the board. No network; values of secrets are never read out.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				file: { type: "string", description: "Path to the artifact, relative to work/<program>/ (for example files/main.js). It must already exist: bounty_surface never downloads anything." },
			},
			required: ["program", "file"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const workspace = resolve(session.paths.workspace);
			const candidate = resolve(workspace, String(params.file));
			if (!candidate.startsWith(`${workspace}${sep}`)) {
				return text(`El archivo tiene que estar dentro de work/${resolved.program}/. No se lee nada fuera del workspace del programa.`, { ok: false });
			}

			let bytes: Buffer;
			try {
				bytes = await readFile(candidate);
			} catch {
				return text(`No existe ${String(params.file)}. Capturalo primero con bounty_run (por ejemplo curl -o files/main.js) y volvé con el archivo ya en disco.`, { ok: false });
			}
			if (bytes.byteLength > MAX_SURFACE_BYTES) {
				return text(`El archivo ocupa ${bytes.byteLength} bytes y el tope es ${MAX_SURFACE_BYTES}. Partilo o usá el esquema en vez del bundle.`, { ok: false });
			}

			const relative = candidate.slice(workspace.length + 1);
			const report = extractSurface(bytes.toString("utf8"), relative);
			const blackboard = createSharedBlackboard({ dir: session.paths.workspace, program: resolved.program });
			let created = 0;
			let known = 0;
			const lines: string[] = [];
			for (const endpoint of report.endpoints) {
				const published = await blackboard.publish({ category: "endpoint", target: endpoint.path, data: endpointBoardData(endpoint), discoveredBy: session.sessionId });
				if (published.created) {
					created += 1;
					if (lines.length < 15) lines.push(`+ ${endpoint.method === null ? "ruta" : endpoint.method} ${endpoint.path}${endpoint.params.length === 0 ? "" : ` (${endpoint.params.join(", ")})`}`);
				} else known += 1;
			}
			for (const secret of report.secrets) {
				// A secret value never enters the blackboard: it is recorded by location and pattern only.
				await session.evidence({ action: "append", kind: "recon-note", payload: { secret: secret.location, pattern: secret.pattern, from: "bounty_surface" } });
				lines.push(`! secreto en ${secret.location}: ${secret.pattern}`);
			}

			const body = [summarizeSurface(report), `Archivo: ${relative}`, `Pizarra: ${created} nuevo(s), ${known} ya conocido(s)`, "", ...lines].join("\n");
			const secretNote = report.secrets.length === 0 ? "" : `\n\nUn secreto de un tercero se registra SIEMPRE como hallazgo sensible (bounty_finding, sensitive: true) y no se usa para autenticarse. El valor no está en la pizarra: quedó en el archivo.`;
			return text(`${body}${secretNote}`, { ok: true, endpoints: report.endpoints.length, secrets: report.secrets.length, created, known, dropped: report.dropped });
		},
	});

	pi.registerTool({
		name: "bounty_session",
		label: "Bounty role sessions",
		description:
			"List the role sessions the operator loaded for this program (action=list) or check one (action=check). It reports header NAMES, timestamps and warnings, never a value. A role is used as bounty_run role=<name>; the credential is injected through a private file, never argv.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				action: { type: "string", enum: ["list", "check"] },
				role: { type: "string", description: "For check: the role to inspect." },
			},
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const roles = createRoleStore({ workspace: session.paths.workspace });

			if (params.action === "list") {
				const list = await roles.list();
				if (list.length === 0) {
					return text(
						`No hay roles cargados. El operador crea work/${resolved.program}/sessions/<rol>.headers con un archivo plano (\`Name: value\` por línea, 0600). Roles típicos: anonymous, user-a, user-b, admin. No se inventa una sesión: sin archivo, no hay rol.`,
						{ ok: true, count: 0 },
					);
				}
				const lines = list.map(
					(info) =>
						`- ${info.role} · ${info.headerNames.length === 0 ? "sin headers" : info.headerNames.join(", ")} · ${info.updatedAt === null ? "sin fecha" : info.updatedAt}${info.warnings.length === 0 ? "" : ` · ${info.warnings.join("; ")}`}`,
				);
				return text(`Roles cargados:\n${lines.join("\n")}\n\nSe usan con bounty_run role=<rol>. Los valores nunca salen de su archivo.`, { ok: true, count: list.length });
			}

			if (params.role === undefined) return text("Falta el rol para revisar.", { ok: false });
			let role: string;
			try {
				role = normalizeRoleName(String(params.role));
			} catch (error) {
				return text((error as Error).message, { ok: false });
			}
			const parsed = await roles.read(role);
			if (parsed === null) {
				return text(`El rol "${role}" no existe: falta work/${resolved.program}/sessions/${role}.headers. Lo escribe el operador, no el agente.`, { ok: false });
			}
			const warnings = parsed.headers.length === 0 ? ["vacío"] : [];
			const names = [...new Set(parsed.headers.map((header) => header.name))];
			const hasAuth = names.some((name) => /^(cookie|authorization)$/i.test(name));
			if (!hasAuth) warnings.push("no tiene Cookie ni Authorization: probablemente no autentique nada");
			return text(
				`Rol ${role}: ${names.join(", ")}\nArchivo: sessions/${role}.headers · ${parsed.headers.length} header(s)${warnings.length === 0 ? " · sin avisos" : `\nAvisos: ${warnings.join("; ")}`}`,
				{ ok: true, role, headerNames: names, warnings },
			);
		},
	});

	pi.registerTool({
		name: "bounty_blackboard",
		label: "Bounty blackboard",
		description:
			"Shared blackboard of the program. publish a structural discovery (idempotent by category+target+data, and it is logged as a recon-note in the evidence chain), query by category/target, claim an artifact before working on it, release it, or since a timestamp to see what the swarm found. The author is this session, never the text you pass.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				action: { type: "string", enum: ["publish", "query", "claim", "release", "since"] },
				category: { type: "string", enum: ["endpoint", "hidden_param", "auth_schema", "header_anomaly", "tech_fingerprint", "state_invariant"] },
				target: { type: "string", description: "The normalized host or URL the artifact is about." },
				data: { type: "object", description: "Small structured hint (≤4KB). Raw bytes belong in bounty_evidence." },
				id: { type: "string", description: "Artifact id, for claim/release." },
				ttl_ms: { type: "number", description: "Lease length for claim. Default 10 minutes." },
				ts: { type: "string", description: "For since: ISO timestamp; return artifacts newer than it." },
				limit: { type: "number", description: "For query: maximum artifacts to return." },
			},
			required: ["program", "action"],
		},
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const result = await runBlackboardAction(session.blackboard, session.sessionId, {
				action: params.action as BlackboardAction,
				...(params.category === undefined ? {} : { category: params.category as never }),
				...(params.target === undefined ? {} : { target: String(params.target) }),
				...(params.data === undefined ? {} : { data: params.data as Record<string, unknown> }),
				...(params.id === undefined ? {} : { id: String(params.id) }),
				...(params.ttl_ms === undefined ? {} : { ttlMs: Number(params.ttl_ms) }),
				...(params.ts === undefined ? {} : { ts: String(params.ts) }),
				...(params.limit === undefined ? {} : { limit: Number(params.limit) }),
			});
			// S4: a new artifact is also a recon-note, so the discovery is in the chain of custody too.
			let evidenceNote = "";
			if (result.ok && result.details.created === true) {
				const recorded = await session.evidence({
					action: "append",
					kind: "recon-note",
					payload: { artifact: result.details.id, category: params.category, target: params.target, data: params.data ?? {}, from: "bounty_blackboard" },
				});
				evidenceNote = recorded.ok ? "\nAnotado en la cadena como recon-note." : `\nNo pude anotarlo en la cadena: ${recorded.text}`;
			}
			return text(`${result.text}${evidenceNote}`, { ok: result.ok, ...result.details });
		},
	});

	pi.registerTool({
		name: "bounty_swarm",
		label: "Bounty swarm",
		description:
			"Launch complementary subagents over the same program: each role gets one perspective, its own tool allowlist and its own session, and publishes what it finds on the board. The parent bounds how many run at once and the aggregate tool-call budget, and aggregates their discoveries. Roles: recon-surface, authz-matrix, js-analyst, schema-auditor, skeptic.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				roles: {
					type: "array",
					items: { type: "string", enum: Object.keys(SWARM_ROLES) },
					description: "Complementary roles. Repeating a role is refused: that is redundancy, not coverage.",
				},
				focus: { type: "string", description: "Optional one-line focus for this run, e.g. the endpoint or surface to look at." },
				max_parallel: { type: "number", description: "How many children run at once. Default 3; more does not go faster against a shared rate." },
				budget_tool_calls: { type: "number", description: "Aggregate tool calls across the whole swarm. Default 1200; when spent, the remaining roles are not launched." },
			},
			required: ["program", "roles"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const program = resolved.program;
			const requested = Array.isArray(params.roles) ? params.roles.map((role) => String(role).trim()).filter((role) => role.length > 0) : [];
			const catalog = Object.keys(SWARM_ROLES).join(", ");
			if (requested.length === 0) return text(`Falta el enjambre: elegí al menos un rol. Roles disponibles: ${catalog}.`, { ok: false });
			const unknown = requested.filter((role) => !(role in SWARM_ROLES));
			if (unknown.length > 0) return text(`Rol desconocido: ${unknown.join(", ")}. Roles disponibles: ${catalog}.`, { ok: false });

			const session = await sessionFor(program);
			const specs = requested.map((role) => ({ role, task: SWARM_ROLES[role]?.brief ?? "", tools: [...(SWARM_ROLES[role]?.tools ?? [])] }));
			const blackboard = createSharedBlackboard({ dir: session.paths.workspace, program: resolved.program });
			const cursor = (await board.state()).headSeq;
			const scopePath = session.paths.scopeFile() ?? join(root, "work", program, "scope.yaml");
			const focus = typeof params.focus === "string" ? params.focus : undefined;
			const timeoutMs = config?.budget?.maxWallMs ?? 15 * 60 * 1000;
			const runner = createPiRunner({
				piCommand: process.env.GENTLE_BOUNTY_PI ? [process.env.GENTLE_BOUNTY_PI] : ["pi"],
				extensionEntry: fileURLToPath(import.meta.url),
				defaultTimeoutMs: timeoutMs,
			});

			const run = await runSwarm(
				{
					roles: specs,
					...(params.max_parallel === undefined ? {} : { maxParallel: Number(params.max_parallel) }),
					...(params.budget_tool_calls === undefined ? {} : { budgetToolCalls: Number(params.budget_tool_calls) }),
				},
				{
					run: async (spec) => {
						const result = await runner.run({
							agent: { name: `bounty-${spec.role}`, tools: spec.tools },
							task: swarmTaskFor(spec, { program, scopePath, ...(focus === undefined ? {} : { focus }) }),
							cwd: root,
							env: { GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PROGRAM: program },
							timeoutMs,
						});
						return {
							ok: result.ok,
							output: result.output,
							toolCalls: result.toolCalls.length,
							durationMs: result.durationMs,
							sessionId: result.sessionId,
							...(result.error === undefined ? {} : { error: result.error }),
						};
					},
				},
			);

			const fresh = await runBlackboardAction(blackboard, session.sessionId, { action: "since", ts: head });
			return text(`${summarizeSwarm(run)}\n\nPizarra:\n${fresh.text}`, {
				ok: run.results.every((result) => result.status === "skipped" || result.ok),
				toolCalls: run.toolCalls,
				stoppedByBudget: run.stoppedByBudget,
			});
		},
	});

	pi.registerTool({
		name: "bounty_finding",
		label: "Bounty finding",
		description:
			"Create, update, list, or resolve a finding by human criterion. States: candidate → verified → reported | duplicate | rejected | dismissed | disputed. resolve requires the human's dialog and a written reason; it is not a verifier verdict.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				action: { type: "string", enum: ["create", "update", "list", "resolve"] },
				id: { type: "string" },
				title: { type: "string" },
				class: { type: "string" },
				endpoint: { type: "string" },
				parameter: { type: "string" },
				state: { type: "string", enum: ["candidate", "verified", "disputed", "reported", "duplicate", "rejected", "dismissed"] },
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				sensitive: { type: "boolean" },
				reason: { type: "string" },
				reason_source: { type: "string", enum: ["human-verbatim", "agent"] },
			},
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params, _signal, _update, context) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const confirm = humanAsk(context as UiContext | undefined, "Resolver por criterio", "Esto no es un veredicto del verificador: es tu criterio, y queda escrito.");
			const result = await session.finding({
				action: params.action as "create" | "update" | "list" | "resolve",
				...(confirm === undefined ? {} : { confirm }),
				...(process.env.GENTLE_BOUNTY_NIGHT_MODE === "1" ? {} : {}),
				...(params.id === undefined ? {} : { id: String(params.id) }),
				...(params.title === undefined ? {} : { title: String(params.title) }),
				...(params.class === undefined ? {} : { class: String(params.class) }),
				...(params.endpoint === undefined ? {} : { endpoint: String(params.endpoint) }),
				...(params.parameter === undefined ? {} : { parameter: String(params.parameter) }),
				...(params.state === undefined ? {} : { state: params.state as "candidate" }),
				...(params.reason_source === undefined ? {} : { reasonSource: params.reason_source as "human-verbatim" | "agent" }),
				...(params.confidence === undefined ? {} : { confidence: params.confidence as "medium" }),
				...(params.sensitive === undefined ? {} : { sensitive: params.sensitive === true }),
				...(params.reason === undefined ? {} : { reason: String(params.reason) }),
			});
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_phase",
		label: "Bounty phase",
		description: "Move the program to one of the seven phases and rewrite work/<program>/status.md.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				phase: {
					type: "string",
					enum: ["scope", "recon", "hypothesis", "validate", "triage", "report", "close"],
				},
				next_step: { type: "string" },
			},
			required: ["program", "phase"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const result = await session.phase({
				phase: params.phase as BountyPhase,
				...(params.next_step === undefined ? {} : { nextStep: String(params.next_step) }),
			});
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_stop",
		label: "Bounty stop",
		description: "Emergency stop: kills every process launched by bounty_run and records it in the evidence chain.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { program: { type: "string" }, reason: { type: "string" } },
			required: ["program"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const result = await sessionFor(resolved.program).stop(String(params.reason ?? "pedido del humano"));
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_verify",
		label: "Bounty verify",
		description:
			"Launch the independent verifier for a finding: it gets only the id and the artifacts, reproduces through bounty_run, and returns a structured verdict that the code applies. You cannot mark a finding verified yourself.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { program: { type: "string" }, finding_id: { type: "string" } },
			required: ["program", "finding_id"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const program = resolved.program;
			const findingId = String(params.finding_id);
			const session = await sessionFor(program);
			const asset = await readFile(join(assetsDir, "agents", "bounty-verify.md"), "utf8");
			const tools = (/^tools:\s*(.+)$/m.exec(asset)?.[1] ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
			const store = createEvidenceStore(session.paths.evidenceDir, { now: () => Date.now() });
			// S76/task 1: the task names the program and the absolute scope path, and the child gets the
			// same name in its environment, which is also the only program its tools will accept.
			const scopePath = session.paths.scopeFile() ?? join(root, "work", program, "scope.yaml");
			const task = verifierTaskFor({ id: findingId }, await store.read(), { program, scopePath });
			const timeoutMs = config?.budget?.maxWallMs ?? 15 * 60 * 1000;
			const runner = createPiRunner({
				piCommand: process.env.GENTLE_BOUNTY_PI ? [process.env.GENTLE_BOUNTY_PI] : ["pi"],
				extensionEntry: fileURLToPath(import.meta.url),
				defaultTimeoutMs: timeoutMs,
			});
			const result = await runner.run({
				agent: { name: "bounty-verify", tools },
				task,
				cwd: root,
				env: { GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PROGRAM: program },
				timeoutMs,
			});
			const verdict = parseVerdict(result.output);
			const applied = await session.applyVerifierVerdict({
				findingId,
				verdict: verdict?.verdict ?? null,
				seqs: verdict?.seqs ?? [],
				reason: verdict?.reason ?? "",
				verifierSessionId: result.sessionId,
				invocationToken: result.invocationToken,
			});
			const declared = verdict === null ? "ILEGIBLE" : verdict.verdict;
			const header = [
				`Veredicto del verificador: ${declared}`,
				`Veredicto efectivo: ${applied.effective ?? "INCONCLUSO"}${applied.converted ? " (convertido por el código)" : ""}`,
				`Hallazgo: ${applied.state ?? "sin cambios"}`,
			].join(" · ");
			return text(
				`${header}\n${applied.text}\n\nVerificador: exit=${String(result.exitCode)} · ${Math.round(result.durationMs / 1000)}s · tools: ${result.activeTools.join(", ") || "(ninguna)"}`,
				{ ok: applied.ok },
			);
		},
	});

	pi.registerTool({
		name: "bounty_recon",
		label: "Bounty phase 0",
		description:
			"Phase 0: run subfinder, then httpx, and keep only the live hosts (2xx/3xx/401/403) as the target list. Both tools go through the gate and the rate; the clean subset lands in work/<program>/alive-hosts.json and as recon-intelligence. With background: true it runs as a separate job and returns at once, so a long enumeration does not block the session.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				domain: { type: "string", description: "The in-scope domain to enumerate." },
				background: { type: "boolean", description: "Run as a separate job (work/<program>/jobs/) and return the job id. Consult it with bounty_job." },
			},
			required: ["program", "domain"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const program = resolved.program;
			const session = await sessionFor(program);
			const domain = String(params.domain);

			if (params.background === true) {
				const jobs = createJobStore({ workspace: session.paths.workspace });
				const job = await jobs.create({ kind: "recon", program, subject: domain });
				const script = fileURLToPath(new URL("../scripts/recon-job.ts", import.meta.url));
				const scopePath = session.paths.scopeFile() ?? join(root, "work", program, "scope.yaml");
				const child = spawn(process.execPath, ["--experimental-strip-types", script, program, domain, job.id, scopePath], {
					cwd: root,
					detached: true,
					stdio: "ignore",
					env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PROGRAM: program },
				});
				child.unref();
				return text(
					`Recon en segundo plano: job ${job.id} (${domain}).\nSigue con otra cosa y consultá el resultado con bounty_job { program: "${program}", action: "status", id: "${job.id}" }. El job carga el alcance ya confirmado, respeta el ritmo y escribe en la misma cadena.`,
					{ ok: true, job: job.id },
				);
			}

			const result = await session.reconPipeline({ domain });
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_job",
		label: "Bounty jobs",
		description:
			"List the program's background jobs (action=list) or read one (action=status, id). A job left running by a killed process is reported as failed, never as alive.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				action: { type: "string", enum: ["list", "status"] },
				id: { type: "string", description: "For status: the job id, J-<stamp>-<hex>." },
			},
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const jobs = createJobStore({ workspace: session.paths.workspace });

			if (params.action === "list") {
				const list = await listJobs(jobs, Date.now());
				if (list.length === 0) return text("No hay jobs en este programa.", { ok: true, count: 0 });
				return text(list.map(renderJob).join("\n"), { ok: true, count: list.length });
			}

			if (params.id === undefined) return text("Falta el id del job.", { ok: false });
			const job = await jobs.read(String(params.id));
			if (job === null) return text(`No existe el job ${String(params.id)}.`, { ok: false });
			return text(renderJob(job), { ok: job.state !== "failed" });
		},
	});

	pi.registerTool({
		name: "bounty_pending",
		label: "Bounty pending destructive",
		description:
			"Read the queue of destructive actions nobody could approve (action=list) or ask the read-only annotator for a plain-language risk note on each item (action=annotate). The queue is never an authorization: it is resolved by the human with a real keystroke.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { program: { type: "string" }, action: { type: "string", enum: ["list", "annotate"] } },
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			if (params.action === "list") {
				const items = await session.pendingQueue.list();
				if (items.length === 0) return text("No hay acciones destructivas pendientes.", { ok: true });
				return text(
					items
						.map((item) => `${item.id} · ${item.resolution === undefined ? "pendiente" : item.resolution.outcome} · ${item.tool} ${item.argv.join(" ")} · ${item.reason}${item.annotation === undefined ? "" : ` · riesgo ${item.annotation.risk} (opinión, no aprobación)`}`)
						.join("\n"),
					{ ok: true },
				);
			}
			// The annotator is read-only and only writes notes: it cannot approve anything.
			const asset = await readFile(join(assetsDir, "agents", "bounty-annotate.md"), "utf8");
			const tools = (/^tools:\s*(.+)$/m.exec(asset)?.[1] ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
			const pending = await session.pendingQueue.pending();
			if (pending.length === 0) return text("No hay acciones destructivas pendientes: no hay nada que anotar.", { ok: true });
			// S92: the annotator must know whether this is a lab; on a real program, approve is the
			// exception and hold is the default.
			const scopeText = await readFile(join(root, "work", resolved.program, "scope.yaml"), "utf8").catch(() => "");
			const isLab = /^lab:\s*true\s*$/m.test(scopeText);
			const runner = createPiRunner({
				piCommand: process.env.GENTLE_BOUNTY_PI ? [process.env.GENTLE_BOUNTY_PI] : ["pi"],
				extensionEntry: fileURLToPath(import.meta.url),
				defaultTimeoutMs: 10 * 60 * 1000,
			});
			const result = await runner.run({
				agent: { name: "bounty-annotate", tools },
				task: [
					"Leé la cola de acciones destructivas pendientes y anotá cada ítem. Devolvé SOLO un array JSON, sin texto alrededor.",
					`Archivo: ${session.pendingQueue.file()}`,
					'Forma: [{"id":"P-0001","risk":"low|medium|high","touchesThirdPartyData":"no|yes|plausible","financialEffect":"no|yes|plausible","irreversible":true|false,"whatCouldHappen":"...","recommendation":"approve|hold|discard","note":"..."}]',
					"Tu salida es una OPINIÓN para que el humano decida más rápido, nunca una aprobación. No ejecutes nada.",
					isLab
						? "Este programa está marcado lab: true (laboratorio propio)."
						: "Este programa NO es un laboratorio (lab: false): la recomendación por defecto es hold; approve solo si tu nota justifica explícitamente por qué es tan inofensiva como una de laboratorio.",
				].join("\n"),
				cwd: root,
				env: { GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PROGRAM: resolved.program },
				timeoutMs: 10 * 60 * 1000,
			});
			// S91: models repeat their answer; take the last complete array instead of failing.
			const list = extractJsonArray<Record<string, unknown>>(result.output);
			if (list === null) return text(`El anotador no devolvió un array JSON legible. Salida: ${result.output.slice(0, 200)}`, { ok: false });
			const written: string[] = [];
			for (const record of list) {
				if (typeof record.id !== "string") continue;
				const item = pending.find((candidate) => candidate.id === record.id);
				if (item === undefined) continue;
				await session.pendingQueue.annotate(record.id, {
					at: new Date().toISOString(),
					risk: record.risk === "high" || record.risk === "medium" ? record.risk : "low",
					touchesThirdPartyData: triState(record.touchesThirdPartyData),
					financialEffect: triState(record.financialEffect),
					irreversible: record.irreversible === true,
					whatCouldHappen: String(record.whatCouldHappen ?? ""),
					recommendation: record.recommendation === "approve" || record.recommendation === "discard" ? record.recommendation : "hold",
					note: String(record.note ?? ""),
				});
				written.push(record.id);
			}
			return text(
				`Anotados ${written.length} ítem(s): ${written.join(", ")}. Esto es una opinión, no una aprobación: la decisión es del humano.`,
				{ ok: true },
			);
		},
	});

	pi.registerTool({
		name: "bounty_report",
		label: "Bounty report",
		description:
			"Write the canonical report for a verified finding. Takes the CVSS v4.0 base metrics (never a score: the score is computed), validates against the checklist and writes work/<program>/reports/<id>.md. It never sends anything to a platform.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				finding_id: { type: "string" },
				metrics: {
					type: "object",
					description: "CVSS v4.0 base metrics: AV, AC, AT, PR, UI, VC, VI, VA, SC, SI, SA.",
				},
				summary: { type: "string" },
				steps: { type: "array", items: { type: "string" } },
				impact: { type: "string" },
				remediation: { type: "string" },
				cwe: { type: "string" },
				sensitive_data: { type: "string" },
			},
			required: ["program", "finding_id", "metrics"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const metrics = (params.metrics ?? {}) as Record<string, string>;
			const result = await session.report({
				findingId: String(params.finding_id),
				metrics,
				...(params.summary === undefined ? {} : { summary: String(params.summary) }),
				...(Array.isArray(params.steps) ? { steps: params.steps.map(String) } : {}),
				...(params.impact === undefined ? {} : { impact: String(params.impact) }),
				...(params.remediation === undefined ? {} : { remediation: String(params.remediation) }),
				...(params.cwe === undefined ? {} : { cwe: String(params.cwe) }),
				...(params.sensitive_data === undefined ? {} : { sensitiveData: String(params.sensitive_data) }),
			});
			return text(result.text, { ok: result.ok });
		},
	});

	pi.registerTool({
		name: "bounty_status",
		label: "Bounty status",
		description: "Return the same plain-language summary that work/<program>/status.md contains.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { program: { type: "string" } },
			required: ["program"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const result = await (await sessionFor(resolved.program)).status();
			return text(result.text, { ok: result.ok });
		},
	});
}
