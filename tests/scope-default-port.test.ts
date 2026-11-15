/**
 * S86: the URL class drops the default port of a scheme, so `https://host` arrived with `port: null`
 * and a rule `host:443` — which requires port 443 — could never match. That is a false NEGATIVE:
 * the gate denied traffic the program allows. The default port is normalized on the target side, so
 * the comparison sees 443 and the rule works as written.
 *
 * The direction matters: this can only loosen a rule that names the scheme's default port. A rule
 * naming another port still denies anything else, and a non-default port on both sides is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { gate } from "../src/core/gate.ts";
import { evaluate, parseScope } from "../src/core/scope.ts";
import { parseTarget } from "../src/core/target.ts";

const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };

function policy(inScope: string[], outOfScope: string[] = []) {
	const parsed = parseScope(
		[
			"program: lab",
			"lab: true",
			"authorized_on: 2026-01-01",
			"in_scope:",
			...inScope.map((rule) => `  - ${rule}`),
			...(outOfScope.length === 0 ? [] : ["out_of_scope:", ...outOfScope.map((rule) => `  - ${rule}`)]),
			"limits:",
			"  rate_rps: 5",
			"  allowed_methods:",
			"    - GET",
			"",
		].join("\n"),
	);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

function verdictOf(inScope: string[], raw: string, outOfScope: string[] = []) {
	const target = parseTarget(raw);
	assert.equal(target.ok, true, `failed to parse ${raw}`);
	if (!target.ok) throw new Error("unreachable");
	return evaluate(policy(inScope, outOfScope), target.target);
}

test("https without a port matches a rule that names 443", () => {
	assert.equal(verdictOf(["acme.com:443"], "https://acme.com/x").verdict, "in");
});

test("https with an explicit :443 matches a rule that names 443", () => {
	assert.equal(verdictOf(["acme.com:443"], "https://acme.com:443/x").verdict, "in");
});

test("http without a port matches a rule that names 80", () => {
	assert.equal(verdictOf(["acme.com:80"], "http://acme.com/x").verdict, "in");
});

test("the bare host:port token keeps working exactly as before", () => {
	// The workaround used in earlier sessions: no scheme, so no default is invented; the rule's 443
	// is compared with the token's own 443.
	assert.equal(verdictOf(["acme.com:443"], "acme.com:443").verdict, "in");
	const http = parseTarget("http://acme.com:80/x");
	assert.equal(http.ok, true);
});

test("non-default ports on both sides keep matching (regression)", () => {
	assert.equal(verdictOf(["127.0.0.1:8787"], "http://127.0.0.1:8787/api/invoices/2").verdict, "in");
	assert.equal(verdictOf(["127.0.0.1:33971"], "http://127.0.0.1:33971/x").verdict, "in");
	assert.equal(verdictOf(["127.0.0.1:8443"], "https://127.0.0.1:8443/x").verdict, "in");
});

test("a non-default URL port is not matched by a rule with another port (security regression, fail closed)", () => {
	const wrong = verdictOf(["127.0.0.1:8788"], "http://127.0.0.1:8787/x");
	assert.notEqual(wrong.verdict, "in", JSON.stringify(wrong));
	const wrongTls = verdictOf(["acme.com:8443"], "https://acme.com:9443/x");
	assert.notEqual(wrongTls.verdict, "in", JSON.stringify(wrongTls));
	// And the default-port rule does not start matching a different explicit port either.
	const wrongDefault = verdictOf(["acme.com:443"], "https://acme.com:8443/x");
	assert.notEqual(wrongDefault.verdict, "in", JSON.stringify(wrongDefault));
});

test("out_of_scope with a port also works now, and it wins", () => {
	const result = verdictOf(["acme.com:443"], "https://acme.com/x", ["acme.com:443"]);
	assert.equal(result.verdict, "out");
});

test("the gate allows the https URL a 443 rule describes (end to end)", async () => {
	const result = await gate(policy(["acme.com:443"]), { target: "https://acme.com/x", headers: {}, argv: [] } as never, deps);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("the gate still denies an explicit non-default port that the rule does not name", async () => {
	const result = await gate(policy(["acme.com:443"]), { target: "https://acme.com:8443/x", headers: {}, argv: [] } as never, deps);
	assert.equal(result.allowed, false, JSON.stringify(result));
});
