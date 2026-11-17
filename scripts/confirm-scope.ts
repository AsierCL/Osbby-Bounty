/**
 * S105: `--confirm-scope <programa>` — the human's keystroke, from a plain terminal.
 *
 * The confirmation is the same one the in-session dialog asks for: it prints the interpreted scope and the
 * hash, and only accepts the exact word the operator types in their own TTY. An agent has no path to it.
 *
 * Usage: node --experimental-strip-types scripts/confirm-scope.ts <root> <programa>
 */
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseScope, summarizeScope } from "../src/core/scope.ts";
import { createStatusStore } from "../src/core/status.ts";
import { sha256 } from "../src/core/evidence.ts";

const [root, program] = process.argv.slice(2);
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (!isMain) process.exit(0);
if (root === undefined || program === undefined) {
	console.error("usage: confirm-scope.ts <root> <programa>");
	process.exit(2);
}
const path = join(root, "work", program, "scope.yaml");
let text: string;
try {
	text = await readFile(path, "utf8");
} catch {
	console.error(`no existe ${path}`);
	process.exit(1);
}
const parsed = parseScope(text);
if (!parsed.ok) {
	console.error(`el scope no parsea:\n- ${parsed.errors.join("\n- ")}`);
	process.exit(1);
}
const hash = sha256(text);
console.log(summarizeScope(parsed.policy, parsed.warnings));
console.log(`\nArchivo: ${path}\nhash: ${hash}`);
const status = createStatusStore({ workDir: join(root, "work", program), program });
const previous = await status.read();
if (previous.scopeConfirmedHash === hash) {
	console.log("\nEste scope ya estaba confirmado con este mismo hash: no hace falta otra tecla.");
	process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nEscribí exactamente "confirmo" para confirmar este alcance: ')).trim();
rl.close();
if (answer !== "confirmo") {
	console.log("No confirmado: no se cargó nada.");
	process.exit(1);
}
await status.setScopeHash(hash);
await status.confirmScope(hash);
console.log(`Alcance de ${program} confirmado (hash ${hash.slice(0, 12)}…).`);
