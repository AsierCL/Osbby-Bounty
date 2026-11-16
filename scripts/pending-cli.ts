/**
 * S90: resolve the queue of destructive actions in the morning.
 *
 * The human's keystroke here is the same requirement as the in-session dialog: this reads the TTY of
 * the person running the command. An agent has no path to it, and nothing in the queue file is read as
 * authorization. After "sí", the command goes through the normal session path again (scope + gate +
 * rate), never raw.
 *
 * Usage: node --experimental-strip-types scripts/pending-cli.ts <root> <program> [--dry]
 */
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { createPendingQueue } from "../src/core/pending.ts";
import { createSession } from "../src/pi/session.ts";

const [root, program, flag] = process.argv.slice(2);
if (root === undefined || program === undefined) {
	console.error("usage: pending-cli.ts <root> <program> [--dry]");
	process.exit(2);
}
const dry = flag === "--dry";
const dir = join(root, "work", program);
const queue = createPendingQueue({ dir });
const items = await queue.pending();

if (items.length === 0) {
	console.log(`No hay acciones destructivas pendientes en ${program}.`);
	process.exit(0);
}

const exec = (argv: string[]) =>
	new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
		const [command, ...args] = argv;
		execFile(command as string, args, (error, stdout, stderr) => {
			resolve({ exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const summary = (item: (typeof items)[number]) => {
	const lines = [
		`${item.id} · ${item.at} · ${item.tool} ${item.argv.join(" ")}`,
		`   target: ${item.target}`,
		`   motivo: ${item.reason}`,
		...(item.why.length > 0 ? [`   por qué lo propuso: ${item.why}`] : []),
	];
	if (item.annotation !== undefined) {
		lines.push(`   riesgo: ${item.annotation.risk} · terceros: ${item.annotation.touchesThirdPartyData} · económico: ${item.annotation.financialEffect} · irreversible: ${item.annotation.irreversible ? "sí" : "no"}`);
		lines.push(`   qué podría pasar: ${item.annotation.whatCouldHappen}`);
		lines.push(`   recomendación: ${item.annotation.recommendation} — ${item.annotation.note}`);
	}
	lines.push("   Esto es una opinión, no una aprobación. La decisión es tuya.");
	return lines.join("\n");
};

const session = createSession(
	{ root, program },
	{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: exec, confirm: async () => false },
);
const scopePath = join(dir, "scope.yaml");
const scoped = await session.scope({ file: scopePath });
if (!scoped.ok) {
	console.log(`No puedo cargar el alcance: ${scoped.text.slice(0, 200)}`);
	process.exit(1);
}

for (const item of items) {
	console.log("");
	console.log(summary(item));
	const answer = dry ? "n" : (await rl.question("[e]jecutar · [d]escartar por criterio · [s]altar — tu tecla: ")).trim().toLowerCase();
	if (answer === "d" && !dry) {
		const reason = (await rl.question("Motivo (tus palabras, queda citado tal cual): ")).trim();
		if (reason.length === 0) {
			console.log("   → sin motivo no se descarta.");
			continue;
		}
		// The human's words, quoted as typed. This resolves the QUEUE decision, not a finding:
		// dismissing a finding goes through bounty_finding resolve inside a session.
		await queue.resolve(item.id, { at: new Date().toISOString(), outcome: "discarded", detail: `motivo (texto literal del humano): ${reason}` });
		console.log("   → descartado por criterio, con tu motivo guardado tal cual.");
		continue;
	}
	if (answer !== "e" && answer !== "sí" && answer !== "si") {
		if (!dry) await queue.resolve(item.id, { at: new Date().toISOString(), outcome: "declined", detail: "sin confirmación en la terminal" });
		console.log("   → no se ejecuta.");
		continue;
	}
	// The human's keystroke above is the confirmation; the run still goes through the gate.
	const result = await session.run({ tool: item.tool, args: item.argv.slice(1), target: item.target, why: item.why, confirm: async () => true });
	await queue.resolve(item.id, { at: new Date().toISOString(), outcome: result.ok ? "executed" : "declined", detail: result.text.slice(0, 300) });
	console.log(`   → ${result.ok ? "ejecutada" : "no ejecutada"}: ${result.text.split("\n")[0]}`);
}
rl.close();
