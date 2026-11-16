/**
 * S89/task 3: one worker process for the concurrency check.
 *
 * Usage: node --experimental-strip-types scripts/lib/concurrency-worker.ts <root> <program> <scopePath> <port> <runs>
 * Prints one JSON line with what it did, so the parent can compare.
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { createSession } from "../../src/pi/session.ts";

const [root, program, scopePath, port, runs] = process.argv.slice(2);
if (root === undefined || program === undefined || scopePath === undefined || port === undefined || runs === undefined) {
	console.error("usage: concurrency-worker.ts <root> <program> <scopePath> <port> <runs>");
	process.exit(2);
}

const exec = (argv: string[]) =>
	new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
		const [command, ...args] = argv;
		execFile(command as string, args, (error, stdout, stderr) => {
			resolve({ exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});

const session = createSession(
	{ root, program, sessionId: `worker-${program}-${process.pid}` },
	{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: exec, confirm: async () => true },
);
const scoped = await session.scope({ file: scopePath });
if (!scoped.ok) {
	console.log(JSON.stringify({ program, ok: false, error: scoped.text.slice(0, 200) }));
	process.exit(1);
}

const total = Number(runs);
const started = Date.now();
let executed = 0;
const failures: string[] = [];
for (let index = 0; index < total; index += 1) {
	const result = await session.run({
		tool: "curl",
		args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/api/invoices/1`],
		target: `http://127.0.0.1:${port}/api/invoices/1`,
	});
	if (result.ok) executed += 1;
	else failures.push(result.text.slice(0, 120));
}
console.log(JSON.stringify({ program, ok: true, executed, failed: failures.length, failures: failures.slice(0, 3), elapsedMs: Date.now() - started }));
