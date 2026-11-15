/**
 * S88: required program headers are an HTTP contract. Asking a local binary to send a User-Agent made
 * the tool useless for inventory work: `which playwright` came back as "required header User-Agent is
 * missing", which the live agent read (correctly) as "no pude comprobarlo".
 *
 * A known HTTP client or any argv token with a scheme URL counts as HTTP; everything else does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gate, isHttpInvocation } from "../src/core/gate.ts";
import { parseScope } from "../src/core/scope.ts";
import { createSession } from "../src/pi/session.ts";

const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };
const policy = () => {
	const parsed = parseScope(
		"program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nrequired_headers:\n  User-Agent:\n    value: bugcrowd\n    mode: contains\nlimits:\n  rate_rps: 5\n",
	);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
};

test("isHttpInvocation separates local binaries from HTTP clients", () => {
	assert.equal(isHttpInvocation("which", ["playwright"]), false);
	assert.equal(isHttpInvocation("ls", ["-la", "/tmp"]), false);
	assert.equal(isHttpInvocation("python3", ["-c", "print(1)"]), false);
	assert.equal(isHttpInvocation("curl", ["-sS", "https://x/"]), true);
	assert.equal(isHttpInvocation("nuclei", ["-u", "www.acme.com"]), true);
	assert.equal(isHttpInvocation("node", ["scripts/browser.ts", "https://www.acme.com/"]), true);
});

test("a non-HTTP invocation is not asked for the program's headers", async () => {
	const result = await gate(policy(), { target: "127.0.0.1:3000", headers: {}, argv: ["playwright"], http: false } as never, deps);
	assert.equal(result.allowed, true, JSON.stringify(result));
	if (result.allowed) assert.ok(result.notes.some((note) => /required headers not checked/.test(note)));
});

test("an HTTP invocation still is", async () => {
	const missing = await gate(policy(), { target: "http://127.0.0.1:3000/", headers: {}, argv: [], http: true } as never, deps);
	assert.equal(missing.allowed, false);
	if (!missing.allowed) assert.match(missing.reason, /required header User-Agent is missing/);
	const ok = await gate(policy(), { target: "http://127.0.0.1:3000/", headers: { "user-agent": "bugcrowd-x" }, argv: [], http: true } as never, deps);
	assert.equal(ok.allowed, true, JSON.stringify(ok));
});

test("the session marks `which playwright` as non-HTTP and runs it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-http-only-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nrequired_headers:\n  User-Agent:\n    value: bugcrowd\n    mode: contains\nlimits:\n  rate_rps: 5\n", "utf8");
		const seen: string[][] = [];
		const session = createSession(
			{ root: dir, program: "lab" },
			{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async (argv) => { seen.push(argv); return { exitCode: 0, stdout: "/usr/bin/playwright\n", stderr: "" }; }, confirm: async () => true },
		);
		await session.scope({ file: scopePath });
		const which = await session.run({ tool: "which", args: ["playwright"], target: "http://127.0.0.1:3000/" });
		assert.equal(which.ok, true, which.text);
		assert.deepEqual(seen[0], ["which", "playwright"]);
		const curl = await session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.equal(curl.ok, false);
		assert.match(curl.text, /required header User-Agent is missing/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
