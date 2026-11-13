/**
 * Task 12 / S75 task 2: the live flow against the lab — recon, finding, real verifier, report.
 *
 * Honest about what is real: the `curl` recon calls, the verifier run and the reporter run are real
 * processes; both children use the real model; the scope confirmation uses a human stand-in because
 * this runs headless (in a live session that is ctx.ui.select, already witnessed by the operator in
 * R1/R6).
 *
 * S75 task 2: the report prose is written by the MODEL (a reporter child with a read-only allowlist),
 * not by this script. The script only applies it through the same `bounty_report` path a session uses.
 *
 * Usage: node --experimental-strip-types scripts/live-flow.ts
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { createSession } from "../src/pi/session.ts";
import { createPiRunner } from "../src/pi/runner.ts";
import { parseVerdict, verifierTaskFor } from "../src/pi/verifier.ts";

const root = process.cwd();
const program = "lab-flow";
const port = Number((await readFile(join(root, ".lab", "port"), "utf8")).trim());
const base = `http://127.0.0.1:${port}`;

const scopePath = join(root, "work", program, "scope.yaml");
await mkdir(join(root, "work", program), { recursive: true });
await writeFile(
	scopePath,
	`program: ${program}\nlab: true\nauthorized_on: ${new Date().toISOString().slice(0, 10)}\nin_scope:\n  - 127.0.0.1:${port}\nlimits:\n  rate_rps: 5\n  allowed_methods:\n    - GET\n  redirects: reject\n`,
	"utf8",
);

const exec = (argv: string[]) =>
	new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
		const [command, ...args] = argv;
		execFile(command as string, args, { cwd: root }, (error, stdout, stderr) => {
			resolve({ exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});

const session = createSession(
	{ root, program, reportLang: "es", reportRedact: true },
	{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: exec, confirm: async () => true },
);

// 1. scope
const scoped = await session.scope({ file: scopePath });
console.log(`1. scope: ${scoped.ok ? "cargado" : scoped.text.split("\n")[0]}`);

// 2. recon with real curl
const home = await session.run({ tool: "curl", args: ["-sS", `${base}/`], target: `${base}/` });
const idor = await session.run({ tool: "curl", args: ["-sS", `${base}/api/invoices/2`], target: `${base}/api/invoices/2` });
console.log(`2. recon: portada ${home.ok ? "200" : "error"} · factura ajena: ${(idor.text.match(/\{"id":2[^}]*\}/) ?? ["?"])[0].slice(0, 60)}`);

// 3. finding
const created = await session.finding({
	action: "create",
	title: "IDOR en facturas del lab",
	class: "idor",
	endpoint: "/api/invoices/2",
	parameter: "id",
});
const findingId = (created.text.match(/F-\d{4}/) ?? [])[0] ?? "";
console.log(`3. finding: ${findingId} (${created.text.slice(0, 60)})`);

// 4. real verifier child
const asset = await readFile(join(root, "assets", "agents", "bounty-verify.md"), "utf8");
const tools = (/^tools:\s*(.+)$/m.exec(asset)?.[1] ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
const store = createEvidenceStore(join(root, "work", program, "evidence"), { now: () => Date.now() });
const runner = createPiRunner({ piCommand: ["pi"], extensionEntry: join(root, "extensions", "bounty.ts"), defaultTimeoutMs: 20 * 60 * 1000 });
const result = await runner.run({
	agent: { name: "bounty-verify", tools },
	task: verifierTaskFor({ id: findingId }, await store.read()),
	cwd: root,
	env: { GENTLE_BOUNTY_ROOT: root },
	timeoutMs: 20 * 60 * 1000,
});
const verdict = parseVerdict(result.output);
console.log(`4. verificador: exit=${String(result.exitCode)} ${Math.round(result.durationMs / 1000)}s · tools=${result.activeTools.join(",")}`);
console.log(`   veredicto: ${verdict === null ? "ILEGIBLE" : `${verdict.verdict} seqs=${verdict.seqs.join(",")} (${verdict.reason.slice(0, 60)})`}`);

const applied = await session.applyVerifierVerdict({
	findingId,
	verdict: verdict?.verdict ?? null,
	seqs: verdict?.seqs ?? [],
	reason: verdict?.reason ?? "",
	verifierSessionId: result.sessionId,
	invocationToken: result.invocationToken,
});
console.log(`5. aplicación: ${applied.ok ? "OK" : "NO"} — ${applied.text.split("\n")[0].slice(0, 140)}`);

// 6. report, only if verified
const finding = JSON.parse(await readFile(join(root, "work", program, "findings", `${findingId}.json`), "utf8"));
if (finding.state !== "verified") {
	console.log(`6. reporte: NO se escribe (el hallazgo está en ${finding.state}).`);
	process.exit(0);
}
// The prose comes from a real model with a read-only allowlist: the script does not write it.
const vector = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N";
const reporterTask = [
	"Escribí la prosa de un reporte de bug bounty de laboratorio. Devolvé SOLO un objeto JSON, sin bloque de código ni texto alrededor.",
	'Forma: {"summary":"...","steps":["..."],"impact":"...","remediation":"...","cwe":"CWE-639","sensitive_data":"..."}',
	"Reglas:",
	"- summary: al menos dos frases, distinta del título, factual, sin CVSS ni puntajes.",
	"- steps: un paso por reproducción, con método y URL.",
	"- impact: coherente con el vector; PR:N significa que NO hace falta autenticarse.",
	"- remediation: concreta, una o dos frases.",
	"- Escribí en español.",
	`Datos: hallazgo ${findingId}, endpoint ${finding.endpoint}${finding.parameter === null ? "" : ` (parámetro ${finding.parameter})`}, título ${JSON.stringify(finding.title)}.`,
	`Vector: ${vector}.`,
	`Podés leer la cadena de evidencia en ${join(root, "work", program, "evidence", "log.jsonl")} (registros execution y execution-result, con seq).`,
].join("\n");
const started = Date.now();
const reporter = await runner.run({
	agent: { name: "bounty-reporter", tools: ["read", "grep", "find", "ls"] },
	task: reporterTask,
	cwd: root,
	env: { GENTLE_BOUNTY_ROOT: root },
	timeoutMs: 10 * 60 * 1000,
});
const prose = (() => {
	const raw = reporter.output.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
})();
console.log(
	`6. reporter (modelo): exit=${String(reporter.exitCode)} ${Math.round((Date.now() - started) / 1000)}s · tools=${reporter.activeTools.join(",")} · JSON ${prose === null ? "ILEGIBLE" : "ok"}`,
);
if (prose === null) {
	console.log("   el modelo no devolvió JSON: no escribo el reporte con prosa inventada.");
	process.exit(1);
}
const report = await session.report({
	findingId,
	metrics: { AV: "N", AC: "L", AT: "N", PR: "N", UI: "N", VC: "H", VI: "N", VA: "N", SC: "N", SI: "N", SA: "N" },
	summary: String(prose.summary ?? ""),
	steps: Array.isArray(prose.steps) ? prose.steps.map(String) : [],
	impact: String(prose.impact ?? ""),
	remediation: String(prose.remediation ?? ""),
	...(typeof prose.cwe === "string" ? { cwe: prose.cwe } : {}),
	...(typeof prose.sensitive_data === "string" ? { sensitiveData: prose.sensitive_data } : {}),
});
console.log(`7. reporte: ${report.ok ? "escrito" : "rechazado"} — ${report.text.split("\n")[0].slice(0, 200)}`);
if (report.ok) {
	const file = join(root, "work", program, "reports", `${findingId}.md`);
	const exists = await stat(file).then(() => true, () => false);
	console.log(`   archivo: ${file} (${exists ? "existe" : "FALTA"})`);
}
