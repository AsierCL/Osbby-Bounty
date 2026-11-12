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

const lab = await startLab();
writeFileSync(join(dir, "port"), `${lab.port}\n`, "utf8");
console.log(`lab escuchando en http://127.0.0.1:${lab.port}`);
console.log(`puerto escrito en .lab/port`);

const shutdown = async () => {
	await lab.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
