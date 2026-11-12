/**
 * S41: the live half of the subagent verification. It spawns a REAL `pi` child with the allowlist the
 * agent asset declares, captures the tools Pi reports in `agent_end`, and compares.
 *
 * A single extra tool is a critical finding: this script exits 2 and the report says stop.
 *
 * Run: node --experimental-strip-types scripts/verify-subagent.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ALLOWED_CHILD_TOOLS, createPiRunner } from "../src/pi/runner.ts";

const root = process.cwd();
const assetName = process.argv[2] ?? "bounty-recon";
const assetPath = join(root, "assets", "agents", `${assetName}.md`);

const asset = await readFile(assetPath, "utf8");
const declared = (asset.match(/^tools:\s*(.+)$/m)?.[1] ?? "")
	.split(",")
	.map((tool) => tool.trim())
	.filter(Boolean);
if (declared.length === 0) {
	console.error(`no tools declared in ${assetPath}`);
	process.exit(1);
}

const task =
	"Usá la herramienta bounty_status con program 'lab' y respondé únicamente la fase actual, en una palabra.";

const runner = createPiRunner({
	piCommand: ["pi"],
	extensionEntry: join(root, "extensions", "bounty.ts"),
	defaultTimeoutMs: 180_000,
});

const result = await runner.run({
	agent: { name: assetName, tools: declared },
	task,
	cwd: root,
	env: { GENTLE_BOUNTY_ROOT: root },
	timeoutMs: 180_000,
});

const reported = result.activeTools;
const extras = reported.filter((tool) => !declared.includes(tool));
const missing = declared.filter((tool) => !reported.includes(tool));
const critical = extras.length > 0;

const verdict = !result.ok
	? `FALLÓ: ${result.error ?? "sin detalle"}`
	: critical
		? `CRÍTICO: el hijo reporta tools fuera de su allowlist: ${extras.join(", ")}`
		: "OK: el hijo reporta exactamente su allowlist";

const evidence = `# Evidencia: tools del subagente real (S41)

Corrida real de un subagente con \`pi\` de verdad (no el stub de los tests), contra el lab local.

- Agente: \`${assetName}\`
- Asset: \`assets/agents/${assetName}.md\`
- Tarea: ${JSON.stringify(task)}
- Modelo: el configurado por defecto en el host
- Duración: ${result.durationMs} ms · exit ${String(result.exitCode)}
- Tool calls que el hijo ejecutó: ${result.toolCalls.map((call) => call.name).join(", ") || "(ninguna)"}

## Allowlist declarada en el asset

\`\`\`json
${JSON.stringify(declared, null, 2)}
\`\`\`

## Tools que Pi reportó en \`agent_end.toolsAdded\`

\`\`\`json
${JSON.stringify(reported, null, 2)}
\`\`\`

## Comparación

- Tools de más (crítico): ${extras.length === 0 ? "ninguna" : extras.join(", ")}
- Tools declaradas y no habilitadas: ${missing.length === 0 ? "ninguna" : missing.join(", ")}
- Subconjunto de la allowlist global del runner: ${reported.every((tool) => (ALLOWED_CHILD_TOOLS as readonly string[]).includes(tool)) ? "sí" : "NO"}

## Veredicto

**${verdict}**

Salida del hijo (recortada):

\`\`\`
${result.output.slice(0, 600) || "(vacía)"}
\`\`\`
`;

await mkdir(join(root, "docs", "evidence"), { recursive: true });
await writeFile(join(root, "docs", "evidence", `subagent-${assetName}-tools.md`), evidence, "utf8");

console.log(verdict);
console.log(`declaradas: ${declared.join(", ")}`);
console.log(`reportadas: ${reported.join(", ") || "(ninguna)"}`);
console.log(`evidencia: docs/evidence/subagent-${assetName}-tools.md`);

if (critical) process.exit(2);
if (!result.ok) process.exit(1);
