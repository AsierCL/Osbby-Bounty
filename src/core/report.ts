/**
 * Canonical report renderer (S14/C7, S75/task 3).
 *
 * Layout is fixed, and the parts that must not contradict the numbers are generated here:
 * - "Condiciones previas" comes from the CVSS vector (AV, PR, UI), never from prose.
 * - "Evidencia" extracts method, URL, headers, status and a truncated body from the chain by seq,
 *   separating the initial finding from the verifier's signed reproduction.
 * - Redaction of secrets and third-party personal data is ON by default and operator-controlled; it
 *   only affects the written report, never what the model sees.
 *
 * CVSS: this renderer takes a v4.0 vector and score that were already validated; it does not compute
 * scores.
 */
import { parseVector, scoreVector } from "./cvss.ts";
import type { Finding } from "./findings.ts";
import type { EvidenceRecord } from "./evidence.ts";

export type ReportLang = "en" | "es";

export interface ReportInput {
	finding: Finding;
	records: EvidenceRecord[];
	program: string;
	/** Model-authored prose. The validator rejects a summary that is the title again. */
	summary: string;
	steps: string[];
	impact: string;
	remediation: string;
	cwe: string | null;
	sensitiveData: string | null;
	lang: ReportLang;
	redact: boolean;
	/** Seqs the verifier reproduced (from the verification record). */
	reproSeqs: number[];
	/** First execution against the finding's endpoint, the initial report. */
	initialSeq: number | null;
	/** (b) contradictions the validator must surface without rejecting the report. */
	warnings?: string[];
}

export interface ReportValidation {
	ok: boolean;
	errors: string[];
	warnings: string[];
}

const LABELS = {
	en: {
		severity: "Severity",
		class: "Class",
		endpoint: "Endpoint",
		program: "Program",
		state: "State",
		warning: "Warning",
		summary: "Summary",
		conditions: "Prerequisites",
		steps: "Reproduction steps",
		evidence: "Evidence",
		impact: "Impact",
		remediation: "Remediation",
		sensitive: "Exposed sensitive data",
		initial: "Initial finding",
		reproduction: "Verifier reproduction",
		omitted: "Not documented",
		signed: "signature valid (HMAC of this invocation)",
		unsigned: "no signature in the record",
		expected: "Expected",
		observed: "Observed",
		none: "none",
		status: "status",
		truncated: "truncated",
	},
	es: {
		severity: "Severidad",
		class: "Clase",
		endpoint: "Endpoint",
		program: "Programa",
		state: "Estado",
		warning: "Aviso",
		summary: "Resumen",
		conditions: "Condiciones previas",
		steps: "Pasos de reproducción",
		evidence: "Evidencia",
		impact: "Impacto",
		remediation: "Remediación",
		sensitive: "Dato sensible expuesto",
		initial: "Hallazgo inicial",
		reproduction: "Reproducción del verificador",
		omitted: "Sin documentar",
		signed: "firma válida (HMAC de esta invocación)",
		unsigned: "sin firma en el registro",
		expected: "Esperado",
		observed: "Observado",
		none: "ninguna",
		status: "estado",
		truncated: "truncado",
	},
} as const;

/** A vector is valid when the CVSS parser accepts it: shape and metric values, both. */
export function validateVector(vector: string): boolean {
	return parseVector(vector).ok;
}

