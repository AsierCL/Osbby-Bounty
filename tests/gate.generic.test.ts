/**
 * S24: generic argv scanning. No per-tool profiles exist. Every token that parses as a host, URL or
 * IP is validated wherever it appears, and a token that does not parse as a host never blocks.
 *
 * These tests pin the boundary between "unknown tool works out of the box" and "the two red lines".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseScope } from "../src/core/scope.ts";
import { gate } from "../src/core/gate.ts";

const SCOPE = `
program: lab
lab: true
authorized_on: 2026-11-01
in_scope:
  - acme.com
  - "*.acme.com"
out_of_scope:
  - admin.acme.com
limits:
  rate_rps: 5
  allowed_methods:
    - GET
    - POST
  redirects: reject
`;

function policy(text = SCOPE) {
	const parsed = parseScope(text);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };

test("a tool nobody configured is validated identically to a known one", async () => {
	// Invented flag names: no profile exists for `frobnicate`.
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["--frobnicate", "https://otro.com/x", "--depth", "2"] } as never,
		deps,
	);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /otro\.com/);
});

test("a token that does not parse as a host does not block", async () => {
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["--frobnicate", "not a host at all", "--weird", "a..b"] } as never,
		deps,
	);
	assert.equal(result.allowed, true, JSON.stringify(result));
	if (result.allowed) assert.ok(result.notes.some((note) => /not hosts were ignored/.test(note)));
});

test("numbers, severity words and words without a dot never block", async () => {
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["-rl", "150", "-severity", "critical,high", "-tags", "cve"] } as never,
		deps,
	);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("--targets is read as a host file, like -l and --list", async () => {
	const readFile = async (path: string) => {
		if (path === "targets.txt") return "a.acme.com\n\n# comment\nadmin.acme.com\n";
		throw new Error(`unexpected read ${path}`);
	};
	const result = await gate(policy(), { target: "https://a.acme.com/", headers: {}, argv: ["--targets", "targets.txt"] } as never, {
		dns: deps.dns,
		readFile,
	});
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /admin\.acme\.com/);
});

test("a host inside a query string is still validated", async () => {
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["-u", "https://a.acme.com/redir?next=https://otro.com/x"] } as never,
		deps,
	);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /otro\.com/);
});

test("an IP literal in a new flag is validated as an IP", async () => {
	const result = await gate(policy(), { target: "https://a.acme.com/", headers: {}, argv: ["--frobnicate", "203.0.113.5"] } as never, deps);
	assert.equal(result.allowed, false);
});

test("a local path value of a known file flag is not treated as a host", async () => {
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["-o", "out.json", "-t", "tpl.yaml", "-w", "words.txt"] } as never,
		deps,
	);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("S78: a second host anywhere in argv is validated, not just the one in the expected slot", async () => {
	// curl accepts several URLs positionally and fetches them all; the gate must not assume the
	// last argument is the target. Here the out-of-scope host comes first.
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["-sS", "-i", "https://otro.com/x", "https://a.acme.com/"] } as never,
		deps,
	);
	assert.equal(result.allowed, false, JSON.stringify(result));
	if (!result.allowed) assert.match(result.detail ?? "", /otro\.com/);

	// And in the middle, with a flag after it.
	const middle = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: ["-sS", "https://a.acme.com/", "https://otro.com/y", "--max-time", "5"] } as never,
		deps,
	);
	assert.equal(middle.allowed, false, JSON.stringify(middle));
});
