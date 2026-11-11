/**
 * Property suite for the matcher and the gate (S17a: "Añade fuzzing con propiedad: nunca 'in' ante la
 * duda").
 *
 * No dependency, no fixtures: a seeded PRNG generates hosts, rules and scope documents. The
 * invariants are the ones that matter for safety, not for aesthetics:
 *
 *   P1. `in` requires a label-boundary match against a real in_scope rule.
 *   P2. out_of_scope always wins.
 *   P3. A host that cannot be canonicalized is never `in`.
 *   P4. An unknown key is always a parse error.
 *   P5. Every rule in a parsed policy has a canonical host.
 *   P6. The gate never allows traffic the matcher calls `unknown` or `out`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, parseScope, type ScopePolicy } from "../src/core/scope.ts";
import { canonicalHost } from "../src/core/target.ts";
import { gate } from "../src/core/gate.ts";

function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const LABELS = ["a", "b", "acme", "com", "net", "billing", "api", "x1", "a-b", "xn--cme-5cd", "localhost", "0x7f", "127"];
const JUNK = ["..", ".", "-", "*", "..", " ", "\t", "%2e", "@", ":", "/", "CON", "₮"];

function pick<T>(random: () => number, items: T[]): T {
	return items[Math.floor(random() * items.length)] as T;
}

function randomHost(random: () => number): string {
	const parts = Math.floor(random() * 3) + 1;
	const labels: string[] = [];
	for (let index = 0; index < parts; index += 1) labels.push(pick(random, LABELS));
	let host = labels.join(".");
	if (random() < 0.12) host += pick(random, JUNK);
	return host;
}

function boundaryMatch(host: string, ruleHost: string, wildcard: boolean): boolean {
	if (host === ruleHost) return !wildcard;
	return wildcard && host.endsWith(`.${ruleHost}`);
}

function singleRulePolicy(rule: string, text: string): ScopePolicy | null {
	const parsed = parseScope(`program: p\nin_scope:\n  - ${JSON.stringify(rule)}\n${text}`);
	return parsed.ok ? parsed.policy : null;
}

test("P1: 'in' always comes from a label-boundary match on a real rule", () => {
	const random = prng(0xb0b0);
	let checked = 0;
	for (let iteration = 0; iteration < 400; iteration += 1) {
		const ruleHost = randomHost(random);
		const rule = random() < 0.5 ? `*.${ruleHost}` : ruleHost;
		const policy = singleRulePolicy(rule, "limits:\n  rate_rps: 5\n");
		if (!policy) continue;
		checked += 1;
		const targetHost = random() < 0.5 ? `${randomHost(random)}.${ruleHost}` : randomHost(random);
		const canonical = canonicalHost(targetHost);
		if (canonical === null) continue;
		const verdict = evaluate(policy, { host: canonical });
		if (verdict.verdict !== "in") continue;
		const matched = policy.inScope.find((candidate) => boundaryMatch(canonical, candidate.host, candidate.wildcard));
		assert.ok(matched, `'in' without a boundary match: host=${canonical} rule=${rule}`);
	}
	assert.ok(checked > 100, `only ${checked} rules parsed; the generator is not exercising the matcher`);
});

test("P2: an out_of_scope match always wins", () => {
	const random = prng(0xc0ffee);
	for (let iteration = 0; iteration < 300; iteration += 1) {
		const host = randomHost(random);
		const canonical = canonicalHost(host);
		if (canonical === null) continue;
		const policy = singleRulePolicy(`*.${canonical}`, "");
		if (!policy) continue;
		const withOut = parseScope(
			`program: p\nin_scope:\n  - "*.${canonical}"\nout_of_scope:\n  - ${JSON.stringify(canonical)}\nlimits:\n  rate_rps: 5\n`,
		);
		if (!withOut.ok) continue;
		const verdict = evaluate(withOut.policy, { host: canonical });
		assert.notEqual(verdict.verdict, "in", `out_of_scope lost for ${canonical}`);
	}
});

test("P3: a host that cannot be canonicalized is never 'in'", () => {
	const random = prng(0xdead);
	const policy = singleRulePolicy("*.acme.com", "");
	assert.ok(policy);
	if (!policy) return;
	for (let iteration = 0; iteration < 300; iteration += 1) {
		let host = "";
		const length = Math.floor(random() * 6) + 1;
		for (let index = 0; index < length; index += 1) host += pick(random, JUNK);
		if (canonicalHost(host) !== null) continue;
		const verdict = evaluate(policy, { host });
		assert.equal(verdict.verdict, "unknown", `junk host ${JSON.stringify(host)} produced ${verdict.verdict}`);
	}
});

test("P4: an unknown key is always a parse error, whatever its shape", () => {
	const random = prng(0x1234);
	const KNOWN = new Set([
		"program",
		"platform",
		"authorized_on",
		"in_scope",
		"out_of_scope",
		"limits",
		"required_headers",
		"automation",
		"notes",
	]);
	for (let iteration = 0; iteration < 300; iteration += 1) {
		const key = `k${Math.floor(random() * 1000)}`;
		if (KNOWN.has(key)) continue;
		const parsed = parseScope(`program: p\nin_scope:\n  - acme.com\n${key}: 1\n`);
		assert.equal(parsed.ok, false, `unknown key ${key} was accepted`);
	}
});

test("P5: every parsed rule has a canonical host and a usable pattern", () => {
	const random = prng(0xfeed);
	for (let iteration = 0; iteration < 300; iteration += 1) {
		const rule = random() < 0.4 ? `*.${randomHost(random)}` : randomHost(random);
		const parsed = parseScope(`program: p\nin_scope:\n  - ${JSON.stringify(rule)}\n`);
		if (!parsed.ok) continue;
		for (const candidate of parsed.policy.inScope) {
			assert.equal(candidate.host, canonicalHost(candidate.host), `rule host not canonical: ${candidate.host}`);
			assert.ok(!candidate.host.includes("*"), `wildcard leaked into host: ${candidate.host}`);
		}
	}
});

test("P6: the gate never allows what the matcher calls unknown or out", async () => {
	const random = prng(0x5150);
	// The gate refuses to run without a declared rate (S17a), so the fixture must declare one.
	const policy = singleRulePolicy("*.acme.com", "limits:\n  rate_rps: 5\n");
	assert.ok(policy);
	if (!policy) return;
	const deps = { dns: async () => ({ cname: [] as string[] }), readFile: async () => "" };
	let allowed = 0;
	for (let iteration = 0; iteration < 200; iteration += 1) {
		// Half the cases must be in scope, otherwise the property proves nothing.
		const host = random() < 0.5 ? `${pick(random, LABELS)}.acme.com` : randomHost(random);
		const canonical = canonicalHost(host);
		if (canonical === null) continue;
		const verdict = evaluate(policy, { host: canonical });
		const result = await gate(policy, { target: `http://${canonical}/`, headers: {}, argv: [] } as never, deps);
		if (verdict.verdict === "in") {
			if (result.allowed) allowed += 1;
			continue;
		}
		assert.equal(result.allowed, false, `gate allowed ${canonical} while the matcher said ${verdict.verdict}`);
	}
	assert.ok(allowed > 0, "the generator never produced an in-scope host; the property is vacuous");
});
