/**
 * Target normalization (S17: "normalización de targets"; S10: the gate validates what is actually
 * contacted). Every rule here exists because the same string can mean different hosts to different
 * parsers; normalization collapses those spellings into one canonical form so the scope matcher has
 * a single, auditable input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTarget } from "../src/core/target.ts";

function ok(input: string) {
	const result = parseTarget(input);
	assert.equal(result.ok, true, `expected ${JSON.stringify(input)} to parse, got: ${JSON.stringify(result)}`);
	if (!result.ok) throw new Error("unreachable");
	return result.target;
}

function rejected(input: string, pattern: RegExp) {
	const result = parseTarget(input);
	assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected, got: ${JSON.stringify(result)}`);
	if (result.ok) throw new Error("unreachable");
	assert.match(result.error, pattern);
}

test("absolute URL keeps scheme, host, port and path, with the scheme's default port (S86)", () => {
	const t = ok("https://acme.com/x/y?a=1");
	assert.equal(t.scheme, "https");
	assert.equal(t.host, "acme.com");
	// S86: the URL class drops the default port; a scope rule "acme.com:443" needs it back.
	assert.equal(t.port, 443);
	assert.ok(t.normalizations.includes("default-port"));
	assert.equal(t.path, "/x/y");
	assert.equal(t.query, "a=1");
	assert.equal(t.isIp, false);
});

test("bare host defaults to no scheme and root path", () => {
	const t = ok("ACME.COM");
	assert.equal(t.scheme, null);
	assert.equal(t.host, "acme.com");
	assert.equal(t.path, "/");
	assert.deepEqual(t.normalizations, ["case-folded"]);
});

test("scheme-relative and host-with-path forms parse as authority", () => {
	assert.equal(ok("//acme.com/x").host, "acme.com");
	assert.equal(ok("acme.com/static/a.js").path, "/static/a.js");
	assert.equal(ok("acme.com:8080/x").port, 8080);
});

test("trailing dot is stripped and recorded", () => {
	const t = ok("http://acme.com./");
	assert.equal(t.host, "acme.com");
	assert.ok(t.normalizations.includes("trailing-dot"));
});

test("IDN is converted to punycode and never equals its ASCII lookalike", () => {
	// Cyrillic 'а' (U+0430), not ASCII 'a'.
	const t = ok("http://аcme.com/");
	assert.equal(t.host, "xn--cme-5cd.com");
	assert.notEqual(t.host, "acme.com");
	assert.ok(t.normalizations.includes("idn-to-punycode"));
});

test("already-punycoded host is preserved as-is", () => {
	assert.equal(ok("http://xn--cme-9cd.com/").host, "xn--cme-9cd.com");
});

test("legacy IPv4 spellings collapse to dotted-quad and are flagged", () => {
	for (const spelling of ["2130706433", "0177.0.0.1", "0x7f.0.0.1", "127.1"]) {
		const t = ok(`http://${spelling}/`);
		assert.equal(t.host, "127.0.0.1", `spelling ${spelling}`);
		assert.equal(t.isIp, true);
		assert.equal(t.ipVersion, 4);
		assert.ok(t.normalizations.includes("ipv4-legacy"), `spelling ${spelling}`);
	}
});

test("IPv6 literals drop brackets and are compressed", () => {
	const short = ok("http://[::1]/");
	const long = ok("http://[0:0:0:0:0:0:0:1]/");
	assert.equal(short.host, "::1");
	assert.equal(long.host, "::1");
	assert.equal(short.ipVersion, 6);
	assert.equal(short.isIp, true);
	assert.ok(long.normalizations.includes("ipv6-compressed"));
});

test("userinfo confusion: the contacted host is the one after the last @", () => {
	const t = ok("https://acme.com@otro.com/");
	assert.equal(t.host, "otro.com");
	assert.equal(t.userinfo, "acme.com");
});

test("userinfo with password is preserved separately from the host", () => {
	const t = ok("http://user:pass@acme.com:8443/p?q=1");
	assert.equal(t.host, "acme.com");
	assert.equal(t.port, 8443);
	assert.equal(t.userinfo, "user:pass");
	assert.equal(t.path, "/p");
});

test("percent-encoded dot is decoded before matching", () => {
	assert.equal(ok("http://acme.com%2eotro.com/").host, "acme.com.otro.com");
});

test("invalid IPv4-looking hosts are rejected, not guessed", () => {
	rejected("http://999.1.1.1/", /invalid url/);
	rejected("http://1.2.3.4.5/", /invalid url/);
});

test("empty, whitespace-only and control-character targets are rejected", () => {
	rejected("", /empty/);
	rejected("   ", /empty/);
	rejected("http://acme.com\t/", /whitespace|control/);
	rejected("http://acme.com\u0000evil.com/", /whitespace|control/);
});

test("tab smuggling does not yield the visible host", () => {
	const result = parseTarget("http://acme.com\tevil.com/");
	assert.equal(result.ok, false);
});

test("host syntax violations fail closed", () => {
	rejected("http://acme..com/", /host syntax/);
	rejected("http://-acme.com/", /host syntax/);
	rejected("http://acme-.com/", /host syntax/);
	rejected(`http://${"a".repeat(64)}.com/`, /host syntax/);
	rejected(`http://${"a.".repeat(130)}com/`, /too long/);
});

test("empty labels from a bare authority are rejected", () => {
	rejected("acme..com", /host syntax/);
});

test("path traversal markers do not change the host", () => {
	assert.equal(ok("http://acme.com/../otro.com/").host, "acme.com");
});
