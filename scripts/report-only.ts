/**
 * S76/task 7 (segunda mitad): run only the reporter + report over the already verified finding, so a
 * failure in the prose step does not require re-running the verifier.
 *
 * Usage: node --experimental-strip-types scripts/report-only.ts [programa] [finding]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";
import { createPiRunner } from "../src/pi/runner.ts";
import { extractProse } from "./lib/prose.ts";

const root = process.cwd();
const program = process.argv[2] ?? "lab-flow";
const findingId = process.argv[3] ?? "F-0001";
const port = Number((await readFile(join(root, ".lab", "port"), "utf8")).trim());
const base = `http://127.0.0.1:${port}`;

const session = createSession(
	{ root, program, reportLang: "es", reportRedact: true },
	{
		dns: async () => ({ cname: [] }),
		readFile: (path) => readFile(path, "utf8"),
		runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		confirm: async () => true,
	},
);

const finding = JSON.parse(await readFile(join(root, "work", program, "findings", `${findingId}.json`), "utf8")) as {
	state: string;
	title: string;
	endpoint: string;
	parameter: string | null;
};
console.log(`hallazgo ${findingId}: ${finding.state} — ${finding.title} (${finding.endpoint})`);

const vector = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N";
const task = [
	"Escribí la prosa de un reporte de bug bounty de laboratorio. Devolvé SOLO un objeto JSON, sin bloque de código ni texto alrededor.",
	'Forma: {"summary":"...","steps":["..."],"impact":"...","remediation":"...","cwe":"CWE-639","sensitive_data":"..."}',
	"Reglas:",
	"- summary: al menos dos frases, distinta del título, factual, sin CVSS ni puntajes.",
	"- steps: un paso por reproducción, con método y URL.",
	"- impact: coherente con el vector; PR:N significa que NO hace falta autenticarse.",
	"- remediation: concreta, una o dos frases.",
	"- Escribí en español.",
	"- No menciones números de seq, hashes ni la cadena de evidencia: el reporte va a una plataforma. Decí \"reproducción 1\" y \"reproducción 2\".",
	`Datos: hallazgo ${findingId}, endpoint ${finding.endpoint}${finding.parameter === null ? "" : ` (parámetro ${finding.parameter})`}, título ${JSON.stringify(finding.title)}.`,
	`Vector: ${vector}.`,
	`Podés leer la cadena de evidencia en ${join(root, "work", program, "evidence", "log.jsonl")} (registros execution y execution-result, con seq).`,
].join("\n");

// S78: with a saved prose file there is no model call at all.
const prosePath = join(root, "work", program, "reports", `${findingId}.prose.json`);
const saved = await readFile(prosePath, "utf8").then((text) => text, () => null);
if (saved !== null) {
	const cached = extractProse(saved);
	await writeReport(cached.value as Record<string, unknown>);
	process.exit(0);
}

const runner = createPiRunner({ piCommand: ["pi"], extensionEntry: join(root, "extensions", "bounty.ts"), defaultTimeoutMs: 10 * 60 * 1000 });
const started = Date.now();
const reporter = await runner.run({
	agent: { name: "bounty-reporter", tools: ["read", "grep", "find", "ls"] },
	task,
	cwd: root,
	env: { GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PROGRAM: program },
	timeoutMs: 10 * 60 * 1000,
});
const extracted = extractProse(reporter.output);
console.log(`reporter: exit=${String(reporter.exitCode)} ${Math.round((Date.now() - started) / 1000)}s · tools=${reporter.activeTools.join(",")}`);
console.log(`extracción: ${extracted.strategy}${extracted.diagnosis.length > 0 ? ` — ${extracted.diagnosis}` : ""}`);
if (extracted.value === null) {
	console.log("salida cruda (primeros 600):", JSON.stringify(reporter.output.slice(0, 600)));
	process.exit(1);
}
const prose = extracted.value as Record<string, unknown>;
// Saved so a later re-render does not need another model call.
await mkdir(join(root, "work", program, "reports"), { recursive: true });
await writeFile(join(root, "work", program, "reports", `${findingId}.prose.json`), JSON.stringify(prose, null, "\t") + "\n", "utf8");

await writeReport(prose as Record<string, unknown>);

async function writeReport(input: Record<string, unknown>): Promise<void> {
	const report = await session.report({
		findingId,
		metrics: { AV: "N", AC: "L", AT: "N", PR: "N", UI: "N", VC: "H", VI: "N", VA: "N", SC: "N", SI: "N", SA: "N" },
		summary: String(input.summary ?? ""),
		steps: Array.isArray(input.steps) ? input.steps.map(String) : [],
		impact: String(input.impact ?? ""),
		remediation: String(input.remediation ?? ""),
		...(typeof input.cwe === "string" ? { cwe: input.cwe } : {}),
		...(typeof input.sensitive_data === "string" ? { sensitiveData: input.sensitive_data } : {}),
	});
	console.log(`reporte: ${report.ok ? "escrito" : "rechazado"} — ${report.text.split("\n")[0]}`);
	if (!report.ok) process.exit(1);
	console.log("\n--- REPORTE EXTERNO ---\n");
	console.log(await readFile(join(root, "work", program, "reports", `${findingId}.md`), "utf8"));
	console.log(`\n(copia interna con seqs y hashes: work/${program}/evidence/${findingId}.report-internal.md)`);
	console.log(`(base: ${base})`);
}
