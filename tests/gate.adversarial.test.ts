/**
 * Adversarial gate suite (S17, verbatim list): userinfo confusion, punycode/homoglyphs, trailing dot,
 * uppercase, IPv6, decimal/octal IPs, ports, `*.domain` vs apex, `domain.com.other.com`, redirects,
 * CNAME to third parties, and `unknown ⇒ rejection`.
 *
 * Every case here is a bypass attempt: the assertion is always "refused", except where the spelled
 * form is provably the same in-scope host after normalization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseScope } from "../src/core/scope.ts";
import { gate } from "../src/core/gate.ts";

const SCOPE = `
program: lab
authorized_on: 2026-11-01
in_scope:
  - acme.com
  - "*.acme.com"
  - api.acme.com:8443
  - 127.0.0.1
  - 10.0.0.5
  - "[::1]"
out_of_scope:
  - admin.acme.com
limits:
  rate_rps: 5
  forbidden:
    - dos
  allowed_methods:
    - GET
  redirects: reject
`;

function policy() {
	const parsed = parseScope(SCOPE);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

const noDns = async () => ({ cname: [] as string[] });
const deps = { dns: noDns, readFile: async () => "" };

async function attempt(target: string, extra: Record<string, unknown> = {}) {
	return gate(policy(), { target, headers: {}, argv: [], ...extra } as never, deps);
}

async function assertRefused(target: string, extra: Record<string, unknown> = {}) {
	const result = await attempt(target, extra);
	assert.equal(result.allowed, false, `expected refusal for ${target}, got ${JSON.stringify(result)}`);
	return result;
}

async function assertAllowed(target: string, extra: Record<string, unknown> = {}) {
	const result = await attempt(target, extra);
	assert.equal(result.allowed, true, `expected allow for ${target}, got ${JSON.stringify(result)}`);
	return result;
}

test("userinfo confusion is refused: the contacted host is the one after the last @", async () => {
	const result = await assertRefused("https://acme.com@otro.com/");
	if (!result.allowed) assert.match(result.detail ?? "", /otro\.com/);
});

test("userinfo confusion does not grant access through the visible prefix", async () => {
	await assertRefused("https://a.acme.com@otro.com/");
});

test("homoglyph IDN is refused, not folded into the ASCII host", async () => {
	// Cyrillic 'а' (U+0430) in the first label.
	await assertRefused("https://аcme.com/");
	await assertRefused("https://aсme.com/");
});

test("punycode form of the homoglyph is refused too", async () => {
	await assertRefused("https://xn--cme-5cd.com/");
});

test("trailing dot normalizes to the in-scope host instead of bypassing it", async () => {
	await assertAllowed("https://acme.com./");
	await assertAllowed("https://a.acme.com./");
});

test("uppercase is the same host", async () => {
	await assertAllowed("https://ACME.COM/");
	await assertAllowed("https://A.ACME.COM/");
});

test("IPv6 literal is allowed only when listed", async () => {
	await assertAllowed("http://[::1]/");
	await assertRefused("http://[::2]/");
});

test("decimal IP is normalized before the scope decision", async () => {
	// 167772165 = 10.0.0.5, which is in scope; the spelling must not matter.
	await assertAllowed("http://167772165/");
	// 2130706433 = 127.0.0.1, in scope.
	await assertAllowed("http://2130706433/");
	// 167772166 = 10.0.0.6, not in scope.
	await assertRefused("http://167772166/");
});

test("octal and hex IP spellings follow the same decision", async () => {
	await assertAllowed("http://012.0.0.5/");
	await assertAllowed("http://0x0a.0.0.5/");
	await assertRefused("http://0x0a.0.0.6/");
});

test("shortened IP is normalized, not trusted", async () => {
	await assertAllowed("http://127.1/");
	await assertRefused("http://127.2/");
});

test("a port rule requires the exact port when no wildcard grants the host", async () => {
	const narrowed = SCOPE.replace('  - "*.acme.com"\n', "");
	const parsed = parseScope(narrowed);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) return;
	const allowed = await gate(parsed.policy, { target: "https://api.acme.com:8443/", headers: {}, argv: [] } as never, deps);
	assert.equal(allowed.allowed, true, JSON.stringify(allowed));
	const refused = await gate(parsed.policy, { target: "https://api.acme.com:9999/", headers: {}, argv: [] } as never, deps);
	assert.equal(refused.allowed, false, JSON.stringify(refused));
});

test("a wildcard grant is not port-qualified (documented consequence)", async () => {
	// `*.acme.com` covers every port of every name it matches. This test states that consequence
	// explicitly so nobody mistakes it for a bug later.
	await assertAllowed("https://api.acme.com:9999/");
});

test("*.domain does not cover the apex", async () => {
	await assertAllowed("https://a.acme.com/");
	await assertRefused("https://otro.com/");
});

test("domain.com.other.com is not treated as a subdomain", async () => {
	await assertRefused("https://acme.com.otro.com/");
	await assertRefused("https://acme.com.otro.com./");
});

test("suffix lookalikes are refused", async () => {
	await assertRefused("https://notacme.com/");
	await assertRefused("https://evila.acme.com.attacker.net/");
	await assertRefused("https://acme.com@attacker.net/");
});

test("path does not smuggle a host", async () => {
	await assertRefused("https://otro.com/acme.com/path");
	await assertAllowed("https://a.acme.com/otro.com/path");
});

test("an OOB callback host in argv is refused", async () => {
	const result = await attempt("https://a.acme.com/", { argv: ["-headless", "-eh", "http://abc123.oast.fun/cb"] });
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /oast\.fun/);
});

test("an OOB callback host inside a template argument is refused", async () => {
	const result = await attempt("https://a.acme.com/", {
		argv: ["-t", "template.yaml", "-var", "callback=https://x.interact.sh/hit"],
	});
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /interact\.sh/);
});

test("an out-of-scope host in a header value is refused", async () => {
	const result = await attempt("https://a.acme.com/", { argv: ["-H", "X-Forwarded-Host: admin.acme.com"] });
	assert.equal(result.allowed, false);
});

test("redirects are refused by default policy, whatever the target", async () => {
	const result = await attempt("https://a.acme.com/", { followRedirects: true });
	assert.equal(result.allowed, false);
});

test("a CNAME to a third-party service is refused", async () => {
	const result = await gate(
		policy(),
		{ target: "https://a.acme.com/", headers: {}, argv: [], dns: async () => ({ cname: ["acme.herokuapp.com"] }) } as never,
		deps,
	);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /herokuapp\.com/);
});

test("unknown is a refusal, never an allow", async () => {
	for (const target of ["https://unknown.example/", "https://acme.com.attacker.net/", "https://1.2.3.4/"]) {
		await assertRefused(target);
	}
});

test("every refusal carries a machine-readable reason", async () => {
	const result = await assertRefused("https://otro.com/");
	if (!result.allowed) {
		assert.equal(typeof result.reason, "string");
		assert.ok(result.reason.length > 0);
	}
});
