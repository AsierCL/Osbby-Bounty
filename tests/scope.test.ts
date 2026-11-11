/**
 * Scope parsing and matching (S12: extended YAML; S17: "El parseo del matcher falla cerrado").
 *
 * Two independent guarantees are tested here:
 *   1. Parsing: anything the parser does not understand is an error, never a silently dropped rule.
 *      A typo in `limits:` must not become "no limits".
 *   2. Matching: label-boundary semantics, out-of-scope precedence, and "unknown" (not "in") when
 *      nothing matches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTarget } from "../src/core/target.ts";
import { evaluate, parseScope } from "../src/core/scope.ts";

const BASE = `
program: acme
in_scope:
  - "*.acme.com"
  - acme.com
  - api.acme.com:8443
out_of_scope:
  - admin.acme.com
limits:
  rate_rps: 5
  max_requests_per_day: 20000
  forbidden:
    - dos
    - brute-force
  allowed_methods:
    - GET
    - POST
  redirects: reject
required_headers:
  X-Bounty-Id: abc-123
automation:
  ai_assisted_reports: allowed
  automated_scanning: unknown
`;

function policy(text = BASE) {
	const result = parseScope(text);
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) throw new Error("unreachable");
	return result.policy;
}

function verdict(text: string, target: string) {
	const parsed = parseTarget(target);
	assert.equal(parsed.ok, true, `target ${target}`);
	if (!parsed.ok) throw new Error("unreachable");
	return evaluate(policy(text), parsed.target);
}

function parseError(text: string, pattern: RegExp) {
	const result = parseScope(text);
	assert.equal(result.ok, false, `expected parse error, got ${JSON.stringify(result)}`);
	if (result.ok) throw new Error("unreachable");
	assert.match(result.errors.join("; "), pattern);
}

test("a well-formed scope parses every field", () => {
	const p = policy();
	assert.equal(p.program, "acme");
	assert.equal(p.inScope.length, 3);
	assert.equal(p.outOfScope.length, 1);
	assert.equal(p.limits.rateRps, 5);
	assert.equal(p.limits.maxRequestsPerDay, 20000);
	assert.deepEqual(p.limits.forbidden, ["dos", "brute-force"]);
	assert.deepEqual(p.limits.allowedMethods, ["GET", "POST"]);
	assert.equal(p.limits.redirects, "reject");
	assert.deepEqual(p.requiredHeaders, { "X-Bounty-Id": "abc-123" });
	assert.equal(p.automation.aiAssistedReports, "allowed");
	assert.equal(p.automation.automatedScanning, "unknown");
});

test("redirects default to reject when the program says nothing", () => {
	const p = policy("program: acme\nin_scope:\n  - acme.com\n");
	assert.equal(p.limits.redirects, "reject");
});

test("missing authorized_on is a warning, not a silent pass", () => {
	const result = parseScope("program: acme\nin_scope:\n  - acme.com\n");
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.ok(
		result.warnings.some((w) => w.includes("authorized_on")),
		`expected authorized_on warning, got ${JSON.stringify(result.warnings)}`,
	);
});

test("an empty in_scope list warns: every target will be unknown", () => {
	const result = parseScope("program: acme\nin_scope: []\n");
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.ok(result.warnings.some((w) => w.includes("in_scope")));
	assert.equal(evaluate(result.policy, { host: "acme.com" } as never).verdict, "unknown");
});

test("unknown keys fail the parse instead of being ignored", () => {
	parseError("program: acme\nin_scope:\n  - acme.com\nlimit:\n  rate_rps: 5\n", /unknown key "limit"/);
	parseError("program: acme\nin_scope:\n  - acme.com\nlimmits:\n  rate_rps: 5\n", /unknown key/);
	parseError("program: acme\nlimits:\n  rate_rps: 5\n  rate_rs: 1\n", /unknown key "rate_rs"/);
});

test("a scope without program is rejected", () => {
	parseError("in_scope:\n  - acme.com\n", /program/);
});

test("a bare wildcard rule is rejected", () => {
	parseError("program: acme\nin_scope:\n  - \"*\"\n", /bare wildcard/);
	parseError("program: acme\nin_scope:\n  - \"*.*.com\"\n", /wildcard/);
});

test("a rule that is not a host is rejected with its own message", () => {
	parseError("program: acme\nin_scope:\n  - \"not a host\"\n", /invalid rule/);
	parseError("program: acme\nin_scope:\n  - \"http://\"\n", /invalid rule/);
});

test("malformed structure and tab indentation are rejected", () => {
	parseError("program: acme\nin_scope:\n\t- acme.com\n", /tab/);
	parseError("- acme.com\n", /unexpected list item/);
	parseError("program: acme\nprogram: other\n", /duplicate key/);
	parseError("program: acme\nin_scope: acme.com\n", /expected a list/);
});

test("rules accept scheme prefixes and normalize them away", () => {
	const p = policy("program: acme\nin_scope:\n  - https://*.acme.com\n");
	assert.equal(p.inScope[0].host, "acme.com");
	assert.equal(p.inScope[0].wildcard, true);
});

test("*.host matches subdomains but never the apex", () => {
	const text = "program: acme\nin_scope:\n  - \"*.acme.com\"\n";
	assert.equal(verdict(text, "a.acme.com").verdict, "in");
	assert.equal(verdict(text, "a.b.acme.com").verdict, "in");
	assert.equal(verdict(text, "acme.com").verdict, "unknown");
});

test("exact host matches the apex only, never subdomains", () => {
	const text = "program: acme\nin_scope:\n  - acme.com\n";
	assert.equal(verdict(text, "acme.com").verdict, "in");
	assert.equal(verdict(text, "a.acme.com").verdict, "unknown");
});

test("suffix lookalikes are not matched (label boundary)", () => {
	const text = "program: acme\nin_scope:\n  - \"*.acme.com\"\n  - acme.com\n";
	assert.equal(verdict(text, "notacme.com").verdict, "unknown");
	assert.equal(verdict(text, "acme.com.otro.com").verdict, "unknown");
	assert.equal(verdict(text, "otro.com/acme.com").verdict, "unknown");
	assert.equal(verdict(text, "evil-acme.com").verdict, "unknown");
});

test("out_of_scope wins over an in_scope wildcard", () => {
	const text = "program: acme\nin_scope:\n  - \"*.acme.com\"\nout_of_scope:\n  - admin.acme.com\n";
	const v = verdict(text, "admin.acme.com");
	assert.equal(v.verdict, "out");
	if (v.verdict === "out") assert.equal(v.rule, "admin.acme.com");
	assert.equal(verdict(text, "app.acme.com").verdict, "in");
});

test("an IP never matches a name wildcard", () => {
	const text = "program: acme\nin_scope:\n  - \"*.acme.com\"\n";
	assert.equal(verdict(text, "1.2.3.4").verdict, "unknown");
	assert.equal(verdict(text, "127.0.0.1").verdict, "unknown");
});

test("an IP rule matches that IP only", () => {
	const text = "program: acme\nin_scope:\n  - 10.0.0.5\n";
	assert.equal(verdict(text, "10.0.0.5").verdict, "in");
	assert.equal(verdict(text, "10.0.0.6").verdict, "unknown");
});

test("port rules require the exact port", () => {
	const text = "program: acme\nin_scope:\n  - api.acme.com:8443\n";
	assert.equal(verdict(text, "https://api.acme.com:8443/x").verdict, "in");
	assert.equal(verdict(text, "https://api.acme.com/x").verdict, "unknown");
	assert.equal(verdict(text, "https://api.acme.com:9999/x").verdict, "unknown");
});

test("path rules constrain the path prefix", () => {
	const text = "program: acme\nin_scope:\n  - \"*.acme.com/static/*\"\n";
	assert.equal(verdict(text, "https://a.acme.com/static/app.js").verdict, "in");
	assert.equal(verdict(text, "https://a.acme.com/app/x").verdict, "unknown");
});

test("verdicts carry the rule that decided them", () => {
	const v = verdict("program: acme\nin_scope:\n  - acme.com\n", "acme.com");
	assert.equal(v.verdict, "in");
	if (v.verdict === "in") assert.equal(v.rule, "acme.com");
});

test("a verdict on an unparseable target is never 'in'", () => {
	const p = policy();
	for (const bad of ["", "http://", "acme..com"]) {
		const parsed = parseTarget(bad);
		if (parsed.ok) continue;
		const v = evaluate(p, { host: bad } as never);
		assert.notEqual(v.verdict, "in", `bad target ${JSON.stringify(bad)}`);
	}
});

test("notes block scalar is preserved verbatim", () => {
	const p = policy("program: acme\nin_scope:\n  - acme.com\nnotes: |\n  No DoS. No brute force.\n  Escalate to security@acme.com.\n");
	assert.equal(p.notes, "No DoS. No brute force.\nEscalate to security@acme.com.");
});
