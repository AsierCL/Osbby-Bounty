/**
 * S87: a CNAME into shared CDN/cloud infrastructure is not leaving scope. The name of the CDN hop is
 * exempt from the name-in-scope rule; the addresses it ends up on are NOT exempt, and an internal
 * address (loopback, private, link-local, metadata) is still refused unless a lab says allow_private.
 *
 * The security question is "where does it end up", not "is the CDN's name in my scope".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { gate } from "../src/core/gate.ts";
import { isSharedInfrastructure } from "../src/core/gate.ts";
import { classifyAddress, isInternalAddress } from "../src/core/ip-safety.ts";
import { parseScope } from "../src/core/scope.ts";

function policy(options: { allowPrivate?: boolean } = {}) {
	const parsed = parseScope(
		[
			"program: lab",
			"lab: true",
			"authorized_on: 2026-01-01",
			options.allowPrivate === true ? "allow_private: true" : "",
			"in_scope:",
			"  - 127.0.0.1:3000",
			"  - acme.com:443",
			"  - www.acme.com:443",
			"  - 10.1.2.3",
			"limits:",
			"  rate_rps: 5",
			"",
		].join("\n"),
	);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

/** A resolver: host -> {cname, addresses}. */
const resolver = (table: Record<string, { cname?: string[]; addresses?: string[] }>) => async (host: string) => {
	const answer = table[host];
	if (answer === undefined) return { cname: [], addresses: [] };
	return { cname: answer.cname ?? [], addresses: answer.addresses ?? [] };
};

const deps = (table: Record<string, { cname?: string[]; addresses?: string[] }>) => ({ dns: resolver(table), readFile: async () => "" });

test("a host in scope whose CNAME goes to Fastly passes", async () => {
	const result = await gate(
		policy(),
		{ target: "https://www.acme.com/x", headers: {}, argv: [] } as never,
		deps({
			"www.acme.com": { cname: ["thefork.map.fastly.net"], addresses: ["151.101.1.1"] },
			"thefork.map.fastly.net": { cname: [], addresses: ["151.101.1.1"] },
		}),
	);
	assert.equal(result.allowed, true, JSON.stringify(result));
	if (result.allowed) assert.ok(result.notes.some((note) => /shared infrastructure/.test(note)), JSON.stringify(result.notes));
});

test("a CNAME to a domain that is neither listed nor in scope is still denied", async () => {
	const result = await gate(
		policy(),
		{ target: "https://www.acme.com/x", headers: {}, argv: [] } as never,
		deps({
			"www.acme.com": { cname: ["algo.que-ya-no-controlan.example"], addresses: ["203.0.113.9"] },
		}),
	);
	assert.equal(result.allowed, false, JSON.stringify(result));
	if (!result.allowed) {
		assert.match(result.reason, /cname target .* is not in scope/);
		assert.match(result.detail ?? "", /no in_scope rule matched/);
	}
});

test("the provider CNAME does not exempt the address: metadata, private and loopback are denied", async () => {
	for (const address of ["169.254.169.254", "10.0.0.5", "127.0.0.1", "100.64.1.1", "::1", "fd00::1", "fe80::1"]) {
		const result = await gate(
			policy(),
			{ target: "https://www.acme.com/x", headers: {}, argv: [] } as never,
			deps({
				"www.acme.com": { cname: ["edge.fastly.net"], addresses: [address] },
				"edge.fastly.net": { cname: [], addresses: [address] },
			}),
		);
		assert.equal(result.allowed, false, `${address}: ${JSON.stringify(result)}`);
		if (!result.allowed) assert.match(result.reason, /internal address/);
	}
});

test("a lab scope with allow_private accepts a name that resolves to a private address", async () => {
	const table = { "www.acme.com": { cname: [], addresses: ["10.0.0.5"] } };
	const denied = await gate(policy(), { target: "https://www.acme.com/x", headers: {}, argv: [] } as never, deps(table));
	assert.equal(denied.allowed, false);
	const allowed = await gate(policy({ allowPrivate: true }), { target: "https://www.acme.com/x", headers: {}, argv: [] } as never, deps(table));
	assert.equal(allowed.allowed, true, JSON.stringify(allowed));
});

test("allow_private is refused outside a lab", () => {
	const parsed = parseScope(
		"program: x\nlab: false\nauthorized_on: 2026-01-01\nallow_private: true\nin_scope:\n  - acme.com\nlimits:\n  rate_rps: 2\n",
	);
	assert.equal(parsed.ok, false);
	if (!parsed.ok) assert.match(parsed.errors.join(" "), /only allowed with lab/);
});

test("regressions: the bare token workaround still works, and a declared IP literal is not re-checked", async () => {
	// ATG-style: www.atg.se:443 as a bare token, behind a CDN.
	const bare = await gate(
		policy(),
		{ target: "www.acme.com:443", headers: {}, argv: ["-sS", "www.acme.com:443"] } as never,
		deps({
			"www.acme.com": { cname: ["acme.map.fastly.net"], addresses: ["151.101.1.1"] },
			"acme.map.fastly.net": { cname: [], addresses: ["151.101.1.1"] },
		}),
	);
	assert.equal(bare.allowed, true, JSON.stringify(bare));
	// A literal the operator declared in scope (labs): the address check does not re-litigate it.
	const literal = await gate(
		policy(),
		{ target: "http://127.0.0.1:3000/x", headers: {}, argv: [] } as never,
		deps({ "127.0.0.1": { cname: [], addresses: ["127.0.0.1"] } }),
	);
	assert.equal(literal.allowed, true, JSON.stringify(literal));
});

test("the address classifier and the suffix list are the ones the docs describe", () => {
	assert.equal(classifyAddress("8.8.8.8"), "public");
	assert.equal(classifyAddress("169.254.169.254"), "metadata");
	assert.equal(classifyAddress("::ffff:10.0.0.1"), "private");
	assert.equal(isInternalAddress("203.0.113.9"), false);
	assert.equal(isSharedInfrastructure("thefork.map.fastly.net"), true);
	assert.equal(isSharedInfrastructure("edge.elb.amazonaws.com"), true);
	assert.equal(isSharedInfrastructure("evilfastly.net"), false);
	assert.equal(isSharedInfrastructure("acme.com"), false);
});
