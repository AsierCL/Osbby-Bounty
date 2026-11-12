#!/usr/bin/env node
/**
 * Opt-in real smoke test (S1b). NOT part of `npm test`: it spawns a real `pi` child, which means a
 * real model call. Prompt is minimal and the workspace is empty: no scope, no target data.
 *
 * Usage: npm run test:live
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "bounty-live-"));
const prompt = "Decime solamente: ok";

const child = spawn(
	"pi",
	["--mode", "json", "--no-mcp", "-ne", "--tools", "read", prompt],
	{ cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});

const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);

child.on("close", async (code) => {
	clearTimeout(timer);
	await rm(dir, { recursive: true, force: true });
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
	let parsed = 0;
	for (const line of lines) {
		try {
			JSON.parse(line);
			parsed += 1;
		} catch {
			/* not an event line */
		}
	}
	console.log(`exit=${code} lines=${lines.length} json_events=${parsed}`);
	if (stderr) console.log(`stderr: ${stderr.slice(0, 400)}`);
	if (code !== 0 || parsed === 0) {
		console.error("smoke failed: a live pi child must exit 0 and emit JSONL events");
		process.exit(1);
	}
	console.log("smoke ok: --mode json produced machine-readable events with a minimal tool allowlist");
});