/** Condition sentences derived from the vector. Prose cannot override them. */
export function deriveConditions(vector: string, lang: ReportLang): { text: string; metric: string; value: string }[] {
	const parsed = parseVector(vector);
	if (!parsed.ok) return [];
	const metric = (key: string) => parsed.metrics[key] ?? "";
	const out: { text: string; metric: string; value: string }[] = [];
	const es = lang === "es";
	const push = (name: string, value: string, esText: string, enText: string) => {
		if (value !== "") out.push({ metric: name, value, text: es ? esText : enText });
	};
	push("AV", metric("AV"), {
		N: "El atacante puede llegar por red, sin acceso previo al equipo.",
		A: "El atacante debe estar en el mismo segmento de red adyacente.",
		L: "El atacante necesita acceso local al equipo o a la cuenta.",
		P: "El atacante necesita acceso físico al dispositivo.",
	}[metric("AV")] ?? "", {
		N: "The attacker reaches the target over the network, with no prior access to the device.",
		A: "The attacker must be on an adjacent network segment.",
		L: "The attacker needs local access to the device or account.",
		P: "The attacker needs physical access to the device.",
	}[metric("AV")] ?? "");
	push("PR", metric("PR"), {
		N: "No requiere credenciales: el recurso responde sin sesión.",
		L: "Requiere credenciales de un usuario con privilegios bajos.",
		H: "Requiere credenciales de un usuario con privilegios altos o administrativos.",
	}[metric("PR")] ?? "", {
		N: "No credentials required: the resource answers without a session.",
		L: "Requires credentials of a user with low privileges.",
		H: "Requires credentials of a user with high or administrative privileges.",
	}[metric("PR")] ?? "");
	push("UI", metric("UI"), {
		N: "No requiere que la víctima haga nada.",
		P: "Requiere que la víctima esté usando el sistema en ese momento, sin acción deliberada.",
		A: "Requiere que la víctima realice una acción deliberada.",
	}[metric("UI")] ?? "", {
		N: "The victim does not have to do anything.",
		P: "Requires the victim to be using the system at that moment, without deliberate action.",
		A: "Requires the victim to take a deliberate action.",
	}[metric("UI")] ?? "");
	return out;
}

const CONTRADICTIONS: { metric: string; value: string; test: RegExp; message: string }[] = [
	{
		metric: "PR",
		value: "N",
		test: /\b(usuario autenticad|autenticad[oa]|con sesi[óo]n v[áa]lida|logged[- ]in|authenticated user|valid session|registered user)\b/i,
		message: "el texto libre habla de un usuario autenticado pero el vector declara PR:N (sin credenciales)",
	},
	{
		metric: "PR",
		value: "L",
		test: /\b(sin autenticaci[óo]n|no autenticad|without (any )?(authentication|credentials))\b/i,
		message: "el texto libre dice que no hace falta autenticarse pero el vector declara PR:L",
	},
	{
		metric: "PR",
		value: "H",
		test: /\b(sin autenticaci[óo]n|usuario (normal|com[úu]n)|low[- ]privilege)\b/i,
		message: "el texto libre habla de un usuario común pero el vector declara PR:H (privilegios altos)",
	},
	{
		metric: "UI",
		value: "N",
		test: /\b(la v[íi]ctima (debe|tiene que) (hacer clic|abrir|visitar)|victim (must|has to) (click|open|visit)|requiere interacci[óo]n|user interaction)\b/i,
		message: "el texto libre menciona interacción de la víctima pero el vector declara UI:N",
	},
	{
		metric: "AV",
		value: "N",
		test: /\b(acceso f[íi]sico|physical access|acceso local)\b/i,
		message: "el texto libre menciona acceso físico o local pero el vector declara AV:N (remoto)",
	},
];

/** (a)+(b): the prose checks the checklist would reject or warn about. */
export function validateReportText(input: {
	title: string;
	summary: string;
	impact: string;
	vector: string;
	lang: ReportLang;
}): ReportValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const labels = LABELS[input.lang];
	const summary = input.summary.trim();
	if (summary.length === 0) {
		errors.push(`el ${labels.summary.toLowerCase()} está vacío`);
	} else {
		if (summary === input.title.trim()) errors.push(`el ${labels.summary.toLowerCase()} no puede ser igual al título`);
		if ((summary.match(/[.!?](?:\s|$)/g) ?? []).length < 2) {
			errors.push(`el ${labels.summary.toLowerCase()} necesita al menos dos frases (el validador de la checklist lo exige)`);
		}
	}
	const parsed = parseVector(input.vector);
	if (parsed.ok) {
		for (const rule of CONTRADICTIONS) {
			if (parsed.metrics[rule.metric] !== rule.value) continue;
			if (rule.test.test(input.impact)) warnings.push(rule.message);
		}
	}
	return { ok: errors.length === 0, errors, warnings };
}

