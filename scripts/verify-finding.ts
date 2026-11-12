/**
 * S66: the verifier flow. Launches `bounty-verify` in its own Pi process with a task built from the
 * finding id and the captured artifacts only (S36), and with the verifier flag set so that session is
 * the only one allowed to move the finding to verified/rejected.
 *
 * Usage: node --experimental-strip-types scripts/verify-finding.ts <program> <findingId>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { createPiRunner } from "../src/pi/runner.ts";
import { verifierTaskFor } from "../src/pi/verifier.ts";

const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
const [program, findingId] = process.argv.slice(2);

if (!program || !findingId) {
	console.error("usage: verify-finding <programa> <findingId>");
	process.exit(2);
}

const finding = JSON.parse(await readFile(join(root, "work", program, "findings", `${findingId}.json`), "utf8")) as { id: string };
const records = await createEvidenceStore(join(root, "work", program, "evidence"), { now: () => Date.now() }).read();

// Only the id survives from the finding: no title, no notes, no reasoning (S36).
const task = verifierTaskFor({ id: finding.id }, records);

const asset = await readFile(join(root, "assets", "agents", "bounty-verify.md"), "utf8");
const tools = (/^tools:\s*(.+)$/m.exec(asset)?.[1] ?? "")
	.split(",")
	.map((tool) => tool.trim())
	.filter(Boolean);

const runner = createPiRunner({
	piCommand: process.env.GENTLE_BOUNTY_PI ? [process.env.GENTLE_BOUNTY_PI] : ["pi"],
	extensionEntry: join(root, "extensions", "bounty.ts"),
	defaultTimeoutMs: 15 * 60 * 1000,
});

const result = await runner.run({
	agent: { name: "bounty-verify", tools },
	task,
	cwd: root,
	env: { GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_VERIFIER: "1" },
});

console.log(`verificador: exit=${String(result.exitCode)} ok=${result.ok} duración=${result.durationMs}ms`);
console.log(`tools reportadas: ${result.activeTools.join(", ") || "(ninguna)"}`);
console.log(result.output.slice(0, 2000));
process.exit(result.ok ? 0 : 1);
