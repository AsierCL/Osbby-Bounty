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
import { resolveCname } from "node:dns/promises";
import { isIP } from "node:net";

import { createSession, type ProgramSession, type ToolExecution } from "../src/pi/session.ts";
import { loadGlobalConfig, type GlobalConfig } from "../src/core/config.ts";
import { buildDomainPrompt } from "../src/pi/prompt.ts";
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

/** DNS answer for the gate: no CNAME record is a valid answer, a resolver failure is not. */
async function resolveForGate(host: string): Promise<{ cname: string[] } | { error: string }> {
	if (isIP(host) !== 0 || host === "localhost") return { cname: [] };
	try {
		return { cname: await resolveCname(host) };
	} catch (error) {
		const code = (error as { code?: string }).code ?? "unknown";
		if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOTIMP") return { cname: [] };
		return { error: code };
	}
}

function runProcess(argv: string[], cwd: string): Promise<ToolExecution> {
	return new Promise((resolve) => {
		const [command, ...args] = argv;
		if (!command) return resolve({ exitCode: 127, stdout: "", stderr: "no command" });
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

	async function sessionFor(program: string): Promise<ProgramSession> {
		const existing = sessions.get(program);
		if (existing) return existing;
		const created = createSession(
			{
				root,
				program,
				redaction: config?.redaction ?? redactionMode(),
				budget: config?.budget,
				// S66: the verifier runs in its own process and is launched with this flag.
				verifier: process.env.GENTLE_BOUNTY_VERIFIER === "1",
			},
			{
				dns: resolveForGate,
				readFile: (path) => readFile(path, "utf8"),
				runTool: (argv) => runProcess(argv, root),
				// Fallback when a tool is invoked without a UI context: no confirmation means no.
				confirm: async () => false,
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
			const session = await sessionFor(String(params.program));
			// S63: the model's `confirm` flag is not an answer. Only the human UI is.
			const ui = context?.ui;
			const confirm =
				typeof ui?.confirm === "function"
					? async (question: string) => Boolean(await ui.confirm("Confirmar alcance", question))
					: undefined;
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
			const session = await sessionFor(String(params.program));
			// Verified in docs/extensions.md:84 and :197 — `await ctx.ui.confirm(title, message)`.
			// The stub decision lives in the session, which knows whether the scope is a lab (S47).
			const ui = context?.ui;
			const confirm =
				typeof ui?.confirm === "function"
					? async (question: string) => Boolean(await ui.confirm("Confirmar acción destructiva", question))
					: undefined;
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
			const session = await sessionFor(String(params.program));
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
				state: { type: "string", enum: ["candidate", "verified", "reported", "duplicate", "rejected"] },
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				sensitive: { type: "boolean" },
				reason: { type: "string" },
			},
			required: ["program", "action"],
		} as never,
		async execute(_toolCallId, params) {
			const session = await sessionFor(String(params.program));
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
			const session = await sessionFor(String(params.program));
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
			const result = await sessionFor(String(params.program)).stop(String(params.reason ?? "pedido del humano"));
			return text(result.text, { ok: result.ok });
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
			},
			required: ["program", "finding_id", "metrics"],
		} as never,
		async execute(_toolCallId, params) {
			const session = await sessionFor(String(params.program));
			const metrics = (params.metrics ?? {}) as Record<string, string>;
			const result = await session.report({
				findingId: String(params.finding_id),
				metrics,
				...(params.summary === undefined ? {} : { summary: String(params.summary) }),
				...(Array.isArray(params.steps) ? { steps: params.steps.map(String) } : {}),
				...(params.impact === undefined ? {} : { impact: String(params.impact) }),
				...(params.remediation === undefined ? {} : { remediation: String(params.remediation) }),
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
			const result = await (await sessionFor(String(params.program))).status();
			return text(result.text, { ok: result.ok });
		},
	});
}
