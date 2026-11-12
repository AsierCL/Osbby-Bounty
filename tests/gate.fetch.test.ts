/**
 * S33: file-flag values that are scheme-qualified URLs are fetches, and fetches are network traffic.
 * Local paths stay unvalidated so `-o /tmp/out.txt` keeps working; downloads from GitHub keep working
 * through an operator-level `fetch_allow` that never widens the program's scope.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGlobalConfig, DEFAULT_CONFIG } from "../src/core/config.ts";
import { isFetchAllowed } from "../src/core/fetch-allow.ts";
import { gate } from "../src/core/gate.ts";
import { parseScope } from "../src/core/scope.ts";

const SCOPE = `
program: lab
lab: true
authorized_on: 2026-11-11
in_scope:
  - acme.com
  - "*.acme.com"
limits:
  rate_rps: 5
`;

function policy() {
	const parsed = parseScope(SCOPE);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };

async function attempt(argv: string[], fetchAllow?: string[]) {
	return gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv } as never,
		fetchAllow === undefined ? deps : { ...deps, fetchAllow },
	);
}

test("a template URL outside scope and outside fetch_allow is denied with a readable reason", async () => {
	const result = await attempt(["-t", "https://otro.com/x.yaml"]);
	assert.equal(result.allowed, false);
	if (!result.allowed) {
		assert.match(result.reason, /outside the scope and outside fetch_allow/);
		assert.match(result.reason, /otro\.com/);
	}
});

test("a template URL from raw.githubusercontent.com passes by default", async () => {
	const result = await attempt(["-t", "https://raw.githubusercontent.com/projectdiscovery/nuclei-templates/main/x.yaml"]);
	assert.equal(result.allowed, true, JSON.stringify(result));
	if (result.allowed) assert.ok(result.notes.some((note) => /fetch_allow/.test(note)));
});

test("github.com passes by default too", async () => {
	const result = await attempt(["-t", "https://github.com/o/r/releases/download/v1/x.yaml"]);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("a local output path is not a fetch and passes", async () => {
	const result = await attempt(["-o", "/tmp/out.txt", "-w", "words.txt"]);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("a bare file name that looks like a host is still treated as a local path", async () => {
	// Documented: only scheme-qualified values are fetches. `out.json` has no scheme, so it is a path.
	const result = await attempt(["-o", "out.json"]);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("the inline --flag=url form is validated too", async () => {
	const result = await attempt(["--config=https://evil.example/c.json"]);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /outside the scope and outside fetch_allow/);
});

test("a download inside the scope needs no fetch_allow", async () => {
	const result = await attempt(["-t", "https://a.acme.com/templates/x.yaml"]);
	assert.equal(result.allowed, true, JSON.stringify(result));
	if (result.allowed) assert.ok(result.notes.some((note) => /inside the scope/.test(note)));
});

test("fetch_allow is editable by the operator and replaces the defaults", async () => {
	const replaced = await attempt(["-t", "https://raw.githubusercontent.com/o/r/x.yaml"], ["example.org"]);
	assert.equal(replaced.allowed, false);
	const allowed = await attempt(["-t", "https://example.org/x.yaml"], ["example.org"]);
	assert.equal(allowed.allowed, true);
});

test("fetch_allow never widens the scope for an actual target", async () => {
	const result = await gate(
		policy(),
		{ target: "https://raw.githubusercontent.com/o/r", headers: {}, argv: [] } as never,
		deps,
	);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /no in_scope rule matched/);
});

test("fetch_allow matching is label-bounded", () => {
	assert.equal(isFetchAllowed("github.com", ["github.com"]), true);
	assert.equal(isFetchAllowed("raw.githubusercontent.com", ["github.com"]), false);
	assert.equal(isFetchAllowed("a.github.com", ["github.com"]), false);
	assert.equal(isFetchAllowed("a.github.com", ["*.github.com"]), true);
	assert.equal(isFetchAllowed("github.com", ["*.github.com"]), false);
});

test("the config parser accepts fetch_allow, mcp, redaction and budget, and rejects unknown keys", () => {
	const ok = parseGlobalConfig(JSON.stringify({ fetch_allow: ["example.org"], mcp: ["burp"], redaction: "on", budget: { max_tool_calls: 20 } }));
	assert.equal(ok.ok, true, JSON.stringify(ok));
	if (ok.ok) {
		assert.deepEqual(ok.config.fetchAllow, ["example.org"]);
		assert.deepEqual(ok.config.mcp, ["burp"]);
		assert.equal(ok.config.redaction, "on");
		assert.equal(ok.config.budget.maxToolCalls, 20);
	}
	const bad = parseGlobalConfig(JSON.stringify({ fetch_alow: ["x"] }));
	assert.equal(bad.ok, false);
	const badBudget = parseGlobalConfig(JSON.stringify({ budget: { max_tool_calls: 0 } }));
	assert.equal(badBudget.ok, false);
	assert.deepEqual(DEFAULT_CONFIG.fetchAllow, ["github.com", "raw.githubusercontent.com"]);
});
