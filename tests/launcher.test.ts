/**
 * S34: the launcher's argv is the deterministic part of the main-session guarantee. The live tool
 * list is probed separately during a real run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = new URL("../bin/gentle-bounty.mjs", import.meta.url).pathname;

function check(program: string, extra: string[] = [], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [LAUNCHER, program, "--check", ...extra], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("the main session gets an explicit allowlist with no shell, fetch or write", () => {
	const launch = check("lab");
	assert.equal(launch.command, "pi");
	assert.ok(launch.args.includes("--no-mcp"), "MCP must be off unless the operator opts in");
	assert.ok(launch.args.includes("-ne"), "other extensions must not load");
	assert.ok(launch.tools.includes("bounty_scope"));
	assert.ok(launch.args.join(" ").includes("bounty_scope"));
	for (const forbidden of ["bash", "shell", "fetch", "web_search", "write", "edit", "*"]) {
		assert.ok(!launch.args.join(" ").includes(forbidden), `launcher allowlist leaked ${forbidden}`);
	}
});

test("the package extension is loaded and the cwd is the program work dir", () => {
	const launch = check("lab");
	const entryIndex = launch.args.indexOf("-e");
	assert.ok(entryIndex >= 0);
	assert.match(launch.args[entryIndex + 1], /extensions\/bounty\.ts$/);
	assert.match(launch.cwd, /work\/lab$/);
	assert.equal(launch.env.GENTLE_BOUNTY_PROGRAM, "lab");
});

test("a probe extension can be added for the live tool inspection", () => {
	const launch = check("lab", ["--probe", "scripts/tools-probe.ts"]);
	const entries = launch.args.reduce((acc: string[], arg: string, index: number) => {
		if (arg === "-e") acc.push(launch.args[index + 1]);
		return acc;
	}, []);
	assert.equal(entries.length, 2);
	assert.match(entries[1], /tools-probe\.ts$/);
});

test("an approved MCP list omits --no-mcp, because that is the operator's decision", () => {
	const launch = check("lab", [], { GENTLE_BOUNTY_MCP: "burp" });
	assert.ok(!launch.args.includes("--no-mcp"));
});

test("a program name with a path separator is refused", () => {
	const result = spawnSync(process.execPath, [LAUNCHER, "../escape", "--check"], { encoding: "utf8" });
	assert.equal(result.status, 2);
});