/** (d): masks secrets and third-party personal data. Only the written report goes through this. */
export function redactExtract(text: string, enabled: boolean): string {
	if (!enabled || text.length === 0) return text;
	let out = text;
	out = out.replace(/((?:set-)?cookie\s*:\s*)([^\r\n]+)/gi, "$1[redactado]");
	out = out.replace(/(authorization\s*:\s*)([^\r\n]+)/gi, "$1[redactado]");
	out = out.replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redactado]");
	out = out.replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{6,}\b/g, "[redactado-clave]");
	out = out.replace(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_all, domain: string) => `[redactado]@${domain}`);
	out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (candidate) => maskCard(candidate));
	return out;
}

function maskCard(raw: string): string {
	const digits = raw.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return raw;
	// Luhn: only a plausible card number is masked, so request ids survive.
	let sum = 0;
	for (let index = 0; index < digits.length; index += 1) {
		let digit = Number(digits[digits.length - 1 - index]);
		if (index % 2 === 1) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
	}
	if (sum % 10 !== 0) return raw;
	return `[redactado-tarjeta …${digits.slice(-4)}]`;
}

interface Extracted {
	seq: number;
	kind: string;
	ts: string;
	hash: string;
	method: string | null;
	url: string | null;
	headers: string[];
	status: string | null;
	body: string | null;
	signed: boolean;
	note: string | null;
}

function methodOf(argv: string[]): string {
	for (let index = 1; index < argv.length; index += 1) {
		if (argv[index] === "-X" || argv[index] === "--request") return (argv[index + 1] ?? "GET").toUpperCase();
	}
	return "GET";
}

