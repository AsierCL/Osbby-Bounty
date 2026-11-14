/**
 * S81/task 1: header values are connection destinations only when they have host shape, and two
 * headers exist purely as test inputs (CORS/CSRF): Origin and Referer. Everything that can decide
 * where the connection goes (Host, X-Forwarded-Host, X-Forwarded-Server, X-Forwarded-For, Forwarded)
 * is still validated against the scope.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { gate } from "../src/core/gate.ts";
import { parseScope } from "../src/core/scope.ts";

const SCOPE = `
program: lab
lab: true
authorized_on: 2026-01-01
in_scope:
  - 127.0.0.1:3000
limits:
  rate_rps: 5
  allowed_methods:
    - GET
    - POST
`;

const policy = (() => {
	const parsed = parseScope(SCOPE);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
})();

const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };
const request = (argv: string[]) => ({ target: "http://127.0.0.1:3000/api/invoices/2", headers: {}, argv } as never);

test("Origin is a test input: null, a free string and an attacker URL all pass", async () => {
	for (const value of ["null", "not-a-host-string", "https://attacker.example/", "http://evil.example"]) {
		const result = await gate(policy, request(["-sS", "-H", `Origin: ${value}`, "http://127.0.0.1:3000/api/invoices/2"]), deps);
		assert.equal(result.allowed, true, `${value}: ${JSON.stringify(result)}`);
	}
});

test("Referer is a test input too, even when it carries a foreign URL", async () => {
	const result = await gate(policy, request(["-sS", "-H", "Referer: https://attacker.example/page", "http://127.0.0.1:3000/api/invoices/2"]), deps);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("the gate records that a test-only header was not treated as a destination", async () => {
	const result = await gate(policy, request(["-sS", "-H", "Origin: null", "http://127.0.0.1:3000/"]), deps);
	assert.equal(result.allowed, true);
	if (result.allowed) assert.ok(result.notes.some((note) => /Origin: null|Origin/.test(note)), JSON.stringify(result.notes));
});

test("routing headers are still validated: Host, X-Forwarded-Host, X-Forwarded-For", async () => {
	for (const header of ["Host: otro.com", "X-Forwarded-Host: otro.com", "X-Forwarded-Server: otro.com", "X-Forwarded-For: 203.0.113.9", "Forwarded: for=otro.com"]) {
		const result = await gate(policy, request(["-sS", "-H", header, "http://127.0.0.1:3000/"]), deps);
		assert.equal(result.allowed, false, `${header}: ${JSON.stringify(result)}`);
		if (!result.allowed) assert.match(result.detail ?? "", /otro\.com|203\.0\.113\.9/);
	}
});

test("a routing header that is in scope still works", async () => {
	const result = await gate(policy, request(["-sS", "-H", "Host: 127.0.0.1:3000", "http://127.0.0.1:3000/"]), deps);
	assert.equal(result.allowed, true, JSON.stringify(result));
});

test("a header value without host shape is not a host, for any header", async () => {
	// Before S81 this was denied as the host "null": the header path had no shape guard.
	const result = await gate(policy, request(["-sS", "-H", "X-Forwarded-Host: null", "http://127.0.0.1:3000/"]), deps);
	assert.equal(result.allowed, true, JSON.stringify(result));
});
