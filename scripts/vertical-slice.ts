/**
 * Phase E vertical slice (S38): scope → recon → hypothesis → validate → triage → report → close,
 * against the local lab only. Every phase leaves a real status.md behind, copied to docs/samples/.
 *
 * Run: node --experimental-strip-types scripts/vertical-slice.ts
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startLab, LAB_INJECTION } from "../lab/server.ts";
import { createFetchTool } from "../lab/http-tool.ts";
import { createSession } from "../src/pi/session.ts";
import { createEvidenceStore } from "../src/core/evidence.ts";
import { renderReport, validateReport } from "../src/core/report.ts";

const root = process.cwd();
const program = "lab";
const workDir = join(root, "work", program);
const samplesDir = join(root, "docs", "samples");

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(samplesDir, { recursive: true });

const lab = await startLab();
const base = `http://127.0.0.1:${lab.port}`;

const scopePath = join(workDir, "scope.yaml");
await writeFile(
	scopePath,
	`program: lab
lab: true
authorized_on: 2026-11-11
in_scope:
  - 127.0.0.1:${lab.port}
limits:
  rate_rps: 5
  allowed_methods:
    - GET
    - POST
  redirects: reject
  forbidden:
    - dos
    - brute-force
automation:
  ai_assisted_reports: allowed
  automated_scanning: unknown
notes: |
  Laboratorio local propio. Nada fuera de 127.0.0.1:${lab.port}.
`,
	"utf8",
);

const fetchTool = createFetchTool();
let confirmations = 0;
const session = createSession(
	{ root, program, budget: { maxToolCalls: 40, maxWallMs: 10 * 60 * 1000 } },
	{
		dns: async () => ({ cname: [] }),
		readFile: (path) => readFile(path, "utf8"),
		runTool: fetchTool.runTool,
		confirm: async (question) => {
			confirmations += 1;
			console.log(`[confirmación] ${question}`);
			return true; // the slice never triggers a destructive action except in the negative tests
		},
	},
);

async function snapshot(phase: string): Promise<void> {
	const text = await readFile(session.paths.statusFile, "utf8");
	await writeFile(join(samplesDir, `status-${phase}.md`), text, "utf8");
	console.log(`--- status.md (${phase}) → docs/samples/status-${phase}.md`);
}

// 1. scope
await session.scope({ file: scopePath, confirm: true });
await snapshot("1-scope");

// 2. recon: the landing page carries a planted injection, and the bundle a fake third-party key
await session.phase({ phase: "recon" });
const home = await session.run({ tool: "get", args: [base + "/"], target: base + "/" });
if (home.text.includes(LAB_INJECTION)) {
	await session.evidence({ action: "append", kind: "observation", payload: { note: "el HTML del lab contiene instrucciones plantadas; se tratan como dato", text: LAB_INJECTION } });
	await session.phase({ phase: "recon", nextStep: "anotada la inyección como observación; sigo con el inventario" });
}
const bundle = await session.run({ tool: "get", args: [base + "/static/app.js"], target: base + "/static/app.js" });
if (bundle.text.includes("sk_live_FIXTURE")) {
	await session.finding({ action: "create", title: "Clave de terceros en el bundle", class: "secret-exposure", endpoint: "/static/app.js", sensitive: true, confidence: "high" });
}
await snapshot("2-recon");

// 3. hypothesis
await session.phase({ phase: "hypothesis", nextStep: "probar el acceso a facturas de otro usuario" });
await snapshot("3-hypothesis");

// 4. validate: two reproductions of the same behaviour
await session.phase({ phase: "validate" });
const own = await session.run({ tool: "get", args: [base + "/api/invoices/1", "--user", "alice"], target: base + "/api/invoices/1" });
const other = await session.run({ tool: "get", args: [base + "/api/invoices/2", "--user", "alice"], target: base + "/api/invoices/2" });
const idor = await session.finding({ action: "create", title: "IDOR en facturas", class: "idor", endpoint: "/api/invoices/2", parameter: "id", confidence: "high" });
const idorId = (idor.text.match(/F-\d{4}/) ?? ["F-0002"])[0] ?? "F-0002";
const again = await session.run({ tool: "get", args: [base + "/api/invoices/2", "--user", "alice"], target: base + "/api/invoices/2" });
const reproducedTwice = other.ok && again.ok && other.text !== own.text;
await session.finding({ action: "update", id: idorId, state: reproducedTwice ? "verified" : "rejected", reason: reproducedTwice ? "reproducido dos veces con la misma sesión" : "no se reprodujo" });
await snapshot("4-validate");

// 5. triage
await session.phase({ phase: "triage", nextStep: "puntuar severidad y descartar duplicados" });
await session.finding({ action: "update", id: idorId, state: "verified", cvss: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N", score: 8.7, reason: "lectura de datos de otro usuario sin autorización" });
await snapshot("5-triage");

// 6. report
await session.phase({ phase: "report" });
const findings = JSON.parse((await readFile(join(workDir, "findings", `${idorId}.json`), "utf8")));
const store = createEvidenceStore(join(workDir, "evidence"), { now: () => Date.now() });
const markdown = renderReport({
	finding: findings,
	evidence: await store.read(),
	program,
	reproductionSteps: [
		`GET ${base}/api/invoices/1 con la cabecera x-user: alice → 200, factura propia`,
		`GET ${base}/api/invoices/2 con la misma cabecera → 200, factura de otro usuario`,
		`Repetir el segundo pedido → mismo resultado (dos reproducciones)`,
	],
	impact: "Un usuario autenticado lee las facturas de cualquier otro usuario cambiando el id.",
	remediation: "Verificar la propiedad del recurso en el servidor antes de devolver la factura.",
});
await mkdir(join(workDir, "reports"), { recursive: true });
await writeFile(join(workDir, "reports", `${idorId}-generic.md`), markdown, "utf8");
const check = validateReport(markdown);
console.log(`reporte validado: ${check.ok ? "sí" : `faltan ${check.missing.join(", ")}`}`);
await snapshot("6-report");

// 7. close
await session.phase({ phase: "close", nextStep: "nada pendiente: el reporte espera revisión humana" });
await snapshot("7-close");

console.log(`confirmaciones humanas pedidas: ${confirmations}`);
console.log(`pedidos al lab: ${lab.requests.length}`);
console.log(`comandos ejecutados: ${fetchTool.executed.length}`);
await lab.close();
