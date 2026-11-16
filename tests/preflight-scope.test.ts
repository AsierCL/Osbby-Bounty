/**
 * S75/task 4: the offline preflight prints the same interpreted summary as bounty_scope, plus legible
 * warnings about the things that usually go wrong in a real scope file. Read-only, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { preflightScope } from "../src/core/preflight.ts";
import { parseScope, summarizeScope } from "../src/core/scope.ts";

const BASE = `program: acme
lab: false
authorized_on: 2026-01-02
in_scope:
  - acme.com
out_of_scope:
  - staging.acme.com
limits:
  rate_rps: 2
  allowed_methods:
    - GET
`;

test("the summary is the one bounty_scope prints, not a second description", () => {
	const preflight = preflightScope(BASE, { now: () => Date.parse("2026-03-01T00:00:00Z") });
	assert.equal(preflight.ok, true);
	const parsed = parseScope(BASE);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(preflight.text.split("\n").slice(0, 6).join("\n"), summarizeScope(parsed.policy).split("\n").slice(0, 6).join("\n"));
	assert.match(preflight.text, /Ritmo declarado: 2 req\/s/);
	assert.match(preflight.text, /Fuera de alcance: 1 regla/);
});

test("a wildcard without a port says it covers every port", () => {
	const preflight = preflightScope(BASE.replace("- acme.com", "- *.acme.com"));
	assert.equal(preflight.ok, true);
	assert.match(preflight.warnings.join(" "), /no fija puerto: cubre todos los puertos/);
	// With an explicit port the warning is not there.
	const pinned = preflightScope(BASE.replace("- acme.com", "- *.acme.com:8443"));
	assert.doesNotMatch(pinned.warnings.join(" "), /no fija puerto/);
});

test("no out_of_scope, missing rate and an imprudent rate each get a warning", () => {
	const noOut = preflightScope(BASE.replace(/out_of_scope:\n  - staging\.acme\.com\n/, ""));
	// S101: with concrete hosts in in_scope the absence of out_of_scope is not a warning-worthy gap.
	assert.match(noOut.warnings.join(" "), /no hace falta: con hosts explícitos en in_scope/);
	const wildcard = preflightScope(BASE.replace("- acme.com", "- *.acme.com").replace(/out_of_scope:\n  - staging\.acme\.com\n/, ""));
	assert.match(wildcard.warnings.join(" "), /agregá out_of_scope si algún subdominio/);
	const noRate = preflightScope(BASE.replace("  rate_rps: 2\n", ""));
	assert.match(noRate.warnings.join(" "), /no declara limits\.rate_rps/);
	const fast = preflightScope(BASE.replace("rate_rps: 2", "rate_rps: 40"));
	assert.match(fast.warnings.join(" "), /por encima de lo prudente/);
});

test("lab: false with a missing or future authorized_on is called out", () => {
	const now = () => Date.parse("2026-03-01T00:00:00Z");
	const missing = preflightScope(BASE.replace("authorized_on: 2026-01-02\n", ""), { now });
	assert.match(missing.warnings.join(" "), /lab: false sin authorized_on/);
	const future = preflightScope(BASE.replace("authorized_on: 2026-01-02", "authorized_on: 2027-01-01"), { now });
	assert.match(future.warnings.join(" "), /authorized_on está en el futuro/);
	const bad = preflightScope(BASE.replace("authorized_on: 2026-01-02", "authorized_on: ayer"), { now });
	assert.match(bad.warnings.join(" "), /no es una fecha legible/);
	const lab = preflightScope(BASE.replace("lab: false", "lab: true").replace("authorized_on: 2026-01-02\n", ""), { now });
	assert.doesNotMatch(lab.warnings.join(" "), /authorized_on/);
});

test("a scope that does not parse is reported with its errors and no policy", () => {
	const bad = preflightScope("program: [\n");
	assert.equal(bad.ok, false);
	assert.equal(bad.policy, null);
	assert.match(bad.text, /El alcance no parsea/);
});
