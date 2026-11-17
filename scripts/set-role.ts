/**
 * S106: the operator (not the agent) writes a role's headers.
 *
 * Reads the file, or stdin, and writes `work/<program>/sessions/<role>.headers` with mode 0600. It
 * prints the header NAMES and any warning, never a value, so the terminal history stays clean.
 *
 *   node --experimental-strip-types scripts/set-role.ts acme user-a ./user-a.headers
 *   pbpaste | node --experimental-strip-types scripts/set-role.ts acme user-b
 */
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";

import { createRoleStore } from "../src/core/roles.ts";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const [program, role, file] = process.argv.slice(2);
	if (!program || !role) {
		console.error("uso: set-role.ts <programa> <rol> [archivo]   (sin archivo, lee stdin)");
		process.exit(2);
	}
	const text = file === undefined ? await readStdin() : await readFile(file, "utf8");
	if (text.trim().length === 0) {
		console.error("no escribí nada: el archivo (o stdin) está vacío");
		process.exit(1);
	}
	const store = createRoleStore({ workspace: `${process.cwd()}/work/${program}` });
	const info = await store.write(role, text);
	console.log(`rol ${info.role}: ${info.headerNames.join(", ") || "sin headers"}`);
	console.log(`archivo: ${store.file(info.role)} (0600)`);
	if (info.warnings.length > 0) console.log(`avisos: ${info.warnings.join("; ")}`);
}

await main();
