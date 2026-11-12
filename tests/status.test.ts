/**
 * status.md (S29): the human-facing product requirement. It must stand alone, in plain language, and
 * it must be rewritten on every phase transition and finding change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFindingsStore } from "../src/core/findings.ts";
import { createStatusStore, renderStatus, writeStatusFile, type ProgramState } from "../src/core/status.ts";

const NOW = 1_700_000_000_000;

function state(overrides: Partial<ProgramState> = {}): ProgramState {
	return {
		program: "lab",
		phase: "recon",
		scopeConfirmedAt: null,
		pending: null,
		nextStep: "",
		notes: [],
		updatedAt: new Date(NOW).toISOString(),
		...overrides,
	};
}

async function withWorkDir<T>(run: (workDir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-status-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("the status says what is happening in plain language", () => {
	const text = renderStatus({ state: state(), findings: [], scopePath: "work/lab/scope.yaml" });
	assert.match(text, /# lab — estado/);
	assert.match(text, /\*\*Fase actual:\*\* recon/);
	assert.match(text, /Estoy viendo qué hay publicado en el alcance/);
	assert.match(text, /Todavía no hay nada anotado/);
	assert.match(text, /Nada pendiente: sigo solo/);
});

test("findings are listed with their state in plain words", async () =>
	withWorkDir(async (workDir) => {
		const findings = createFindingsStore({ dir: join(workDir, "findings"), program: "lab", now: () => NOW });
		const { finding } = await findings.create({ title: "IDOR en facturas", class: "idor", endpoint: "/api/v1/invoices/1234" });
		await findings.update(finding.id, { state: "verified", score: 8.1 }, "reproduced");
		const text = renderStatus({ state: state(), findings: await findings.list(), scopePath: null });
		assert.match(text, /## Hallazgos \(1\)/);
		assert.match(text, /F-0001\*\* IDOR en facturas — confirmado — severidad 8\.1/);
		assert.match(text, /dónde: \/api\/v1\/invoices\/1234/);
	}));

test("a third-party secret is flagged with the exact phrase the operator asked for", async () =>
	withWorkDir(async (workDir) => {
		const findings = createFindingsStore({ dir: join(workDir, "findings"), program: "lab", now: () => NOW });
		await findings.create({ title: "Stripe key in bundle", class: "secret-exposure", endpoint: "/static/app.js", sensitive: true });
		const text = renderStatus({ state: state(), findings: await findings.list(), scopePath: null });
		assert.match(text, /hallazgo sensible — revisar antes de reportar/);
	}));

test("a pending confirmation is shown with its reason", () => {
	const text = renderStatus({
		state: state({ pending: { kind: "destructive", detail: "nuclei -tags dos contra /api/search", since: new Date(NOW).toISOString() } }),
		findings: [],
		scopePath: null,
	});
	assert.match(text, /esperando tu confirmación/i);
	assert.match(text, /destructiva necesita tu OK explícito/);
	assert.match(text, /-tags dos/);
});

test("phase transitions rewrite the state and the rendered file", async () =>
	withWorkDir(async (workDir) => {
		const status = createStatusStore({ workDir, program: "lab", now: () => NOW });
		assert.equal((await status.read()).phase, "scope");
		await status.setPhase("hypothesis", "validar la hipótesis 1");
		const reloaded = await status.read();
		assert.equal(reloaded.phase, "hypothesis");
		assert.equal(reloaded.nextStep, "validar la hipótesis 1");
		const text = await writeStatusFile({ workDir, state: reloaded, findings: [], scopePath: null });
		const onDisk = await readFile(status.file(), "utf8");
		assert.equal(onDisk, text);
		assert.match(onDisk, /Fase actual:\*\* hypothesis/);
	}));

test("confirming the scope clears the scope pending item and records the date", async () =>
	withWorkDir(async (workDir) => {
		const status = createStatusStore({ workDir, program: "lab", now: () => NOW });
		await status.setPending({ kind: "scope", detail: "3 reglas ambiguas", since: "" });
		await status.confirmScope();
		const reloaded = await status.read();
		assert.equal(reloaded.pending, null);
		assert.equal(reloaded.scopeConfirmedAt, new Date(NOW).toISOString());
	}));

test("notes are appended and the last ones are shown", async () =>
	withWorkDir(async (workDir) => {
		const status = createStatusStore({ workDir, program: "lab", now: () => NOW });
		await status.note("primer barrido: 12 hosts");
		await status.note("2 endpoints con login");
		const reloaded = await status.read();
		const text = renderStatus({ state: reloaded, findings: [], scopePath: null });
		assert.match(text, /primer barrido: 12 hosts/);
		assert.match(text, /2 endpoints con login/);
	}));
