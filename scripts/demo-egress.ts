/**
 * Demonstrates the egress proxy (S18).
 *
 * Part A — safe, runs by default. All traffic is loopback: curl talks to the proxy, the proxy
 * decides. For the out-of-scope target the proxy refuses **before** dialing, so no packet leaves the
 * machine. Targets use documentation addresses (192.0.2.0/24, RFC 5737) which route nowhere.
 *
 * Part B — opt-in with `--part-b`. Attempts the bypass `curl --noproxy '*'`. Without the OS-level
 * rule from ADR-0003 this is expected to try to leave the host, which is exactly the point: the proxy
 * alone is not enforcement. Run it only after applying the firewall rule.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { createEgressProxy } from "../src/core/proxy.ts";
import { createRateLimiter } from "../src/core/ratelimit.ts";
import { parseScope } from "../src/core/scope.ts";

const OUT_OF_SCOPE = "http://192.0.2.1/in-scope-looking-path";

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

const upstream = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("lab-upstream-ok");
});
const upstreamPort = await new Promise<number>((resolve) => {
	upstream.listen(0, "127.0.0.1", () => {
		const address = upstream.address();
		resolve(typeof address === "object" && address !== null ? address.port : 0);
	});
});

const parsed = parseScope(
	`program: demo\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:${upstreamPort}\nlimits:\n  rate_rps: 5\n`,
);
if (!parsed.ok) {
	console.error("scope did not parse", parsed.errors);
	process.exit(1);
}

const entries: string[] = [];
const proxy = createEgressProxy({
	scope: parsed.policy,
	limiter: createRateLimiter({ defaultRps: 5 }, () => Date.now()),
	log: (entry) => {
		entries.push(`${entry.kind} ${entry.method} ${entry.host}:${entry.port} allowed=${entry.allowed}${entry.reason ? ` reason=${entry.reason}` : ""}`);
	},
});
const proxyPort = await proxy.listen(0, "127.0.0.1");
const proxyUrl = `http://127.0.0.1:${proxyPort}`;

console.log(`proxy listening on ${proxyUrl}`);
console.log(`in scope: 127.0.0.1:${upstreamPort}`);
console.log("");

console.log("--- A1: in-scope request through the proxy (expected: 200 lab-upstream-ok)");
const allowed = await run("curl", ["-sS", "-o", "-", "-w", "\\nHTTP %{http_code}\\n", "-x", proxyUrl, `http://127.0.0.1:${upstreamPort}/ok`]);
console.log(allowed.stdout || allowed.stderr);
console.log("");

console.log(`--- A2: out-of-scope request through the proxy (expected: 403 egress denied)`);
const denied = await run("curl", ["-sS", "-o", "-", "-w", "\\nHTTP %{http_code}\\n", "-x", proxyUrl, OUT_OF_SCOPE]);
console.log(denied.stdout || denied.stderr);
console.log("");

console.log("--- proxy log");
for (const line of entries) console.log(`  ${line}`);
console.log("");

if (process.argv.includes("--part-b")) {
	console.log("--- B: bypass attempt with --noproxy (requires the ADR-0003 firewall rule)");
	console.log("Without the rule this tries to leave the host; with the rule it fails at the firewall.");
	const bypass = await run("curl", ["-sS", "--max-time", "3", "-o", "/dev/null", "-w", "HTTP %{http_code}\\n", "--noproxy", "*", OUT_OF_SCOPE]);
	console.log(bypass.stdout || bypass.stderr);
} else {
	console.log("--- B: skipped (pass --part-b after applying the firewall rule from ADR-0003)");
}

await proxy.close();
upstream.close();
upstream.closeAllConnections?.();
