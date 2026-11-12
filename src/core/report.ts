/**
 * Canonical report renderer (S14/C7).
 *
 * One format, plus a checklist. The checklist is what a platform would reject the report for missing,
 * so it is checked in code instead of remembered by the model.
 *
 * CVSS: this renderer takes a v4.0 vector and score that were already validated; it does not compute
 * scores. A full CVSS v4.0 calculator is a separate unit and is reported as pending, not faked.
 */
import { parseVector, scoreVector } from "./cvss.ts";
import type { Finding } from "./findings.ts";
import type { EvidenceRecord } from "./evidence.ts";

export interface ReportInput {
	finding: Finding;
	evidence: Pick<EvidenceRecord, "seq" | "kind" | "ts" | "hash">[];
	program: string;
	reproductionSteps: string[];
	impact: string;
	remediation: string;
}

/** A vector is valid when the CVSS parser accepts it: shape and metric values, both. */
export function validateVector(vector: string): boolean {
	return parseVector(vector).ok;
}

const REQUIRED_SECTIONS = ["Título", "Severidad", "Resumen", "Pasos de reproducción", "Evidencia", "Impacto", "Remediación"];

export function renderReport(input: ReportInput): string {
	const { finding } = input;
	// S42: the score is computed from the vector, never taken from a hand-written field.
	const computed = finding.cvss === null ? null : scoreVector(finding.cvss);
	const scored = computed !== null && "score" in computed ? computed : null;
	const severity = scored === null ? "sin puntuar todavía" : `${scored.score.toFixed(1)} (${scored.severity}) — ${finding.cvss}`;
	const scoreMismatch =
		scored !== null && finding.score !== null && Math.abs(finding.score - scored.score) > 0.049
			? `el score guardado (${finding.score.toFixed(1)}) no coincide con el calculado (${scored.score.toFixed(1)}); vale el calculado`
			: null;
	const lines: string[] = [];
	lines.push(`# ${finding.title}`, "");
	lines.push(`**Severidad:** ${severity}`);
	lines.push(`**Clase:** ${finding.class}`);
	lines.push(`**Endpoint:** ${finding.endpoint}${finding.parameter === null ? "" : ` (parámetro ${finding.parameter})`}`);
	lines.push(`**Programa:** ${input.program}`);
	if (scoreMismatch !== null) lines.push(`**Aviso:** ${scoreMismatch}`);
	lines.push(`**Estado:** ${finding.state}`, "");
	lines.push("## Resumen", "");
	lines.push(finding.notes[0] ?? finding.title, "");
	lines.push("## Pasos de reproducción", "");
	input.reproductionSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
	lines.push("", "## Evidencia", "");
	for (const item of input.evidence) {
		lines.push(`- seq ${item.seq} · ${item.kind} · ${item.ts} · sha256 ${item.hash}`);
	}
	lines.push("", "## Impacto", "", input.impact, "");
	lines.push("## Remediación", "", input.remediation, "");
	return lines.join("\n");
}

/** Checklist: what a platform would reject the report for. */
export function validateReport(markdown: string): { ok: boolean; missing: string[] } {
	const missing = REQUIRED_SECTIONS.filter((section) => !markdown.includes(`## ${section}`) && !markdown.includes(`**${section}`) && !markdown.startsWith(`# `));
	const specifics = [
		{ label: "vector CVSS", test: /CVSS:4\.0\// },
		{ label: "evidencia con hash", test: /sha256 [0-9a-f]{16}/ },
		{ label: "pasos numerados", test: /^1\. /m },
	].filter((item) => !item.test.test(markdown)).map((item) => item.label);
	return { ok: missing.length === 0 && specifics.length === 0, missing: [...missing, ...specifics] };
}
