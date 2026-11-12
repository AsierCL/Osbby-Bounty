/**
 * Part B, session level: system chain records (7a), the model's evidence whitelist (7b) and the three
 * confirmation outcomes in what the model sees (B3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { createSession, type SessionDeps } from "../src/pi/session.ts";

const SCOPE = "program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n";

async function harness(options: { confirm?: SessionDeps["confirm"]; scope?: string } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-partb-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, options.scope ?? SCOPE, "utf8");
	const executed: string[][] = [];
	const deps: SessionDeps = {
		dns: async () => ({ cname: [] }),
		readFile: (path) => readFile(path, "utf8"),
		runTool: async (argv) => {
			executed.push(argv);
			return { exitCode: 0, stdout: "ok", stderr: "" };
		},
		...(options.confirm === undefined ? {} : { confirm: options.confirm }),
	};
	const session = createSession({ root: dir, program: "lab" }, deps);
	await session.scope({ file: scopePath, confirm: async () => true });
	const store = createEvidenceStore(join(dir, "work", "lab", "evidence"), { now: () => Date.now() });
	return { dir, session, store, executed, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const HYDRA = { tool: "hydra", args: ["-L", "l", "-P", "p", "127.0.0.1:3000", "ssh"], target: "http://127.0.0.1:3000/login" };

test("7a: a gate block writes a system record with the reason", async () => {
	const h = await harness();
	try {
		await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3999/"], target: "http://127.0.0.1:3999/" });
		const records = await h.store.read();
		const gate = records.filter((record) => record.kind === "gate");
		assert.equal(gate.length, 1);
		const payload = gate[0]?.payload as { event: string; reason: string };
		assert.equal(payload.event, "gate-blocked");
		assert.match(payload.reason, /no in_scope rule matched 127\.0\.0\.1:3999/);
	} finally {
		await h.cleanup();
	}
});

test("7a: a class forbidden by the program writes a gate record", async () => {
	const forbiddenScope = SCOPE.replace("limits:\n  rate_rps: 5\n", "limits:\n  rate_rps: 5\n  forbidden:\n    - brute-force\n");
	const h = await harness({ scope: forbiddenScope });
	try {
		await h.session.run(HYDRA);
		const gate = (await h.store.read()).filter((record) => record.kind === "gate");
		assert.equal(gate.length, 1);
		assert.equal((gate[0]?.payload as { event: string }).event, "forbidden-class");
	} finally {
		await h.cleanup();
	}
});

test("7a + B3: granted, denied and unavailable are recorded and reported distinctly", async () => {
	// granted
	const granted = await harness({ confirm: async () => true });
	try {
		const result = await granted.session.run(HYDRA);
		assert.equal(result.ok, true, result.text);
		assert.match(result.text, /Acción destructiva confirmada por el humano a las \d{2}:\d{2}/);
		const events = (await granted.store.read()).filter((record) => record.kind === "confirmation").map((record) => (record.payload as { event: string }).event);
		assert.deepEqual(events, ["requested", "granted"]);
	} finally {
		await granted.cleanup();
	}

	// denied
	const denied = await harness({ confirm: async () => false });
	try {
		const result = await denied.session.run(HYDRA);
		assert.match(result.text, /Acción destructiva denegada por el humano a las \d{2}:\d{2}/);
		const events = (await denied.store.read()).filter((record) => record.kind === "confirmation").map((record) => (record.payload as { event: string }).event);
		assert.deepEqual(events, ["requested", "denied"]);
	} finally {
		await denied.cleanup();
	}

	// unavailable: no confirm callback at all
	const unavailable = await harness({});
	try {
		const result = await unavailable.session.run(HYDRA);
		assert.match(result.text, /sin UI: no confirmada a las \d{2}:\d{2}/);
		const events = (await unavailable.store.read()).filter((record) => record.kind === "confirmation").map((record) => (record.payload as { event: string }).event);
		assert.deepEqual(events, ["requested", "unavailable"]);
	} finally {
		await unavailable.cleanup();
	}
});

test("7b: the model cannot append system kinds", async () => {
	const h = await harness();
	try {
		for (const kind of ["execution", "gate", "confirmation", "verification"]) {
			const result = await h.session.evidence({ action: "append", kind, payload: { note: "intento" } });
			assert.equal(result.ok, false, kind);
			assert.match(result.text, /reservado al sistema/);
		}
		const allowed = await h.session.evidence({ action: "append", kind: "observation", payload: { note: "vi un 200" } });
		assert.equal(allowed.ok, true, allowed.text);
	} finally {
		await h.cleanup();
	}
});

test("7b: an erratum must reference a real seq and shows next to it", async () => {
	const h = await harness();
	try {
		const bad = await h.session.evidence({ action: "append", kind: "erratum", payload: { refSeq: 99, note: "no existe" } });
		assert.equal(bad.ok, false);
		assert.match(bad.text, /No existe el seq 99/);
		const noRef = await h.session.evidence({ action: "append", kind: "erratum", payload: { note: "sin ref" } });
		assert.equal(noRef.ok, false);

		const base = await h.session.evidence({ action: "append", kind: "observation", payload: { note: "primera lectura" } });
		const seq = Number((base.text.match(/seq (\d+)/) ?? [])[1]);
		await h.session.evidence({ action: "append", kind: "erratum", payload: { refSeq: seq, note: "corrijo: era un 403, no un 200" } });
		const listed = await h.session.evidence({ action: "list" });
		assert.match(listed.text, /↳ erratum: corrijo/);
	} finally {
		await h.cleanup();
	}
});
