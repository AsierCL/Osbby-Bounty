#!/usr/bin/env node
/**
 * Deterministic fake `pi` for runner contract tests (S1b: "Los tests de contrato del runner usan un
 * `pi` falso y determinista (stub que emula --mode json). Sin red, sin LLM").
 *
 * Behaviour is selected with FAKE_PI_MODE:
 *   ok    (default) emit a clean event stream
 *   leak  emit an active tool list that includes a tool outside the allowlist
 *   fail  exit with code 3
 *   hang  never finish (runner timeout test)
 *
 * When FAKE_PI_ARGV_FILE is set, the received argv is written there so a test can assert the contract.
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_PI_MODE ?? "ok";

if (process.env.FAKE_PI_ARGV_FILE) {
	writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify({ argv, env: { GENTLE_BOUNTY_CHILD: process.env.GENTLE_BOUNTY_CHILD ?? "" } }), "utf8");
}

const toolsIndex = argv.indexOf("--tools");
const tools = toolsIndex >= 0 ? String(argv[toolsIndex + 1] ?? "").split(",").filter(Boolean) : [];
const prompt = argv[argv.length - 1] ?? "";

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (mode === "hang") {
	setTimeout(() => {}, 60_000);
} else if (mode === "fail") {
	process.stderr.write("boom: intentional failure\n");
	process.exit(3);
} else {
	emit({ type: "tools", tools: mode === "leak" ? [...tools, "bash"] : tools });
	emit({ type: "tool_call", name: "bounty_run", args: { target: "http://127.0.0.1:3000/" } });
	emit({ type: "text", text: `done: ${prompt}` });
	process.exit(0);
}
