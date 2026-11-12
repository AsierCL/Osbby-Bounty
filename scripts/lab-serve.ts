/**
 * Runs the local lab as a foreground process (S57). `scripts/lab-up.sh` starts it in the background
 * and writes the port so the human can paste it into the session.
 *
 * Loopback only: the lab binds 127.0.0.1 and nothing else.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startLab } from "../lab/server.ts";

const dir = join(process.cwd(), ".lab");
mkdirSync(dir, { recursive: true });

// S69: a fixed default port so the operator can keep it in muscle memory (override with
// GENTLE_BOUNTY_LAB_PORT). startLab binds port 0; a fixed port is passed through explicitly.
const requested = Number(process.argv[2] ?? process.env.GENTLE_BOUNTY_LAB_PORT ?? 8787);
if (!Number.isInteger(requested) || requested <= 0 || requested > 65535) {
	console.error(`puerto inválido: ${String(process.argv[2] ?? process.env.GENTLE_BOUNTY_LAB_PORT)}`);
	process.exit(2);
}

const lab = await startLab(requested).catch((error: Error & { code?: string }) => {
	if (error.code === "EADDRINUSE") {
		console.error(`el puerto ${requested} está ocupado: elegí otro con GENTLE_BOUNTY_LAB_PORT=<puerto>`);
		process.exit(3);
	}
	throw error;
});
writeFileSync(join(dir, "port"), `${lab.port}\n`, "utf8");
console.log(`lab escuchando en http://127.0.0.1:${lab.port}`);
console.log(`puerto escrito en .lab/port`);

const shutdown = async () => {
	await lab.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
