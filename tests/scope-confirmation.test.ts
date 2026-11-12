/**
 * S63 and S64 acceptance tests: the two behaviours that the live runs exposed.
 *
 *   S63 — the scope confirmation is mechanical and bound to the file's hash. The model saying
 *         `confirm: true` is not an answer; a human is; the same bytes are not asked twice; edited
 *         bytes are asked again; status.md and the gate read the same truth.
 *   S64 — `limits.forbidden` is a hard denial (no pause, nothing to confirm) and a rule with a port
 *         restricts that port, including for a port-less token in argv.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, type ProgramSession, type SessionDeps } from "../src/pi/session.ts";
import { verifyFinding } from "./helpers/verifier-flow.ts";

const PORT = 33971;

function scopeText(options: { lab?: string; port?: number; forbidden?: string[] } = {}): string {
	const forbidden = options.forbidden ?? [];
	return [
		"program: lab",
		`lab: ${options.lab ?? "true"}`,
		"authorized_on: 2026-11-11",
		"in_scope:",
		`  - 127.0.0.1:${options.port ?? PORT}`,
		"limits:",
		"  rate_rps: 5",
		...(forbidden.length === 0 ? [] : ["  forbidden:", ...forbidden.map((item) => `    - ${item}`)]),
	].join("\n")
		.concat("\n");
}

interface Harness {
	dir: string;
	scopePath: string;
	session: ProgramSession;
	executed: string[][];
	questions: string[];
	cleanup(): Promise<void>;
}

async function harness(input: {
	scope: string;
	answer: (question: string) => boolean;
	verifier?: boolean;
}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-confirm-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, input.scope, "utf8");
	const executed: string[][] = [];
	const questions: string[] = [];
	const deps: SessionDeps = {
		dns: async () => ({ cname: [] }),
		readFile: (path) => readFile(path, "utf8"),
		runTool: async (argv) => {
			executed.push(argv);
			return { exitCode: 0, stdout: "ok", stderr: "" };
		},
		confirm: async (question) => {
			questions.push(question);
			return input.answer(question);
		},
	};
	const session = createSession({ root: dir, program: "lab", verifier: input.verifier }, deps);
	return {
		dir,
		scopePath,
		session,
		executed,
		questions,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test("S63: the model's confirm:true with a human 'no' does not load the scope", async () => {
	const h = await harness({ scope: scopeText(), answer: () => false });
	try {
		const result = await h.session.scope({ file: h.scopePath, confirm: true });
		assert.equal(result.ok, false);
		assert.match(result.text, /no hay confirmación humana/);
		const run = await h.session.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:${PORT}/`], target: `http://127.0.0.1:${PORT}/` });
		assert.equal(run.ok, false);
		assert.match(run.text, /no scope loaded/);
		const status = await readFile(h.session.paths.statusFile, "utf8");
		assert.match(status, /todavía sin confirmar|no está confirmado/i);
	} finally {
		await h.cleanup();
	}
});

test("S63: a human 'yes' confirms, records the hash and lets the gate work", async () => {
	const h = await harness({ scope: scopeText(), answer: () => true });
	try {
		const result = await h.session.scope({ file: h.scopePath });
		assert.equal(result.ok, true, result.text);
		assert.match(result.text, /Alcance confirmado por un humano \(hash [0-9a-f]{12}/);
		const status = await readFile(h.session.paths.statusFile, "utf8");
		assert.match(status, /confirmado el \d{4}-\d{2}-\d{2}, hash [0-9a-f]{12}/);
		const run = await h.session.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:${PORT}/`], target: `http://127.0.0.1:${PORT}/` });
		assert.equal(run.ok, true, run.text);
	} finally {
		await h.cleanup();
	}
});

test("S63: the same bytes are not asked twice, in the same session or a new one", async () => {
	const h = await harness({ scope: scopeText(), answer: () => true });
	try {
		await h.session.scope({ file: h.scopePath });
		assert.equal(h.questions.length, 1);
		const again = await h.session.scope({ file: h.scopePath });
		assert.equal(again.ok, true);
		assert.match(again.text, /ya lo confirmaste/);
		assert.equal(h.questions.length, 1, "the same hash must not ask again");

		// A fresh session on the same workspace: the confirmation is persisted, bound to the hash.
		const second = createSession(
			{ root: h.dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
				confirm: async () => {
					throw new Error("must not ask again");
				},
			},
		);
		const reloaded = await second.scope({ file: h.scopePath });
		assert.equal(reloaded.ok, true, reloaded.text);
		assert.match(reloaded.text, /ya lo confirmaste/);
	} finally {
		await h.cleanup();
	}
});

test("S63: an edited scope asks again and the gate refuses until it is confirmed", async () => {
	const h = await harness({ scope: scopeText(), answer: () => true });
	try {
		await h.session.scope({ file: h.scopePath });
		// Someone edits the scope after confirmation: the policy is stale and the gate must refuse.
		await writeFile(h.scopePath, scopeText({ port: PORT + 1 }), "utf8");
		const stale = await h.session.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:${PORT}/`], target: `http://127.0.0.1:${PORT}/` });
		assert.equal(stale.ok, false);
		assert.match(stale.text, /El scope cambió desde la última confirmación/);
		assert.equal(h.executed.length, 0);

		const reloaded = await h.session.scope({ file: h.scopePath });
		assert.equal(h.questions.length, 2, "edited bytes must be asked again");
		assert.equal(reloaded.ok, true, reloaded.text);
		const status = await readFile(h.session.paths.statusFile, "utf8");
		assert.match(status, /hash [0-9a-f]{12}/);
	} finally {
		await h.cleanup();
	}
});

test("S64: a rule with a port restricts that port", async () => {
	const h = await harness({ scope: scopeText(), answer: () => true });
	try {
		await h.session.scope({ file: h.scopePath });
		const allowed = await h.session.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:${PORT}/`], target: `http://127.0.0.1:${PORT}/` });
		assert.equal(allowed.ok, true, allowed.text);
		const denied = await h.session.run({ tool: "curl", args: ["-sS", `http://127.0.0.1:${PORT + 1}/`], target: `http://127.0.0.1:${PORT + 1}/` });
		assert.equal(denied.ok, false);
		assert.match(denied.text, new RegExp(`no in_scope rule matched 127\\.0\\.0\\.1:${PORT + 1}`));
		assert.equal(h.executed.length, 1, "only the in-scope run executed");
	} finally {
		await h.cleanup();
	}
});

test("S64: a port-less host token does not ride along on a ported rule", async () => {
	const h = await harness({ scope: scopeText(), answer: () => true });
	try {
		await h.session.scope({ file: h.scopePath });
		const result = await h.session.run({
			tool: "curl",
			args: ["-sS", "127.0.0.1", `http://127.0.0.1:${PORT}/`],
			target: `http://127.0.0.1:${PORT}/`,
		});
		assert.equal(result.ok, false);
		assert.match(result.text, /no in_scope rule matched 127\.0\.0\.1$/m);
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("S64: a class the program forbids is denied hard, with no confirmation offered", async () => {
	const h = await harness({ scope: scopeText({ forbidden: ["brute-force"] }), answer: () => true });
	try {
		await h.session.scope({ file: h.scopePath });
		h.questions.length = 0; // forget the scope question
		const result = await h.session.run({
			tool: "hydra",
			args: ["-L", "l.txt", "-P", "p.txt", `127.0.0.1:${PORT}`, "ssh"],
			target: `http://127.0.0.1:${PORT}/login`,
		});
		assert.equal(result.ok, false);
		assert.match(result.text, /prohíbe brute-force/);
		assert.match(result.text, /No hay confirmación que lo habilite/);
		assert.equal(h.questions.length, 0, "a forbidden class must not even ask");
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("S64: a destructive class the program does NOT forbid still pauses", async () => {
	// The human says yes to the scope and no to the destructive action: two different questions.
	const h = await harness({
		scope: scopeText({ forbidden: ["dos"] }),
		answer: (question) => /Confirmás este alcance/i.test(question),
	});
	try {
		await h.session.scope({ file: h.scopePath });
		h.questions.length = 0;
		const result = await h.session.run({
			tool: "hydra",
			args: ["-L", "l.txt", "-P", "p.txt", `127.0.0.1:${PORT}`, "ssh"],
			target: `http://127.0.0.1:${PORT}/login`,
		});
		assert.equal(result.ok, false);
		assert.match(result.text, /Acción destructiva denegada por el humano/);
		assert.equal(h.questions.length, 1, "the pause must ask exactly once");
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("S66: a finding cannot be verified from the main session, only from a verifier", async () => {
	const main = await harness({ scope: scopeText(), answer: () => true });
	try {
		await main.session.scope({ file: main.scopePath });
		const created = await main.session.finding({ action: "create", title: "IDOR", class: "idor", endpoint: `/api/invoices/2` });
		const id = (created.text.match(/F-\d{4}/) ?? [])[0];
		assert.ok(id, created.text);
		const denied = await main.session.finding({ action: "update", id, state: "verified", reason: "lo probé" });
		assert.equal(denied.ok, false);
		assert.match(denied.text, /verificador/);

		const accepted = await verifyFinding({
			root: main.dir,
			program: "lab",
			findingId: id as string,
			endpoint: "/api/invoices/2",
			target: `http://127.0.0.1:${PORT}/api/invoices/2`,
			scopePath: main.scopePath,
		});
		assert.equal(accepted.applied.ok, true, accepted.applied.text);
	} finally {
		await main.cleanup();
	}
});
