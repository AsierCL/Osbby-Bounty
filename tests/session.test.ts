/**
 * Program session (S28/S29/S31): the tool-facing behaviour, tested without Pi, without network and
 * without spawning anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, type ProgramSession, type SessionDeps } from "../src/pi/session.ts";

const SCOPE_NO_FORBIDDEN = `program: lab
lab: true
authorized_on: 2026-11-11
in_scope:
  - 127.0.0.1:3000
limits:
  rate_rps: 50
  allowed_methods:
    - GET
  redirects: reject
`;

const SCOPE = `program: lab
lab: true
authorized_on: 2026-11-11
in_scope:
  - 127.0.0.1:3000
out_of_scope:
  - 127.0.0.1:3999
limits:
  rate_rps: 50
  forbidden:
    - dos
  allowed_methods:
    - GET
  redirects: reject
`;

interface Harness {
	dir: string;
	session: ProgramSession;
	executed: string[][];
	confirmations: string[];
	cleanup(): Promise<void>;
}

async function harness(options: { scope?: string; redaction?: "off" | "on"; confirm?: boolean; exitCode?: number; stdout?: string } = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-session-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	await writeFile(join(dir, "scope.yaml"), options.scope ?? SCOPE, "utf8");

	const executed: string[][] = [];
	const confirmations: string[] = [];
	const deps: SessionDeps = {
		dns: async () => ({ cname: [] }),
		readFile: async (path: string) => readFile(path, "utf8"),
		runTool: async (argv: string[]) => {
			executed.push(argv);
			return { exitCode: options.exitCode ?? 0, stdout: options.stdout ?? "ok", stderr: "" };
		},
		confirm: async (question: string) => {
			confirmations.push(question);
			return options.confirm ?? false;
		},
	};

	const session = createSession({ root: dir, program: "lab", redaction: options.redaction ?? "off" }, deps);
	return {
		dir,
		session,
		executed,
		confirmations,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function statusText(h: Harness): Promise<string> {
	return readFile(join(h.dir, "work", "lab", "status.md"), "utf8");
}

test("loading a scope pauses once with a readable summary and writes status.md", async () => {
	const h = await harness();
	try {
		const result = await h.session.scope({ file: join(h.dir, "scope.yaml") });
		// S63: without a human answer the scope is not loaded, even though the summary is shown.
		assert.equal(result.ok, false);
		assert.match(result.text, /En alcance: 1 regla/);
		assert.match(result.text, /127\.0\.0\.1:3000/);
		assert.match(result.text, /No cargo el alcance: no hay confirmación humana/);
		const text = await statusText(h);
		assert.match(text, /Confirmación del alcance/);
	} finally {
		await h.cleanup();
	}
});

test("confirming the scope clears the pending item", async () => {
	const h = await harness();
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml") });
		const confirmed = await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		assert.match(confirmed.text, /Alcance confirmado/);
		const text = await statusText(h);
		assert.match(text, /Nada pendiente: sigo solo/);
	} finally {
		await h.cleanup();
	}
});

test("a scope that does not parse is refused and leaves the session unusable", async () => {
	const h = await harness({ scope: "program: lab\nlab: true\nin_scope:\n  - \"*\"\n" });
	try {
		const result = await h.session.scope({ file: join(h.dir, "scope.yaml") });
		assert.equal(result.ok, false);
		assert.match(result.text, /no parsea/);
		const run = await h.session.run({ tool: "nuclei", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.equal(run.ok, false);
		assert.match(run.text, /no scope loaded/i);
	} finally {
		await h.cleanup();
	}
});

test("an out-of-scope run is blocked and the reason is legible in status.md", async () => {
	const h = await harness();
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const result = await h.session.run({ tool: "nuclei", args: ["-u", "http://127.0.0.1:9999/"], target: "http://127.0.0.1:9999/" });
		assert.equal(result.ok, false);
		assert.match(result.text, /Bloqueado por el gate/);
		assert.equal(h.executed.length, 0);
		const text = await statusText(h);
		assert.match(text, /bloqueado: no in_scope rule matched 127\.0\.0\.1:9999/);
	} finally {
		await h.cleanup();
	}
});

test("a destructive action always asks, and does nothing when the answer is no", async () => {
	const h = await harness({ confirm: false, scope: SCOPE_NO_FORBIDDEN });
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const result = await h.session.run({
			tool: "nuclei",
			args: ["-u", "http://127.0.0.1:3000/", "-tags", "dos"],
			target: "http://127.0.0.1:3000/",
			technique: "dos",
		});
		assert.equal(result.ok, false);
		assert.match(result.text, /acción de clase destructiva/);
		assert.equal(h.confirmations.length, 1);
		assert.equal(h.executed.length, 0);
		const text = await statusText(h);
		assert.match(text, /destructiva necesita tu OK explícito/);
	} finally {
		await h.cleanup();
	}
});

test("the same destructive action runs when the human says yes", async () => {
	const h = await harness({ confirm: true, scope: SCOPE_NO_FORBIDDEN });
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const result = await h.session.run({
			tool: "nuclei",
			args: ["-u", "http://127.0.0.1:3000/"],
			target: "http://127.0.0.1:3000/",
			technique: "dos",
		});
		assert.equal(result.ok, true, result.text);
		assert.equal(h.executed.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("the daily cap stops the run instead of queueing it", async () => {
	const scoped = SCOPE.replace("  rate_rps: 50\n", "  rate_rps: 50\n  max_requests_per_day: 1\n");
	const h = await harness({ scope: scoped });
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const first = await h.session.run({ tool: "nuclei", args: ["-u", "http://127.0.0.1:3000/a"], target: "http://127.0.0.1:3000/a" });
		assert.equal(first.ok, true, first.text);
		const second = await h.session.run({ tool: "nuclei", args: ["-u", "http://127.0.0.1:3000/b"], target: "http://127.0.0.1:3000/b" });
		assert.equal(second.ok, false);
		assert.match(second.text, /límite del programa/);
		assert.equal(h.executed.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("evidence records the execution before and after the tool runs", async () => {
	const h = await harness();
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		await h.session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		const listed = await h.session.evidence({ action: "list" });
		assert.match(listed.text, /execution/);
		assert.match(listed.text, /execution-result/);
		const verified = await h.session.evidence({ action: "verify" });
		assert.equal(verified.ok, true, verified.text);
	} finally {
		await h.cleanup();
	}
});

test("a failing tool is reported as failed, not as success", async () => {
	const h = await harness({ exitCode: 2 });
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const result = await h.session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.equal(result.ok, false);
		assert.match(result.text, /terminó con código 2/);
	} finally {
		await h.cleanup();
	}
});

test("redaction is off by default: test credentials reach the model", async () => {
	const h = await harness({ stdout: "Cookie: session=topsecret123" });
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const result = await h.session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.match(result.text, /topsecret123/);
	} finally {
		await h.cleanup();
	}
});

test("redaction can be turned on explicitly", async () => {
	const h = await harness({ stdout: "Cookie: session=topsecret123", redaction: "on" });
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const result = await h.session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.ok(!result.text.includes("topsecret123"), result.text);
	} finally {
		await h.cleanup();
	}
});

test("findings flow through the lifecycle and rewrite status.md", async () => {
	const h = await harness();
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const created = await h.session.finding({ action: "create", title: "IDOR en facturas", class: "idor", endpoint: "/api/v1/invoices/1234" });
		assert.match(created.text, /F-0001/);
		const duplicate = await h.session.finding({ action: "create", title: "otra vez", class: "idor", endpoint: "/api/v1/invoices/1234" });
		assert.match(duplicate.text, /Ya lo tenía: F-0001/);
		// The verifier runs in its own session (S66); here it shares the workspace.
		const verifier = createSession(
			{ root: h.dir, program: "lab", verifier: true },
			{
				dns: async () => ({ cname: [] }),
				readFile: async (path: string) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
				confirm: async () => true,
			},
		);
		const verified = await verifier.finding({ action: "update", id: "F-0001", state: "verified", reason: "reproducido dos veces" });
		assert.equal(verified.ok, true, verified.text);
		const text = await statusText(h);
		assert.match(text, /F-0001\*\* IDOR en facturas — confirmado/);
	} finally {
		await h.cleanup();
	}
});

test("a sensitive third-party secret is flagged in status.md, not blocked", async () => {
	const h = await harness();
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		await h.session.finding({ action: "create", title: "Stripe key en bundle", class: "secret-exposure", endpoint: "/static/app.js", sensitive: true });
		const text = await statusText(h);
		assert.match(text, /hallazgo sensible — revisar antes de reportar/);
	} finally {
		await h.cleanup();
	}
});

test("a phase transition rewrites status.md and bounty_status returns the same text", async () => {
	const h = await harness();
	try {
		await h.session.scope({ file: join(h.dir, "scope.yaml"), confirm: async () => true });
		const phase = await h.session.phase({ phase: "hypothesis", nextStep: "validar la hipótesis del login" });
		assert.match(phase.text, /Fase actual:\*\* hypothesis/);
		const status = await h.session.status();
		assert.match(status.text, /validar la hipótesis del login/);
		assert.equal(status.text, phase.text);
	} finally {
		await h.cleanup();
	}
});

test("a spent tool budget stops the run and says so in status.md", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-budget-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		await writeFile(join(dir, "scope.yaml"), SCOPE, "utf8");
		const executed: string[][] = [];
		const session = createSession(
			{ root: dir, program: "lab", budget: { maxToolCalls: 1 } },
			{
				dns: async () => ({ cname: [] }),
				readFile: async (path: string) => readFile(path, "utf8"),
				runTool: async (argv: string[]) => {
					executed.push(argv);
					return { exitCode: 0, stdout: "ok", stderr: "" };
				},
				confirm: async () => true,
			} as never,
		);
		await session.scope({ file: join(dir, "scope.yaml"), confirm: async () => true });
		const first = await session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/a"], target: "http://127.0.0.1:3000/a" });
		assert.equal(first.ok, true, first.text);
		const second = await session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/b"], target: "http://127.0.0.1:3000/b" });
		assert.equal(second.ok, false);
		assert.match(second.text, /Presupuesto agotado: se alcanzó el límite de 1 llamadas/);
		assert.equal(executed.length, 1);
		const text = await readFile(join(dir, "work", "lab", "status.md"), "utf8");
		assert.match(text, /presupuesto agotado/i);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("emergency stop kills children, keeps evidence consistent and refuses further runs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-stop-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		await writeFile(join(dir, "scope.yaml"), SCOPE, "utf8");
		const killed: number[] = [];
		const session = createSession({ root: dir, program: "lab" }, {
			dns: async () => ({ cname: [] }),
			readFile: async (path: string) => readFile(path, "utf8"),
			runTool: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
			confirm: async () => true,
		} as never);
		await session.scope({ file: join(dir, "scope.yaml"), confirm: async () => true });
		await session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		session.stopController.register({ pid: 4321, kill: () => (killed.push(4321), true) });
		const stopped = await session.stop("prueba de parada");
		assert.equal(stopped.ok, true);
		assert.match(stopped.text, /Parada de emergencia ejecutada/);
		assert.match(stopped.text, /consistente/);
		assert.deepEqual(killed, [4321]);
		const after = await session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/"], target: "http://127.0.0.1:3000/" });
		assert.equal(after.ok, false);
		assert.match(after.text, /Parada de emergencia activa/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