function urlOf(argv: string[]): string | null {
	for (let index = argv.length - 1; index >= 1; index -= 1) {
		if (/^https?:\/\//.test(argv[index] as string)) return argv[index] as string;
	}
	return null;
}

function headersOf(argv: string[]): string[] {
	const out: string[] = [];
	for (let index = 1; index < argv.length; index += 1) {
		if (argv[index] === "-H" || argv[index] === "--header") {
			const value = argv[index + 1];
			if (typeof value === "string") out.push(value);
		}
	}
	return out;
}

export function statusAndBody(stdout: string): { status: string | null; body: string } {
	const trimmed = stdout.trim();
	const http = /^HTTP\/[\d.]+\s+(\d{3})/.exec(trimmed);
	if (http) return { status: http[1] as string, body: trimmed.split(/\r?\n/).slice(1).join("\n") };
	// curl -w '\n%{http_code}' puts the code on the last line.
	const lines = trimmed.split(/\r?\n/);
	const last = (lines.at(-1) ?? "").trim();
	if (/^\d{3}$/.test(last)) return { status: last, body: lines.slice(0, -1).join("\n") };
	return { status: null, body: trimmed };
}

function extractOne(record: EvidenceRecord, next: EvidenceRecord | undefined, enabled: boolean, lang: ReportLang): Extracted {
	const payload = record.payload as Record<string, unknown>;
	const argv = Array.isArray(payload.argv) ? (payload.argv as string[]) : [];
	const result = next !== undefined && next.kind === "execution-result" ? (next.payload as Record<string, unknown>) : null;
	const stdout = typeof result?.stdout === "string" ? (result.stdout as string) : "";
	const { status, body } = statusAndBody(stdout);
	const marker = lang === "es" ? "recortado" : LABELS.en.truncated;
	const truncated = body.length > 300 ? `${body.slice(0, 300)}… (${marker})` : body;
	return {
		seq: record.seq,
		kind: record.kind,
		ts: record.ts,
		hash: record.hash,
		method: record.kind === "execution" ? methodOf(argv) : null,
		url: record.kind === "execution" ? urlOf(argv) : null,
		headers: record.kind === "execution" ? headersOf(argv).map((header) => redactExtract(header, enabled)) : [],
		status,
		body: body.length === 0 ? null : redactExtract(truncated, enabled),
		signed: typeof payload.signature === "string" && (payload.signature as string).length === 64,
		note: typeof payload.text === "string" ? redactExtract(String(payload.text).slice(0, 300), enabled) : null,
	};
}

/** (c): evidence comes from the chain by seq; nothing here is written by the model. */
export function extractEvidence(
	records: EvidenceRecord[],
	input: { reproSeqs: number[]; initialSeq: number | null; redact: boolean; lang: ReportLang },
): { initial: Extracted | null; reproduction: Extracted[]; omitted: { seq: number; kind: string }[] } {
	const bySeq = new Map(records.map((record) => [record.seq, record]));
	const documented = new Set<number>(input.reproSeqs);
	if (input.initialSeq !== null) documented.add(input.initialSeq);
	const verdict = [...records].reverse().find((record) => record.kind === "verification");
	if (verdict !== undefined) documented.add(verdict.seq);
	const initial = input.initialSeq === null ? null : bySeq.get(input.initialSeq);
	const reproduction = input.reproSeqs
		.map((seq) => bySeq.get(seq))
		.filter((record): record is EvidenceRecord => record !== undefined)
		.map((record) => extractOne(record, bySeq.get(record.seq + 1), input.redact, input.lang));
	const seqs = records.map((record) => record.seq);
	const lowest = Math.min(...seqs);
	const highest = Math.max(...seqs);
	const omitted: { seq: number; kind: string }[] = [];
	for (let seq = lowest; seq <= highest; seq += 1) {
		if (documented.has(seq)) continue;
		const record = bySeq.get(seq);
		if (record !== undefined) omitted.push({ seq, kind: record.kind });
	}
	const initialExtract =
		initial === null || initial === undefined ? null : extractOne(initial, bySeq.get(initial.seq + 1), input.redact, input.lang);
	return { initial: initialExtract, reproduction, omitted };
}

export function renderReport(input: ReportInput): string {
	const { finding, lang } = input;
	const labels = LABELS[lang];
	const computed = finding.cvss === null ? null : scoreVector(finding.cvss);
	const scored = computed !== null && "score" in computed ? computed : null;
	const severity = scored === null ? "—" : `${scored.score.toFixed(1)} (${scored.severity}) — ${finding.cvss}`;
	const scoreMismatch =
		scored !== null && finding.score !== null && Math.abs(finding.score - scored.score) > 0.049
			? lang === "es"
				? `el score guardado (${finding.score.toFixed(1)}) no coincide con el calculado (${scored.score.toFixed(1)}); vale el calculado`
				: `the stored score (${finding.score.toFixed(1)}) does not match the computed one (${scored.score.toFixed(1)}); the computed one wins`
			: null;
	const vector = finding.cvss ?? "";
	const conditions = deriveConditions(vector, lang);
	const evidence = extractEvidence(input.records, { reproSeqs: input.reproSeqs, initialSeq: input.initialSeq, redact: input.redact, lang });
	// S76/task 5: redaction covers every text of the report, the reporter's prose included.
	const mask = (value: string): string => redactExtract(value, input.redact);
	const lines: string[] = [];
	lines.push(`# ${mask(finding.title)}`, "");
	lines.push(`**${labels.severity}:** ${severity}`);
	lines.push(`**${labels.class}:** ${finding.class}${input.cwe === null ? "" : ` (CWE: ${input.cwe})`}`);
	lines.push(`**${labels.endpoint}:** ${finding.endpoint}${finding.parameter === null ? "" : ` (${finding.parameter})`}`);
	lines.push(`**${labels.program}:** ${input.program}`);
	if (scoreMismatch !== null) lines.push(`**${labels.warning}:** ${scoreMismatch}`);
	for (const warning of input.warnings ?? []) lines.push(`**${labels.warning}:** ${mask(warning)}`);
	if (input.steps.length > 0 && input.reproSeqs.length > 0 && input.steps.length !== input.reproSeqs.length) {
		lines.push(
			`**${labels.warning}:** ${lang === "es" ? `${input.steps.length} pasos para ${input.reproSeqs.length} reproducciones: el esperado de cada reproducción puede no corresponder` : `${input.steps.length} steps for ${input.reproSeqs.length} reproductions: the expected outcome of each reproduction may be off`}`,
		);
	}
	lines.push(`**${labels.state}:** ${finding.state}`, "");

	lines.push(`## ${labels.summary}`, "", mask(input.summary), "");
	lines.push(`## ${labels.conditions}`, "");
	for (const condition of conditions) lines.push(`- ${mask(condition.text)}`);
	if (input.sensitiveData !== null) lines.push(`- **${labels.sensitive}:** ${mask(input.sensitiveData)}`);
	lines.push("");

	lines.push(`## ${labels.steps}`, "");
	input.steps.forEach((step, index) => lines.push(`${index + 1}. ${mask(step)}`));
	if (input.steps.length === 0) lines.push(`_${LABELS[lang].none}_`);
	lines.push("");

	lines.push(`## ${labels.evidence}`, "");
	if (evidence.initial !== null) {
		lines.push(`### ${labels.initial} (seq ${evidence.initial.seq})`, "");
		lines.push(...evidenceLines(evidence.initial, labels));
		lines.push("");
	}
	if (evidence.reproduction.length > 0) {
		const verdictSeq = [...input.records].reverse().find((record) => record.kind === "verification")?.seq;
		lines.push(`### ${labels.reproduction}${verdictSeq === undefined ? "" : lang === "es" ? ` (veredicto en seq ${verdictSeq})` : ` (verdict at seq ${verdictSeq})`}`, "");
		for (const [index, item] of evidence.reproduction.entries()) {
			lines.push(`**seq ${item.seq}** — ${item.signed ? labels.signed : labels.unsigned}`, "");
			lines.push(...evidenceLines(item, labels));
			if (input.steps.length > 0) {
				lines.push(`- ${labels.expected}: ${mask(input.steps[index] ?? "—")}`);
			}
			lines.push("");
		}
	}
	if (evidence.omitted.length > 0) {
		lines.push(`### ${labels.omitted}`, "");
		for (const item of evidence.omitted) lines.push(`- seq ${item.seq} · ${item.kind} — ${lang === "es" ? "no citado por el reporte" : "not cited by this report"}`);
		lines.push("");
	}

	lines.push(`## ${labels.impact}`, "", mask(input.impact), "");
	lines.push(`## ${labels.remediation}`, "", mask(input.remediation), "");
	return lines.join("\n");
}

function evidenceLines(item: Extracted, labels: (typeof LABELS)[ReportLang]): string[] {
	const out: string[] = [];
	out.push(`- sha256 ${item.hash.slice(0, 16)}… · ${item.ts}`);
	if (item.method !== null && item.url !== null) out.push(`- ${item.method} ${item.url}`);
	if (item.headers.length > 0) out.push(`- ${labels.observed} headers: ${item.headers.join(" · ")}`);
	out.push(`- ${labels.status}: ${item.status ?? "—"}`);
	if (item.body !== null) out.push(`- body: ${item.body.replace(/\n/g, " ").slice(0, 300)}`);
	if (item.note !== null) out.push(`- ${item.note}`);
	return out;
}

/** Checklist: what a platform would reject the report for. */
export function validateReport(markdown: string, lang: ReportLang = "es"): { ok: boolean; missing: string[] } {
	const labels = LABELS[lang];
	const sections = [labels.summary, labels.conditions, labels.steps, labels.evidence, labels.impact, labels.remediation];
	const missing = sections.filter((section) => !markdown.includes(`## ${section}`));
	const specifics = [
		{ label: "vector CVSS", test: /CVSS:4\.0\// },
		{ label: "evidencia con hash", test: /sha256 [0-9a-f]{16}/ },
		{ label: "pasos numerados", test: /^1\. /m },
	].filter((item) => !item.test.test(markdown)).map((item) => item.label);
	return { ok: missing.length === 0 && specifics.length === 0, missing: [...missing, ...specifics] };
}
