#!/usr/bin/env node
/**
 * Main-session launcher (S34).
 *
 * The child runner is not the only thing that needs a tool allowlist: the session that *loads* this
 * extension is the one with the most opportunity to misbehave. This launcher starts it with the same
 * restrictions the children get: no MCP unless the operator opts in, no other extensions, and an
 * explicit tool allowlist with no shell, no generic fetch and no write.
 *
 *   bin/gentle-bounty <program> [--check] [--probe <file>] [-- <extra pi args>]
 *
 * `--check` prints the exact argv and cwd without launching anything: that is the deterministic
 * inspection path. The live tool list is checked by scripts/tools-probe.ts during a real run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAIN_SESSION_TOOLS = [
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
	"bounty_stop",
];

const FORBIDDEN = /bash|shell|exec|terminal|fetch|http|web|write|edit|\*/i;

export function buildLaunch({ program, root, probeFile, approvedMcp, extra = [] }) {
	if (!program || program.includes("/") || program.includes("..")) {
		throw new Error("a program name is required and must not contain a path separator");
	}
	for (const tool of MAIN_SESSION_TOOLS) {
		if (FORBIDDEN.test(tool)) throw new Error(`refusing to launch: allowlist contains ${tool}`);
	}
	const workDir = join(process.cwd(), "work", program);
	const args = [];
	if (!approvedMcp || approvedMcp.length === 0) {
		// MCP stays the operator's decision: without an explicit opt-in, no MCP server is reachable.
		args.push("--no-mcp");
	}
	args.push("-ne", "-e", join(root, "extensions", "bounty.ts"));
	if (probeFile) args.push("-e", resolve(probeFile));
	args.push("--tools", MAIN_SESSION_TOOLS.join(","), ...extra);
	return {
		command: "pi",
		args,
		cwd: workDir,
		env: {
			GENTLE_BOUNTY_ROOT: process.cwd(),
			GENTLE_BOUNTY_PROGRAM: program,
			...(probeFile ? { GENTLE_BOUNTY_PROBE_FILE: resolve(probeFile) } : {}),
		},
	};
}

function main(argv) {
	const check = argv.includes("--check");
	const probeIndex = argv.indexOf("--probe");
	const probeFile = probeIndex >= 0 ? argv[probeIndex + 1] : undefined;
	const passthroughIndex = argv.indexOf("--");
	const passthrough = passthroughIndex >= 0 ? argv.slice(passthroughIndex + 1) : [];
	const positional = argv.filter((arg, index) => {
		if (arg.startsWith("--")) return false;
		if (probeIndex >= 0 && index === probeIndex + 1) return false;
		if (passthroughIndex >= 0 && index > passthroughIndex) return false;
		return true;
	});
	const program = positional[0];
	if (!program) {
		console.error("usage: gentle-bounty <program> [--check] [--probe <file>] [-- <pi args>]");
		process.exit(2);
	}
	const approvedMcp = (process.env.GENTLE_BOUNTY_MCP ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	let launch;
	try {
		launch = buildLaunch({ program, root: packageRoot, probeFile, approvedMcp, extra: passthrough });
	} catch (error) {
		console.error(`gentle-bounty: ${error.message}`);
		process.exit(2);
	}

	mkdirSync(launch.cwd, { recursive: true });

	if (check) {
		console.log(JSON.stringify({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env, tools: MAIN_SESSION_TOOLS }, null, 2));
		return;
	}

	const result = spawnSync(launch.command, launch.args, {
		cwd: launch.cwd,
		stdio: "inherit",
		env: { ...process.env, ...launch.env },
	});
	if (result.error) {
		console.error(`gentle-bounty: could not start pi: ${result.error.message}`);
		process.exit(127);
	}
	process.exit(result.status ?? 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
