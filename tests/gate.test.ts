/**
 * The gate (S10): it validates what is actually contacted, not the `target` field alone.
 *
 * Order of decisions, all fail-closed:
 *   1. method allowlist
 *   2. forbidden technique
 *   3. redirect policy
 *   4. required program headers
 *   5. explicit rate limit declared by the scope
 *   6. every contacted host (target + argv + list files + Host header) must be in scope
 *   7. DNS: resolution must succeed and every CNAME hop must be in scope
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
  - api.acme.com:8443
  - 127.0.0.1
  - "[::1]"
out_of_scope:
  - admin.acme.com
limits:
  rate_rps: 5
  forbidden:
    - dos
  allowed_methods:
    - GET
    - POST
  redirects: reject
required_headers:
  X-Bounty-Id: lab-1
automation:
  ai_assisted_reports: allowed
  automated_scanning: unknown
`;

function policy(text = SCOPE) {
	const parsed = parseScope(text);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

function dnsThat(...answers: Record<string, string[]>) {
	const table = Object.assign({}, ...answers);
	return async (host: string) => {
		if (host in table) return { cname: table[host] ?? [] };
		return { cname: [] };
	};
}

const headers = { "X-Bounty-Id": "lab-1" };
const readFileThat = (files: Record<string, string>) => async (path: string) => {
	if (path in files) return files[path] as string;
	throw new Error(`unexpected read of ${path}`);
};

function base(overrides: Record<string, unknown> = {}) {
	return {
		target: "https://a.acme.com/",
		headers,
		argv: [],
		dns: dnsThat(),
		readFile: readFileThat({}),
		...overrides,
	} as never;
}

test("an in-scope target is allowed and reported as contact", async () => {
	const result = await gate(policy(), base(), base());
	assert.equal(result.allowed, true);
	if (result.allowed) assert.deepEqual(result.contacts.map((contact) => contact.host), ["a.acme.com"]);
});

test("an unknown target is refused, not assumed", async () => {
	const result = await gate(policy(), base({ target: "https://otro.com/" }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /no in_scope rule matched/);
});

test("an explicitly excluded target is refused naming the rule", async () => {
	const result = await gate(policy(), base({ target: "https://admin.acme.com/" }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) {
		assert.match(result.reason, /out of scope/);
		assert.match(result.detail ?? "", /admin\.acme\.com/);
	}
});

test("an unparseable target is refused", async () => {
	const result = await gate(policy(), base({ target: "https://acme..com/" }), base());
	assert.equal(result.allowed, false);
});

test("a method outside the allowlist is refused", async () => {
	const result = await gate(policy(), base({ method: "DELETE" }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /method DELETE/);
});

test("an allowed method passes", async () => {
	const result = await gate(policy(), base({ method: "POST" }), base());
	assert.equal(result.allowed, true);
});

test("a forbidden technique is refused", async () => {
	const result = await gate(policy(), base({ technique: "dos" }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /forbidden technique dos/);
});

test("following redirects is refused when the program says reject", async () => {
	const result = await gate(policy(), base({ followRedirects: true }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /redirect/i);
});

test("redirects under a revalidate policy are allowed with an explicit note", async () => {
	const text = SCOPE.replace("redirects: reject", "redirects: revalidate");
	const result = await gate(policy(text), base({ followRedirects: true }), base());
	assert.equal(result.allowed, true);
	if (result.allowed) assert.ok(result.notes.some((note) => /redirect hop must be re-gated/.test(note)));
});

test("a missing required program header is refused", async () => {
	const result = await gate(policy(), base({ headers: {} }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /required header X-Bounty-Id/);
});

test("a scope without a declared rate is refused", async () => {
	const text = SCOPE.replace("  rate_rps: 5\n", "");
	const result = await gate(policy(text), base(), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /rate/i);
});

test("an out-of-scope URL hidden in argv is refused", async () => {
	const result = await gate(policy(), base({ argv: ["-u", "https://a.acme.com/", "-proxy", "https://otro.com:8080"] }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /otro\.com/);
});

test("an out-of-scope Host header override is refused", async () => {
	const result = await gate(policy(), base({ argv: ["-H", "Host: admin.acme.com"] }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /admin\.acme\.com/);
});

test("every host in a -l file is validated", async () => {
	const deps = {
		dns: dnsThat(),
		readFile: readFileThat({ "hosts.txt": "a.acme.com\n# comment\notro.com\n" }),
	};
	const result = await gate(policy(), base({ argv: ["-l", "hosts.txt"] }), deps);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /otro\.com/);
});

test("a fully in-scope -l file is allowed and its hosts are contacts", async () => {
	const deps = {
		dns: dnsThat(),
		readFile: readFileThat({ "hosts.txt": "a.acme.com\nb.acme.com\n" }),
	};
	const result = await gate(policy(), base({ argv: ["-l", "hosts.txt"] }), deps);
	assert.equal(result.allowed, true);
	if (result.allowed) {
		const hosts = result.contacts.map((contact) => contact.host).sort();
		assert.deepEqual(hosts, ["a.acme.com", "b.acme.com"]);
	}
});

test("a known local output file is not mistaken for a host", async () => {
	const result = await gate(policy(), base({ argv: ["-o", "out.json", "-target", "https://a.acme.com/"] }), base());
	assert.equal(result.allowed, true);
});

test("an ambiguous host-shaped token under an unknown flag is refused", async () => {
	// Fail-closed by design: `ambiguous.json` could be an output path or a hostname, and the gate
	// refuses to guess. Documented in docs/gate.md.
	const result = await gate(policy(), base({ argv: ["--whatever", "ambiguous.json"] }), base());
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /ambiguous\.json/);
});

test("DNS failure refuses the run", async () => {
	const result = await gate(
		policy(),
		base({ dns: async () => ({ error: "SERVFAIL" }) }),
		base(),
	);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.reason, /dns/i);
});

test("a CNAME pointing outside the scope is refused", async () => {
	const result = await gate(
		policy(),
		base({ dns: dnsThat({ "a.acme.com": ["acme-prod.s3.amazonaws.com"] }) }),
		base(),
	);
	assert.equal(result.allowed, false);
	if (!result.allowed) assert.match(result.detail ?? "", /s3\.amazonaws\.com/);
});

test("a CNAME chain that stays in scope is allowed", async () => {
	const result = await gate(
		policy(),
		base({ dns: dnsThat({ "a.acme.com": ["b.acme.com"], "b.acme.com": ["c.acme.com"] }) }),
		base(),
	);
	assert.equal(result.allowed, true);
	if (result.allowed) {
		assert.ok(result.contacts.some((contact) => contact.source === "cname"));
	}
});
