/**
 * S14/C7: one canonical format plus a checklist. The checklist is what a platform would reject the
 * report for, so it is enforced in code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreVector } from "../src/core/cvss.ts";
import { renderReport, validateReport, validateVector } from "../src/core/report.ts";
import type { Finding } from "../src/core/findings.ts";

const finding: Finding = {
	id: "F-0001",
	program: "lab",
	title: "IDOR en facturas",
	state: "verified",
	class: "idor",
	endpoint: "/api/invoices/2",
	parameter: "id",
	confidence: "high",
	cvss: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N",
	score: 8.7,
	sensitive: false,
	notes: ["Un usuario autenticado lee facturas ajenas."],
	fingerprint: "abc",
	transitions: [],
	createdAt: "2026-11-11T00:00:00Z",
	updatedAt: "2026-11-11T00:00:00Z",
};

const evidence = [{ seq: 3, kind: "execution-result", ts: "2026-11-11T00:00:00Z", hash: "a".repeat(64) }];

function report(overrides: Partial<Parameters<typeof renderReport>[0]> = {}) {
	return renderReport({
		finding,
		evidence,
		program: "lab",
		reproductionSteps: ["GET /api/invoices/1", "GET /api/invoices/2", "repetir"],
		impact: "Lectura de datos ajenos.",
		remediation: "Verificar propiedad.",
		...overrides,
	});
}

test("the canonical report carries severity, steps, hashes, impact and remediation", () => {
	const markdown = report();
	assert.match(markdown, /^# IDOR en facturas/m);
	// S42: the report computes the score from the vector; 8.7 is no longer taken on faith.
	const computed = scoreVector(finding.cvss as string);
	assert.ok(!("ok" in computed));
	if (!("ok" in computed)) {
		assert.match(markdown, new RegExp(`\\*\\*Severidad:\\*\\* ${computed.score.toFixed(1)} \\(`));
	}
	assert.ok(!markdown.includes("Aviso:"), "the stored score matches the computed one, so no warning");
	assert.match(markdown, /^1\. GET \/api\/invoices\/1/m);
	assert.match(markdown, /sha256 a{16}/);
	assert.match(markdown, /## Impacto/);
	assert.match(markdown, /## Remediación/);
	assert.deepEqual(validateReport(markdown), { ok: true, missing: [] });
});

test("a stored score that disagrees with the vector is flagged, and the computed one wins", () => {
	const markdown = report({ finding: { ...finding, score: 1.0 } });
	assert.match(markdown, /\*\*Aviso:\*\* el score guardado \(1\.0\) no coincide con el calculado/);
});

test("a report without a CVSS vector is rejected by the checklist", () => {
	const markdown = report({ finding: { ...finding, cvss: null, score: null } });
	const check = validateReport(markdown);
	assert.equal(check.ok, false);
	assert.ok(check.missing.includes("vector CVSS"));
});

test("a report without evidence hashes is rejected", () => {
	const check = validateReport(report({ evidence: [] }));
	assert.equal(check.ok, false);
	assert.ok(check.missing.includes("evidencia con hash"));
});

test("a report without numbered reproduction steps is rejected", () => {
	const check = validateReport(report({ reproductionSteps: [] }));
	assert.equal(check.ok, false);
	assert.ok(check.missing.includes("pasos numerados"));
});

test("CVSS vectors are validated for shape, not invented", () => {
	assert.equal(validateVector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N"), true);
	assert.equal(validateVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"), false);
	assert.equal(validateVector("CVSS:4.0/AV:X"), false);
	assert.equal(validateVector("nada"), false);
});
