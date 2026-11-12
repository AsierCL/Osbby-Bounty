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
import { spawn } from "node:child_process";
import { resolveCname } from "node:dns/promises";
import { isIP } from "node:net";

import { createSession, type ProgramSession, type ToolExecution } from "../src/pi/session.ts";
import type { BountyPhase } from "../src/core/status.ts";
import type { RedactionMode } from "../src/core/redact.ts";

interface PiToolContext {
	ui?: { confirm?: (title: string, message?: string) => Promise<boolean> };
	cwd?: string;
}

interface PiLike {
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

export default function bountyExtension(pi: PiLike): void {
	const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
	const sessions = new Map<string, ProgramSession>();

	function sessionFor(program: string): ProgramSession {
		const existing = sessions.get(program);
		if (existing) return existing;
		const created = createSession(
			{ root, program, redaction: redactionMode() },
			{
				dns: resolveForGate,
				readFile: (path) => readFile(path, "utf8"),
				runTool: (argv) => runProcess(argv, root),
				// No confirmation UI means no confirmation: a destructive action is refused, never assumed.
				confirm: async (question) => {
					const ui = (globalThis as { __piToolContext?: PiToolContext }).__piToolContext?.ui;
					if (typeof ui?.confirm !== "function") return false;
					return Boolean(await ui.confirm("Confirmar acción destructiva", question));
				},
			},
		);
		sessions.set(program, created);
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
		async execute(_toolCallId, params) {
			const session = sessionFor(String(params.program));
			const result = await session.scope({ file: String(params.file), confirm: params.confirm === true });
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
		async execute(_toolCallId, params) {
			const session = sessionFor(String(params.program));
			const result = await session.run({
				tool: String(params.tool),
				args: Array.isArray(params.args) ? params.args.map(String) : [],
				target: String(params.target),
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
			const session = sessionFor(String(params.program));
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
			const session = sessionFor(String(params.program));
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
			const session = sessionFor(String(params.program));
			const result = await session.phase({
				phase: params.phase as BountyPhase,
				...(params.next_step === undefined ? {} : { nextStep: String(params.next_step) }),
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
			const result = await sessionFor(String(params.program)).status();
			return text(result.text, { ok: result.ok });
		},
	});
}
