/**
 * Runner contract tests (S30, S19a).
 *
 * Everything here runs against `tests/fixtures/fake-pi.mjs`: a deterministic stub that emulates
 * `--mode json`. No network, no model, no real Pi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildChildArgs, createPiRunner, validateTools, ALLOWED_CHILD_TOOLS, type RunRequest } from "../src/pi/runner.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const ENTRY = "/tmp/gentle-bounty/extensions/bounty.ts";

function request(overrides: Partial<RunRequest> = {}): RunRequest {
	return {
		agent: { name: "bounty-recon", tools: ["read", "grep", "bounty_run"] },
		task: "enumerate in-scope hosts",
		cwd: "/tmp",
		...overrides,
	};
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-runner-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runner(mode: string, argvFile?: string) {
	return createPiRunner({
		piCommand: [process.execPath, FAKE_PI],
		extensionEntry: ENTRY,
		defaultTimeoutMs: 5_000,
		spawn: undefined,
		...(argvFile === undefined ? {} : { env: undefined }),
	} as never);
}

test("the child argv is explicit: json mode, no MCP, no other extensions, tool allowlist", () => {
	const built = buildChildArgs(request(), { extensionEntry: ENTRY });
	assert.equal(built.command, "pi");
	assert.deepEqual(built.args, [
		"--mode",
		"json",
		"--no-mcp",
		"-ne",
		"-ns",
		"-e",
		ENTRY,
		"--tools",
		"read,grep,bounty_run",
		"enumerate in-scope hosts",
	]);
});

test("bash, fetch, write and wildcards are rejected before spawning", () => {
	for (const tools of [["bash"], ["read", "bash"], ["mcp__fetch__url"], ["web_search"], ["write"], ["edit"], ["read", "*"], ["unknown_tool"]]) {
		assert.throws(() => validateTools(tools), /never receive it|wildcards|not in the bounty allowlist/);
	}
});

test("the allowlist itself contains no shell, fetch or write capability", () => {
	for (const tool of ALLOWED_CHILD_TOOLS) {
		assert.doesNotMatch(tool, /bash|shell|exec|fetch|http|web|write|edit/, `allowlist leaked ${tool}`);
	}
});

test("a clean child run reports output and tool calls", async () => {
	const result = await runner("ok").run(request());
	assert.equal(result.ok, true, result.error);
	assert.match(result.output, /done: enumerate in-scope hosts/);
	assert.deepEqual(result.toolCalls.map((call) => call.name), ["bounty_run"]);
	assert.deepEqual(result.activeTools, ["read", "grep", "bounty_run"]);
	assert.equal(result.exitCode, 0);
	assert.equal(result.agent, "bounty-recon");
});

test("the child actually received the argv contract, and the bounty env marker", async () =>
	withTempDir(async (dir) => {
		const argvFile = join(dir, "argv.json");
		const child = createPiRunner({ piCommand: [process.execPath, FAKE_PI], extensionEntry: ENTRY });
		const previous = process.env.FAKE_PI_ARGV_FILE;
		process.env.FAKE_PI_ARGV_FILE = argvFile;
		try {
			const result = await child.run(request());
			assert.equal(result.ok, true, result.error);
			const recorded = JSON.parse(await readFile(argvFile, "utf8"));
			assert.deepEqual(recorded.argv.slice(0, 9), ["--mode", "json", "--no-mcp", "-ne", "-ns", "-e", ENTRY, "--tools", "read,grep,bounty_run"]);
			assert.equal(recorded.env.GENTLE_BOUNTY_CHILD, "1");
		} finally {
			if (previous === undefined) delete process.env.FAKE_PI_ARGV_FILE;
			else process.env.FAKE_PI_ARGV_FILE = previous;
		}
	}));

test("a child that reports a tool outside its allowlist fails the run", async () => {
	const previous = process.env.FAKE_PI_MODE;
	process.env.FAKE_PI_MODE = "leak";
	try {
		const result = await runner("leak").run(request());
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /outside its allowlist: bash/);
	} finally {
		if (previous === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = previous;
	}
});

test("a non-zero exit fails the run and keeps the stderr reason", async () => {
	const previous = process.env.FAKE_PI_MODE;
	process.env.FAKE_PI_MODE = "fail";
	try {
		const result = await runner("fail").run(request());
		assert.equal(result.ok, false);
		assert.equal(result.exitCode, 3);
		assert.match(result.error ?? "", /exited with 3/);
	} finally {
		if (previous === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = previous;
	}
});

test("a hanging child is killed at the timeout and reported as failed", async () => {
	const previous = process.env.FAKE_PI_MODE;
	process.env.FAKE_PI_MODE = "hang";
	try {
		const result = await runner("hang").run(request({ timeoutMs: 150 }));
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /exceeded 150ms/);
	} finally {
		if (previous === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = previous;
	}
});
