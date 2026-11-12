/**
 * S47: the confirmation stub is a test affordance, and it becomes impossible in the normal path.
 *
 * Two independent guards:
 *   1. `lab` is a mandatory scope field; without it the scope does not parse.
 *   2. A session refuses to load any scope that is not `lab: true` while the stub variables are set,
 *      and writes the refusal into status.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseScope } from "../src/core/scope.ts";
import { createSession, type SessionDeps } from "../src/pi/session.ts";

const STUB_ENV = { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1", GENTLE_BOUNTY_CONFIRM_TEST: "yes" } as NodeJS.ProcessEnv;

function scopeText(lab: string | null): string {
	const labLine = lab === null ? "" : `lab: ${lab}\n`;
	return `program: lab\n${labLine}authorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n`;
}

async function harness(scope: string, env: NodeJS.ProcessEnv) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-stub-guard-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	await writeFile(join(dir, "scope.yaml"), scope, "utf8");
	const executed: string[][] = [];
	const deps: SessionDeps = {
		env,
		dns: async () => ({ cname: [] }),
		readFile: (path) => readFile(path, "utf8"),
		runTool: async (argv) => {
			executed.push(argv);
			return { exitCode: 0, stdout: "ok", stderr: "" };
		},
		confirm: async () => true,
	};
	const session = createSession({ root: dir, program: "lab" }, deps);
	return { dir, session, executed, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a scope without lab does not parse", () => {
	const parsed = parseScope(scopeText(null));
	assert.equal(parsed.ok, false);
	if (!parsed.ok) assert.match(parsed.errors.join("; "), /lab is required/);
});

test("lab accepts only true or false", () => {
	const okTrue = parseScope(scopeText("true"));
	assert.equal(okTrue.ok, true);
	if (okTrue.ok) assert.equal(okTrue.policy.lab, true);
	const bad = parseScope(scopeText("yes"));
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.match(bad.errors.join("; "), /lab must be true or false/);
});

test("a real program scope refuses to load while the stub is requested", async () => {
	const h = await harness(scopeText("false"), STUB_ENV);
	try {
		const result = await h.session.scope({ file: join(h.dir, "scope.yaml") });
		assert.equal(result.ok, false);
		assert.match(result.text, /no está marcado como laboratorio/);
		const status = await readFile(h.session.paths.statusFile, "utf8");
		assert.match(status, /scope rechazado/);
		assert.match(status, /lab: true/);
		// And nothing can run, because no policy was loaded.
		const run = await h.session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.equal(run.ok, false);
		assert.match(run.text, /no scope loaded/);
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("a lab scope loads with the stub active and the destructive pause still runs", async () => {
	const h = await harness(scopeText("true"), STUB_ENV);
	try {
		const loaded = await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		assert.equal(loaded.ok, true, loaded.text);
		const run = await h.session.run({
			tool: "hydra",
			args: ["-L", "logins.txt", "-P", "passwords.txt", "127.0.0.1:3000", "ssh"],
			target: "http://127.0.0.1:3000/login",
		});
		assert.equal(run.ok, true, run.text);
		assert.equal(h.executed.length, 1, "the stubbed yes must let the lab action through");
	} finally {
		await h.cleanup();
	}
});

test("with no stub, a real program scope loads normally", async () => {
	const h = await harness(scopeText("false"), {} as NodeJS.ProcessEnv);
	try {
		const loaded = await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		assert.equal(loaded.ok, true, loaded.text);
	} finally {
		await h.cleanup();
	}
});
