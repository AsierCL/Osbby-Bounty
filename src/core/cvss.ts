/**
 * CVSS v4.0 scoring (S42).
 *
 * A port of the official scoring algorithm, as described in the CVSS v4.0 specification and
 * implemented by FIRST's reference calculator. The lookup table and the composed/max severity data are
 * vendored from that calculator in `cvss-data.ts` with its BSD-2-Clause license registered in
 * `docs/prior-art.md`.
 *
 * What is implemented: base metrics plus the optional Threat (E) and Environmental
 * Confidentiality/Integrity/Availability Requirement (CR/IR/AR) metrics, which the algorithm folds in
 * through `m()`. Modified (M*) metrics are rejected instead of silently ignored.
 */

import { CVSS_LOOKUP, MAX_COMPOSED, MAX_SEVERITY } from "./cvss-data.ts";

export type Severity = "none" | "low" | "medium" | "high" | "critical";

export interface CvssResult {
	vector: string;
	score: number;
	severity: Severity;
	macroVector: string;
}

export type CvssParse = { ok: true; metrics: Record<string, string> } | { ok: false; errors: string[] };

/** Base metrics are mandatory; the optional ones are folded in when present. */
const METRIC_VALUES: Record<string, string[]> = {
	AV: ["N", "A", "L", "P"],
	AC: ["L", "H"],
	AT: ["N", "P"],
	PR: ["N", "L", "H"],
	UI: ["N", "P", "A"],
	VC: ["H", "L", "N"],
	VI: ["H", "L", "N"],
	VA: ["H", "L", "N"],
	SC: ["H", "L", "N"],
	SI: ["H", "L", "N"],
	SA: ["H", "L", "N"],
	E: ["X", "A", "P", "U"],
	CR: ["X", "H", "M", "L"],
	IR: ["X", "H", "M", "L"],
	AR: ["X", "H", "M", "L"],
};

const REQUIRED = ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"];

const LEVELS: Record<string, Record<string, number>> = {
	AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 },
	PR: { N: 0, L: 0.1, H: 0.2 },
	UI: { N: 0, P: 0.1, A: 0.2 },
	AC: { L: 0, H: 0.1 },
	AT: { N: 0, P: 0.1 },
	VC: { H: 0, L: 0.1, N: 0.2 },
	VI: { H: 0, L: 0.1, N: 0.2 },
	VA: { H: 0, L: 0.1, N: 0.2 },
	SC: { H: 0.1, L: 0.2, N: 0.3 },
	SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
	SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
	CR: { H: 0, M: 0.1, L: 0.2 },
	IR: { H: 0, M: 0.1, L: 0.2 },
	AR: { H: 0, M: 0.1, L: 0.2 },
};

export function parseVector(vector: string): CvssParse {
	const errors: string[] = [];
	const trimmed = vector.trim();
	if (!trimmed.startsWith("CVSS:4.0/")) {
		return { ok: false, errors: [`vector must start with "CVSS:4.0/", got ${JSON.stringify(trimmed.slice(0, 16))}`] };
	}
	const metrics: Record<string, string> = {};
	for (const part of trimmed.slice("CVSS:4.0/".length).split("/")) {
		if (part.length === 0) continue;
		const separator = part.indexOf(":");
		if (separator <= 0) {
			errors.push(`malformed metric ${JSON.stringify(part)}`);
			continue;
		}
		const name = part.slice(0, separator);
		const value = part.slice(separator + 1);
		if (!(name in METRIC_VALUES)) {
			// Modified metrics are deliberately unsupported: ignoring them would silently change the score.
			errors.push(name.startsWith("M") ? `modified metric ${name} is not supported` : `unknown metric ${name}`);
			continue;
		}
		if (metrics[name] !== undefined) {
			errors.push(`duplicate metric ${name}`);
			continue;
		}
		if (!(METRIC_VALUES[name] as string[]).includes(value)) {
			errors.push(`invalid value ${JSON.stringify(value)} for ${name}`);
			continue;
		}
		metrics[name] = value;
	}
	for (const name of REQUIRED) {
		if (metrics[name] === undefined) errors.push(`missing mandatory metric ${name}`);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, metrics };
}

