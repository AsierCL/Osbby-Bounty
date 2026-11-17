/**
 * The one place a bounty tool process is spawned. It exists so the extension and the background
 * recon job launch binaries with the same PATH policy (B1: the operator's `tool_path`, never the
 * model's words) and the same timeout behaviour.
 */
import { spawn } from "node:child_process";

import type { ToolExecution } from "./session.ts";

export const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

export function runProcess(argv: string[], cwd: string, toolPath: string[] = [], timeoutMs = TOOL_TIMEOUT_MS): Promise<ToolExecution> {
	return new Promise((resolve) => {
		const [command, ...args] = argv;
		if (!command) return resolve({ exitCode: 127, stdout: "", stderr: "no command" });
		const env = toolPath.length === 0 ? process.env : { ...process.env, PATH: [...toolPath, process.env.PATH ?? ""].filter(Boolean).join(":") };
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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
