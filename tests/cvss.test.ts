/**
 * S42: CVSS v4.0 scoring.
 *
 * Expectations come from three places, in this order of strength:
 *   1. values the specification fixes (no impact = 0.0, the maximum = 10.0);
 *   2. scores published for well-known vectors (Log4Shell's base vector = 9.3);
 *   3. vectors that are the highest severity of their own MacroVector, where the specification says the
 *      score is exactly the lookup value for that MacroVector. This is what exercises the
 *      interpolation code without inventing numbers.
 *
 * The lookup table itself is vendored from FIRST's reference calculator (see docs/prior-art.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CVSS_LOOKUP } from "../src/core/cvss-data.ts";
import { macroVector, parseVector, scoreVector } from "../src/core/cvss.ts";

function score(vector: string): number {
	const result = scoreVector(vector);
	assert.ok(!("ok" in result), JSON.stringify(result));
	if ("ok" in result) throw new Error("unreachable");
	return result.score;
}

const WORST = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H";
const NOTHING = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N";

test("the specification's extremes hold", () => {
	assert.equal(score(WORST), 10);
	assert.equal(score(NOTHING), 0);
});

test("Log4Shell's base vector scores 9.3, as published", () => {
	assert.equal(score("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), 9.3);
});

test("the all-worst vector is maximal: its score is the table value for its MacroVector", () => {
	const parsed = parseVector(WORST);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const macro = macroVector(parsed.metrics);
	assert.equal(score(WORST), CVSS_LOOKUP[macro]);
});

test("interpolation never raises a vector above its MacroVector score", () => {
	// A real invariant of the algorithm: the MacroVector value is the score of the *highest* vector in
	// that group, so every other vector in it scores at or below it.
	const vectors = [
		"CVSS:4.0/AV:A/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
		"CVSS:4.0/AV:N/AC:H/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
		"CVSS:4.0/AV:L/AC:L/AT:N/PR:H/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
		"CVSS:4.0/AV:P/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
		"CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N",
		"CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:L/SC:L/SI:L/SA:L",
		"CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:H/VI:L/VA:N/SC:L/SI:N/SA:L",
	];
	for (const vector of vectors) {
		const parsed = parseVector(vector);
		assert.equal(parsed.ok, true, vector);
		if (!parsed.ok) continue;
		const macro = macroVector(parsed.metrics);
		const top = CVSS_LOOKUP[macro] ?? 10;
		const value = score(vector);
		assert.ok(value <= top, `${vector} scored ${value} above its MacroVector ${macro} (${top})`);
		assert.ok(value >= 0, `${vector} scored below zero`);
	}
});

test("raising any metric never lowers the score", () => {
	const base = "CVSS:4.0/AV:L/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:L/SC:L/SI:L/SA:L";
	const raised = base
		.replace("AV:L", "AV:N")
		.replace("AC:H", "AC:L")
		.replace("AT:P", "AT:N")
		.replace("PR:H", "PR:N")
		.replace("UI:A", "UI:N")
		.replace("VC:L", "VC:H")
		.replace("VI:L", "VI:H")
		.replace("VA:L", "VA:H");
	assert.ok(score(raised) > score(base), `${score(raised)} should exceed ${score(base)}`);
});

test("severity buckets follow the specification", () => {
	const critical = scoreVector(WORST);
	assert.ok(!("ok" in critical));
	if (!("ok" in critical)) assert.equal(critical.severity, "critical");
	const none = scoreVector(NOTHING);
	assert.ok(!("ok" in none));
	if (!("ok" in none)) assert.equal(none.severity, "none");
});

test("vectors the parser must reject", () => {
	const invalid = [
		"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
		"CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H",
		"CVSS:4.0/AV:X/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
		"CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/MAV:N",
		"CVSS:4.0/AV:N/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
	];
	for (const vector of invalid) assert.equal(parseVector(vector).ok, false, vector);
});

test("the lookup table is the official one, not a stub", () => {
	assert.equal(Object.keys(CVSS_LOOKUP).length, 270);
	assert.equal(CVSS_LOOKUP["000000"], 10);
});
