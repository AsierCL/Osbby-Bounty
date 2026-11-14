/**
 * S79/S82: required program headers, with modes.
 *
 * `Name: value` keeps the historical meaning (exact). `Name: {value, mode: contains}` exists because a
 * program like Bugcrowd requires a token *inside* the User-Agent, not a fixed value. The check runs
 * against the headers the request actually sends: before this, the session passed the requirement as
 * if it were the request, so the check could never fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gate } from "../src/core/gate.ts";
import { parseScope } from "../src/core/scope.ts";
import { createSession, headersFromArgs } from "../src/pi/session.ts";

const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };
const target = "http://127.0.0.1:3000/x";

function policy(required: string) {
	const parsed = parseScope(`program: lab
lab: true
authorized_on: 2026-01-01
in_scope:
  - 127.0.0.1:3000
required_headers:
${required}
limits:
  rate_rps: 5
`);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

test("a plain value keeps meaning exact, and the map form parses its mode", () => {
	const plain = policy('  X-Bounty-Id: abc-123');
	assert.deepEqual(plain.requiredHeaders, { "X-Bounty-Id": { value: "abc-123", mode: "exact" } });
	const withMode = policy('  User-Agent:\n    value: bugcrowd\n    mode: contains');
	assert.deepEqual(withMode.requiredHeaders, { "User-Agent": { value: "bugcrowd", mode: "contains" } });
	const bad = parseScope("program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nrequired_headers:\n  User-Agent:\n    value: x\n    mode: regex\nlimits:\n  rate_rps: 5\n");
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.match(bad.errors.join(" "), /mode must be "exact" or "contains"/);
});

test("exact headers are enforced against the headers actually sent", async () => {
	const exact = policy('  X-Bounty-Id: abc-123');
	const ok = await gate(exact, { target, headers: { "x-bounty-id": "abc-123" }, argv: [] } as never, deps);
	assert.equal(ok.allowed, true, JSON.stringify(ok));
	const missing = await gate(exact, { target, headers: {}, argv: [] } as never, deps);
	assert.equal(missing.allowed, false);
	if (!missing.allowed) assert.match(missing.reason ?? missing.reason, /required header X-Bounty-Id is missing/);
	const wrong = await gate(exact, { target, headers: { "x-bounty-id": "otro" }, argv: [] } as never, deps);
	assert.equal(wrong.allowed, false);
	if (!wrong.allowed) assert.match(wrong.reason ?? wrong.reason, /must be "abc-123"/);
});

test('"contains" lets a Bugcrowd-style User-Agent satisfy the requirement', async () => {
	const contains = policy('  User-Agent:\n    value: bugcrowd\n    mode: contains');
	const ok = await gate(contains, { target, headers: { "user-agent": "Mozilla/5.0 (compatible; Bugcrowd-Research/1.0)" }, argv: [] } as never, deps);
	assert.equal(ok.allowed, true, JSON.stringify(ok));
	const noToken = await gate(contains, { target, headers: { "user-agent": "Mozilla/5.0" }, argv: [] } as never, deps);
	assert.equal(noToken.allowed, false);
	if (!noToken.allowed) assert.match(noToken.reason ?? noToken.reason, /must contain "bugcrowd"/);
});

test("the session sends the real -H headers, so a missing required header blocks the run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-reqhdr-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(
			scopePath,
			"program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nrequired_headers:\n  User-Agent:\n    value: bugcrowd\n    mode: contains\nlimits:\n  rate_rps: 5\n",
			"utf8",
		);
		const executed: string[][] = [];
		const session = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async (argv) => {
					executed.push(argv);
					return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" };
				},
				confirm: async () => true,
			},
		);
		await session.scope({ file: scopePath });

		const withToken = await session.run({
			tool: "curl",
			args: ["-sS", "-H", "User-Agent: Mozilla/5.0 (compatible; Bugcrowd-Research)", target],
			target,
		});
		assert.equal(withToken.ok, true, withToken.text);
		assert.equal(executed.length, 1);

		const without = await session.run({ tool: "curl", args: ["-sS", target], target });
		assert.equal(without.ok, false, without.text);
		assert.match(without.text, /required header User-Agent is missing/);
		assert.equal(executed.length, 1, "a non-compliant run must not execute");

		const wrongAgent = await session.run({ tool: "curl", args: ["-sS", "-H", "User-Agent: Mozilla/5.0", target], target });
		assert.equal(wrongAgent.ok, false);
		assert.match(wrongAgent.text, /must contain "bugcrowd"/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("headersFromArgs reads -H, --header and --header= with a lowercased name", () => {
	assert.deepEqual(headersFromArgs(["-H", "User-Agent: x", "--header=Accept: json"]), { "user-agent": "x", accept: "json" });
	assert.deepEqual(headersFromArgs(["-sS", target]), {});
});

test("S82: a cookie value with a dot is not a host, but a URL in a custom header still blocks", async () => {
	const plain = parseScope("program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n");
	assert.equal(plain.ok, true);
	if (!plain.ok) return;
	const cookie = await gate(plain.policy, { target, headers: {}, argv: ["-sS", "-H", "Cookie: session=abc.def", target] } as never, deps);
	assert.equal(cookie.allowed, true, JSON.stringify(cookie));
	const callback = await gate(plain.policy, { target, headers: {}, argv: ["-sS", "-H", "X-Callback: https://otro.example/x", target] } as never, deps);
	assert.equal(callback.allowed, false, JSON.stringify(callback));
	if (!callback.allowed) assert.match(callback.detail ?? "", /otro\.example/);
});
