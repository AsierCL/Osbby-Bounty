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
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolve4, resolve6, resolveCname } from "node:dns/promises";
import { isIP } from "node:net";

import { createSession, type ProgramSession, type ToolExecution } from "../src/pi/session.ts";
import { loadGlobalConfig, type GlobalConfig } from "../src/core/config.ts";
import { buildDomainPrompt } from "../src/pi/prompt.ts";
import { createPiRunner } from "../src/pi/runner.ts";
import { verifierTaskFor, parseVerdict } from "../src/pi/verifier.ts";
import { createEvidenceStore } from "../src/core/evidence.ts";
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

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

function text(value: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: value }], details };
}

function redactionMode(): RedactionMode {
	return process.env.GENTLE_BOUNTY_REDACTION === "on" ? "on" : "off";
}

/**
 * DNS answer for the gate (S87): the CNAME chain AND the final addresses. No record is a valid
 * answer; a resolver failure is not, and a name with no address is a failure too (fail closed).
 */
async function resolveForGate(host: string): Promise<{ cname: string[]; addresses: string[] } | { error: string }> {
	if (isIP(host) !== 0 || host === "localhost") return { cname: [], addresses: [] };
	const soft = new Set(["ENODATA", "ENOTFOUND", "ENOTIMP", "ESERVFAIL", "EREFUSED"]);
	const codeOf = (error: unknown) => (error as { code?: string }).code ?? "unknown";

	let cname: string[] = [];
	try {
		cname = await resolveCname(host);
	} catch (error) {
		const code = codeOf(error);
		if (!soft.has(code)) return { error: code };
	}

	const addresses: string[] = [];
	for (const resolve of [resolve4, resolve6]) {
		try {
			addresses.push(...(await resolve(host)));
		} catch (error) {
			const code = codeOf(error);
			if (!soft.has(code)) return { error: code };
		}
	}
	if (addresses.length === 0) return { error: `no address records for ${host}` };
	return { cname, addresses };
}

function runProcess(argv: string[], cwd: string, toolPath: string[] = []): Promise<ToolExecution> {
	return new Promise((resolve) => {
		const [command, ...args] = argv;
		if (!command) return resolve({ exitCode: 127, stdout: "", stderr: "no command" });
		// B1: the child PATH is exactly the operator's tool_path plus the inherited PATH. The model
		// never touches it: it comes from .bounty/config.json, which only the human edits.
		const env = toolPath.length === 0
			? process.env
			: { ...process.env, PATH: [...toolPath, process.env.PATH ?? ""].filter(Boolean).join(":") };
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
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
		name: "bounty_finding",
		label: "Bounty finding",
		description: "Create, update or list findings. States: candidate → verified → reported | duplicate | rejected.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				program: { type: "string" },
				action: { type: "string", enum: ["create", "update", "list"] },
				id: { type: "string" },
				title: { type: "string" },
				class: { type: "string" },
				endpoint: { type: "string" },
				parameter: { type: "string" },
				state: { type: "string", enum: ["candidate", "verified", "disputed", "reported", "duplicate", "rejected"] },
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				sensitive: { type: "boolean" },
				reason: { type: "string" },
			},
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params) {
			const resolved = resolveProgram(params.program);
			if (!resolved.ok) return text(resolved.text, { ok: false });
			const session = await sessionFor(resolved.program);
			const result = await session.finding({
				action: params.action as "create" | "update" | "list",
				...(params.id === undefined ? {} : { id: String(params.id) }),
				...(params.title === undefined ? {} : { title: String(params.title) }),
				...(params.class === undefined ? {} : { class: String(params.class) }),
				...(params.endpoint === undefined ? {} : { endpoint: String(params.endpoint) }),
				...(params.parameter === undefined ? {} : { parameter: String(params.parameter) }),
				...(params.state === undefined ? {} : { state: params.state as "candidate" }),
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
