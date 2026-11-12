/**
 * Subagent runner (S30).
 *
 * The whole safety story of the subagents lives in one place: the argv this module builds. A child is
 * spawned as a plain `pi` process with
 *   - an explicit tool allowlist (`--tools`), validated here against a hard set that contains no
 *     shell and no generic fetch (S27a),
 *   - no MCP servers (`--no-mcp`),
 *   - only this extension loaded (`-ne` plus `-e`),
 *   - `--mode json` so its events are machine-readable.
 *
 * The runner never trusts the child's self-description: after the run it checks the reported active
 * tool list against the allowlist and fails closed if the child had anything else (S19a: deterministic
 * inspection, not a question to the model).
 */
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

export type SpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => {
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
};

export interface SubagentSpec {
	name: string;
	/** Allowlist of tool names the child may use. Validated against ALLOWED_CHILD_TOOLS. */
	tools: string[];
	/** Optional extension path(s) to load in the child, beyond this package's own entry point. */
	extensionPaths?: string[];
}

export interface RunRequest {
	agent: SubagentSpec;
	task: string;
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface ReportedToolCall {
	name: string;
}

export interface RunResult {
	ok: boolean;
	agent: string;
	output: string;
	toolCalls: ReportedToolCall[];
	activeTools: string[];
	exitCode: number | null;
	durationMs: number;
	/** D1: identity of the child session, generated here, never by the model. */
	sessionId: string;
	error?: string;
}

export interface PiRunnerOptions {
	/** Command and leading args used to launch Pi. Defaults to `["pi"]`. */
	piCommand?: string[];
	now?: () => number;
	spawn?: SpawnLike;
	defaultTimeoutMs?: number;
	/** Absolute path to this package's extension entry point. */
	extensionEntry?: string;
}

/**
 * Tools a bounty child may ever receive. Read-only inspection plus the six bounty tools that route
 * through the gate. No `bash`, no `write`/`edit`, no generic fetch, no wildcards.
 */
export const ALLOWED_CHILD_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bounty_scope",
	"bounty_run",
	"bounty_evidence",
	"bounty_finding",
	"bounty_phase",
	"bounty_status",
] as const;

const FORBIDDEN_SUBSTRINGS = ["bash", "shell", "exec", "terminal", "fetch", "http", "web", "curl", "wget", "write", "edit"];

export function validateTools(tools: string[]): void {
	if (tools.length === 0) throw new Error("a subagent needs at least one tool in its allowlist");
	for (const tool of tools) {
		if (tool.includes("*")) throw new Error(`wildcards are not allowed in a subagent tool list: ${tool}`);
		if (FORBIDDEN_SUBSTRINGS.some((token) => tool.toLowerCase().includes(token))) {
			throw new Error(`tool ${tool} is a shell, fetch or write capability: bounty subagents never receive it`);
		}
		if (!(ALLOWED_CHILD_TOOLS as readonly string[]).includes(tool)) {
			throw new Error(`tool ${tool} is not in the bounty allowlist (${ALLOWED_CHILD_TOOLS.join(", ")})`);
		}
	}
}

export function buildChildArgs(request: RunRequest, options: PiRunnerOptions = {}): { command: string; args: string[] } {
	validateTools(request.agent.tools);
	const [command, ...leading] = options.piCommand ?? ["pi"];
	if (!command) throw new Error("piCommand is empty");

	const extensions = [options.extensionEntry, ...(request.agent.extensionPaths ?? [])].filter(
		(entry): entry is string => typeof entry === "string" && entry.length > 0,
	);

	const args = [
		...leading,
		"--mode",
		"json",
		"--no-mcp",
		"-ne",
		...extensions.flatMap((entry) => ["-e", entry]),
		"--tools",
		request.agent.tools.join(","),
		request.task,
	];
	return { command, args };
}

