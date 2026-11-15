/**
 * S88: the browser wrapper checks every request against the scope. Third-party assets are blocked on
 * purpose: a browser is otherwise a channel the gate never sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeNavPolicy } from "../scripts/lib/nav-policy.ts";

const SCOPE = "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - www.acme.com\n  - 127.0.0.1:3000\nout_of_scope:\n  - admin.acme.com\nlimits:\n  rate_rps: 5\n";

test("in-scope navigations are allowed, out-of-scope and third-party ones are not", () => {
	const nav = makeNavPolicy(SCOPE);
	assert.equal(nav.decide("https://www.acme.com/login").allowed, true);
	assert.equal(nav.decide("http://127.0.0.1:3000/").allowed, true);
	assert.equal(nav.decide("https://admin.acme.com/x").allowed, false);
	assert.equal(nav.decide("https://js.datadome.co/tags.js").allowed, false);
	assert.match(nav.decide("https://js.datadome.co/tags.js").reason, /no in_scope rule matched/);
});

test("non-network schemes are not treated as traffic", () => {
	const nav = makeNavPolicy(SCOPE);
	assert.equal(nav.decide("data:image/png;base64,AAA").allowed, true);
	assert.equal(nav.decide("about:blank").allowed, true);
});

test("a scope that does not parse refuses to build the policy", () => {
	assert.throws(() => makeNavPolicy("program: [\n"), /scope does not parse/);
});