/** Effective metric value: X defaults to the worst case, exactly as the specification says. */
function m(metrics: Record<string, string>, name: string): string {
	const selected = metrics[name];
	if (name === "E") return selected === undefined || selected === "X" ? "A" : selected;
	if (name === "CR" || name === "IR" || name === "AR") return selected === undefined || selected === "X" ? "H" : selected;
	if (selected === undefined) throw new Error(`missing metric ${name}`);
	return selected;
}

export function macroVector(metrics: Record<string, string>): string {
	const av = m(metrics, "AV");
	const pr = m(metrics, "PR");
	const ui = m(metrics, "UI");
	let eq1: number;
	if (av === "N" && pr === "N" && ui === "N") eq1 = 0;
	else if ((av === "N" || pr === "N" || ui === "N") && av !== "P") eq1 = 1;
	else eq1 = 2;

	const eq2 = m(metrics, "AC") === "L" && m(metrics, "AT") === "N" ? 0 : 1;

	const vc = m(metrics, "VC");
	const vi = m(metrics, "VI");
	const va = m(metrics, "VA");
	let eq3: number;
	if (vc === "H" && vi === "H") eq3 = 0;
	else if (vc === "H" || vi === "H" || va === "H") eq3 = 1;
	else eq3 = 2;

	const sc = m(metrics, "SC");
	const si = m(metrics, "SI");
	const sa = m(metrics, "SA");
	let eq4: number;
	if (si === "S" || sa === "S") eq4 = 0;
	else if (sc === "H" || si === "H" || sa === "H") eq4 = 1;
	else eq4 = 2;

	const e = m(metrics, "E");
	const eq5 = e === "A" ? 0 : e === "P" ? 1 : 2;

	const eq6 =
		(m(metrics, "CR") === "H" && vc === "H") || (m(metrics, "IR") === "H" && vi === "H") || (m(metrics, "AR") === "H" && va === "H")
			? 0
			: 1;

	return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`;
}

function metricValue(composed: string, metric: string): string {
	for (const part of composed.split("/")) {
		const separator = part.indexOf(":");
		if (separator > 0 && part.slice(0, separator) === metric) return part.slice(separator + 1);
	}
	throw new Error(`composed vector is missing ${metric}: ${composed}`);
}

function eqMaxes(macro: string, eq: number): string[] {
	const composed = MAX_COMPOSED[`eq${eq}`] as Record<string, unknown>;
	const level = Number(macro[eq - 1]);
	if (eq === 3) {
		const byEq6 = composed[String(level)] as Record<string, string[]>;
		return byEq6[macro[5] as string] ?? [];
	}
	return (composed[String(level)] as string[]) ?? [];
}

function severityDistance(current: Record<string, string>, maxVector: string, metric: string): number {
	return (LEVELS[metric] as Record<string, number>)[m(current, metric)]! - (LEVELS[metric] as Record<string, number>)[metricValue(maxVector, metric)]!;
}

const DISTANCE_METRICS = ["AV", "PR", "UI", "AC", "AT", "VC", "VI", "VA", "SC", "SI", "SA", "CR", "IR", "AR"];

function severityOf(score: number): Severity {
	if (score === 0) return "none";
	if (score < 4) return "low";
	if (score < 7) return "medium";
	if (score < 9) return "high";
	return "critical";
}

export function scoreVector(vector: string): CvssResult | { ok: false; errors: string[] } {
	const parsed = parseVector(vector);
	if (!parsed.ok) return parsed;
	const metrics = parsed.metrics;

	// "No impact" shortcut, straight from the specification.
	if (["VC", "VI", "VA", "SC", "SI", "SA"].every((metric) => m(metrics, metric) === "N")) {
		return { vector: vector.trim(), score: 0, severity: "none", macroVector: macroVector(metrics) };
	}

	const macro = macroVector(metrics);
	let value = CVSS_LOOKUP[macro];
	if (value === undefined) return { ok: false, errors: [`macroVector ${macro} is not in the lookup table`] };

	const eq = macro.split("").map(Number) as [number, number, number, number, number, number];
	const [eq1, eq2, eq3, eq4, eq5, eq6] = eq;

	const lower = (digits: number[]): number | undefined => CVSS_LOOKUP[digits.join("")];

	const eq1Lower = lower([eq1 + 1, eq2, eq3, eq4, eq5, eq6]);
	const eq2Lower = lower([eq1, eq2 + 1, eq3, eq4, eq5, eq6]);

	let eq3eq6Lower: number | undefined;
	if (eq3 === 0 && eq6 === 0) {
		const left = lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]);
		const right = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
		eq3eq6Lower = left === undefined ? right : right === undefined ? left : Math.max(left, right);
	} else if (eq3 === 1 && eq6 === 1) {
		eq3eq6Lower = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
	} else if (eq3 === 0 && eq6 === 1) {
		eq3eq6Lower = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
	} else if (eq3 === 1 && eq6 === 0) {
		eq3eq6Lower = lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]);
	} else {
		eq3eq6Lower = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1]);
	}
	const eq4Lower = lower([eq1, eq2, eq3, eq4 + 1, eq5, eq6]);
	const eq5Lower = lower([eq1, eq2, eq3, eq4, eq5 + 1, eq6]);

	const maxVectors: string[] = [];
	for (const a of eqMaxes(macro, 1)) {
		for (const b of eqMaxes(macro, 2)) {
			for (const c of eqMaxes(macro, 3)) {
				for (const d of eqMaxes(macro, 4)) {
					for (const e of eqMaxes(macro, 5)) maxVectors.push(a + b + c + d + e);
				}
			}
		}
	}

	let distances: Record<string, number> | null = null;
	for (const candidate of maxVectors) {
		const current: Record<string, number> = {};
		let negative = false;
		for (const metric of DISTANCE_METRICS) {
			const distance = severityDistance(metrics, candidate, metric);
			if (distance < 0) {
				negative = true;
				break;
			}
			current[metric] = distance;
		}
		if (negative) continue;
		distances = current;
		break;
	}
	if (distances === null) return { ok: false, errors: [`no max vector found for macroVector ${macro}`] };

	const maxSeverity = MAX_SEVERITY as Record<string, Record<string, number>>;
	const maxSeverityEq3Eq6 = (MAX_SEVERITY.eq3eq6 as unknown as Record<string, Record<string, number>>)[String(eq3)]?.[String(eq6)];

	const groups: { distance: number; available: number | undefined; max: number }[] = [
		{
			distance: distances.AV + distances.PR + distances.UI,
			available: eq1Lower === undefined ? undefined : value - eq1Lower,
			max: (maxSeverity.eq1 as Record<string, number>)[String(eq1)] * 0.1,
		},
		{
			distance: distances.AC + distances.AT,
			available: eq2Lower === undefined ? undefined : value - eq2Lower,
			max: (maxSeverity.eq2 as Record<string, number>)[String(eq2)] * 0.1,
		},
		{
			distance: distances.VC + distances.VI + distances.VA + distances.CR + distances.IR + distances.AR,
			available: eq3eq6Lower === undefined ? undefined : value - eq3eq6Lower,
			max: (maxSeverityEq3Eq6 ?? 1) * 0.1,
		},
		{
			distance: distances.SC + distances.SI + distances.SA,
			available: eq4Lower === undefined ? undefined : value - eq4Lower,
			max: (maxSeverity.eq4 as Record<string, number>)[String(eq4)] * 0.1,
		},
		{
			distance: 0, // EQ5 contributes no severity distance in the specification
			available: eq5Lower === undefined ? undefined : value - eq5Lower,
			max: (maxSeverity.eq5 as Record<string, number>)[String(eq5)] * 0.1,
		},
	];

	let sum = 0;
	let count = 0;
	for (const group of groups) {
		if (group.available === undefined) continue;
		count += 1;
		if (group.max <= 0) continue;
		sum += group.available * (group.distance / group.max);
	}

	const meanDistance = count === 0 ? 0 : sum / count;
	value -= meanDistance;
	if (value < 0) value = 0;
	if (value > 10) value = 10;
	const score = Math.round(value * 10) / 10;

	return { vector: vector.trim(), score, severity: severityOf(score), macroVector: macro };
}