function parseEvents(stdout: string): { output: string; toolCalls: ReportedToolCall[]; activeTools: string[] } {
	const texts: string[] = [];
	const toolCalls: ReportedToolCall[] = [];
	let activeTools: string[] = [];

	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			texts.push(trimmed);
			continue;
		}
		if (typeof event !== "object" || event === null) continue;
		const record = event as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type : "";

		if (type === "tools" || type === "tool_list" || type === "active_tools") {
			const list = Array.isArray(record.tools) ? record.tools : Array.isArray(record.activeTools) ? record.activeTools : [];
			activeTools = list.filter((item): item is string => typeof item === "string");
			continue;
		}
		// D2: real Pi nests the assistant text under message_end/agent_end messages.
		if (type === "message_end" || type === "agent_end" || type === "turn_end") {
			const messages = Array.isArray(record.messages)
				? record.messages
				: typeof record.message === "object" && record.message !== null
					? [record.message]
					: [];
			for (const message of messages) {
				if (typeof message !== "object" || message === null) continue;
				const entry = message as Record<string, unknown>;
				if (entry.role !== "assistant") continue;
				const content = Array.isArray(entry.content) ? entry.content : [];
				for (const part of content) {
					if (typeof part === "object" && part !== null && (part as { type?: string }).type === "text") {
						const value = (part as { text?: unknown }).text;
						if (typeof value === "string" && value.length > 0) texts.push(value);
					}
				}
			}
		}

		if (type === "agent_end") {
			// Real Pi reports the enabled tools here, in a system message with `toolsAdded`. This is the
			// authoritative list (S19a/S41): the child's self-description in prose is not.
			const messages = Array.isArray(record.messages) ? record.messages : [];
			const names: string[] = [];
			for (const message of messages) {
				if (typeof message !== "object" || message === null) continue;
				const entry = message as Record<string, unknown>;
				if (entry.role !== "system") continue;
				const added = Array.isArray(entry.toolsAdded) ? entry.toolsAdded : [];
				for (const tool of added) {
					if (typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string") {
						names.push((tool as { name: string }).name);
					} else if (typeof tool === "string") {
						names.push(tool);
					}
				}
			}
			if (names.length > 0) activeTools = names;
			continue;
		}
		if (type === "tool_call" || type === "tool" || type === "tool_use") {
			const name = typeof record.name === "string" ? record.name : typeof record.toolName === "string" ? record.toolName : null;
			if (name) toolCalls.push({ name });
			continue;
		}
		for (const key of ["text", "content", "delta"]) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0) texts.push(value);
		}
	}

	return { output: texts.join("").trim(), toolCalls, activeTools };
}

export interface PiRunner {
	run(request: RunRequest): Promise<RunResult>;
	buildArgs(request: RunRequest): { command: string; args: string[] };
}

export function createPiRunner(options: PiRunnerOptions = {}): PiRunner {
	const now = options.now ?? (() => Date.now());
	const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
	const defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;

	return {
		buildArgs(request) {
			return buildChildArgs(request, options);
		},

		run(request) {
			const started = now();
			const sessionId = randomUUID();
			const { command, args } = buildChildArgs(request, options);
			const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;

			return new Promise<RunResult>((resolve) => {
				let stdout = "";
				let stderr = "";
				let settled = false;
				let timedOut = false;

				const child = spawn(command, args, {
					cwd: request.cwd,
					env: { ...process.env, ...(request.env ?? {}), GENTLE_BOUNTY_CHILD: "1", GENTLE_BOUNTY_SESSION_ID: sessionId },
					stdio: ["ignore", "pipe", "pipe"],
				});

				const finish = (exitCode: number | null, error?: string) => {
					if (settled) return;
					settled = true;
					const parsed = parseEvents(stdout);
					const forbidden = parsed.activeTools.filter((tool) => !request.agent.tools.includes(tool));
					const violation =
						forbidden.length > 0
							? `child reported tools outside its allowlist: ${forbidden.join(", ")}`
							: undefined;
					resolve({
						ok: error === undefined && violation === undefined && exitCode === 0,
						agent: request.agent.name,
						output: parsed.output,
						toolCalls: parsed.toolCalls,
						activeTools: parsed.activeTools,
						exitCode,
						durationMs: now() - started,
						sessionId,
						...(error !== undefined ? { error } : violation !== undefined ? { error: violation } : {}),
					});
				};

				child.stdout?.setEncoding?.("utf8");
				child.stdout?.on("data", (chunk: string | Buffer) => {
					stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
				});
				child.stderr?.setEncoding?.("utf8");
				child.stderr?.on("data", (chunk: string | Buffer) => {
					stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
				});

				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs);

				child.on("error", (error: Error) => {
					clearTimeout(timer);
					finish(null, `failed to launch ${command}: ${error.message}`);
				});
				child.on("close", (code: number | null) => {
					clearTimeout(timer);
					if (timedOut) {
						finish(code, `child exceeded ${timeoutMs}ms and was killed`);
						return;
					}
					if (code !== 0) {
						finish(code, `child exited with ${String(code)}${stderr === "" ? "" : `: ${stderr.trim().slice(0, 400)}`}`);
						return;
					}
					finish(code);
				});
			});
		},
	};
}
