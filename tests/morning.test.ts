/**
 * S100: --morning reads work/ and prints one screen. Read-only: it must not create, modify or delete
 * anything, and it must classify programs as active, waiting for a human, stuck or out of budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { morningReport } from "../scripts/lib/morning.ts";

async function program(dir: string, name: string, state: Record<string, unknown>, findings: string[], status = "", queue: number[] = []) {
	const root = join(dir, "work", name);
	await mkdir(join(root, "findings"), { recursive: true });
	await writeFile(join(root, "state.json"), JSON.stringify(state), "utf8");
	for (const [index, findingState] of findings.entries()) {
		await writeFile(join(root, "findings", `F-${String(index + 1).padStart(4, "0")}.json`), JSON.stringify({ state: findingState }), "utf8");
	}
	if (status.length > 0) await writeFile(join(root, "status.md"), status, "utf8");
	if (queue.length > 0) {
		await writeFile(join(root, "pending-destructive.jsonl"), queue.map((n) => JSON.stringify({ id: `P-000${n}` })).join("\n") + "\n", "utf8");
	}
	return root;
}

test("the morning report classifies four programs without touching disk", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-morning-"));
	try {
		await program(dir, "activo", { phase: "recon", nextStep: "mapear /api" }, ["candidate", "verified"]);
		await program(dir, "parado", { phase: "validate", nextStep: "esperando tecla", pending: { kind: "scope" } }, ["candidate"], "## Esperando tu confirmación\n\n- El alcance no está confirmado: no voy a ejecutar nada.\n");
		await program(dir, "atascado", { phase: "hypothesis", stuck: { key: "http:404", count: 5 } }, []);
		await program(dir, "sinplata", { phase: "recon", notes: ["presupuesto agotado: se alcanzó el límite de 500 llamadas"] }, ["disputed"], "", [1, 2]);

		const before = await readdir(join(dir, "work"));
		const marks = await Promise.all(before.map(async (name) => stat(join(dir, "work", name, "state.json")).then((info) => info.mtimeMs)));
		const report = await morningReport(dir);
		const marksAfter = await Promise.all(before.map(async (name) => stat(join(dir, "work", name, "state.json")).then((info) => info.mtimeMs)));
		assert.deepEqual(marksAfter, marks, "reading must not modify anything");
		assert.deepEqual(await readdir(join(dir, "work")), before);

		const byName = Object.fromEntries(report.programs.map((view) => [view.program, view]));
		assert.equal(byName.activo?.status, "activa");
		assert.deepEqual(byName.activo?.findings, { candidate: 1, verified: 1 });
		assert.equal(byName.parado?.status, "espera humana");
		assert.match(byName.parado?.waiting ?? "", /El alcance no está confirmado/);
		assert.equal(byName.atascado?.status, "atascada");
		assert.match(byName.atascado?.stuck ?? "", /5× http:404/);
		assert.equal(byName.sinplata?.status, "presupuesto agotado");
		assert.equal(byName.sinplata?.pendingDestructive, 2);

		// The screen is a table with one line per program and a summary line.
		assert.match(report.text, /PROGRAMA\s+FASE\s+HALLAZGOS\s+ESTADO\s+NECESITA DE VOS/);
		assert.match(report.text, /activo\s+recon\s+can 1 · ver 1\s+activa/);
		assert.match(report.text, /4 programa\(s\) · 3 con algo para vos · 2 acción\(es\) destructiva\(s\) en cola/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an empty work/ says so instead of crashing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-morning-empty-"));
	try {
		const report = await morningReport(dir);
		assert.match(report.text, /no hay programas en work\//);
		assert.equal(report.programs.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
