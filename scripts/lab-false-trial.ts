/**
 * S78/task 3: the first real-program rehearsal (`lab: false`), before we ever point at a real host.
 *
 * It exercises, in a real session, the three things that must not depend on `lab: true`:
 *   1. the preflight with lab: false,
 *   2. the confirmation-stub guardrail (the stub must be refused outside a lab),
 *   3. a session without a UI: the scope does not load and bounty_run does not run.
 * Then it repeats (3) with a real `pi` child and the real model, because the child is where an
 * accidental lab-only path would hide.
 *
 * Nothing here touches the network: the target is the local lab, declared lab: false on purpose.
 *
 * Usage: node --experimental-strip-types scripts/lab-false-trial.ts
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";
import { createPiRunner } from "../src/pi/runner.ts";

const repo = process.cwd();
const port = Number((await readFile(join(repo, ".lab", "port"), "utf8")).trim());
const root = await mkdtemp(join(tmpdir(), "bounty-labfalse-"));
const program = "trial";
await mkdir(join(root, "work", program), { recursive: true });
const scopePath = join(root, "work", program, "scope.yaml");
await writeFile(
	scopePath,
	[
		`program: ${program}`,
		"lab: false",
		"platform: local-rehearsal",
		"authorized_on: 2026-01-01",
		"in_scope:",
		`  - 127.0.0.1:${port}`,
		"out_of_scope:",
		"  - 127.0.0.1:1",
		"limits:",
		"  rate_rps: 2",
		"  allowed_methods:",
		"    - GET",
		"  redirects: reject",
		"",
	].join("\n"),
	"utf8",
);
console.log(`scope de ensayo: ${scopePath} (lab: false)`);

// 1. Preflight, offline, with lab: false.
const preflight = (() => {
	try {
		return { status: 0, out: execFileSync(process.execPath, [join(repo, "bin", "gentle-bounty.mjs"), "--preflight", program], { encoding: "utf8", env: { ...process.env, GENTLE_BOUNTY_ROOT: root } }) };
	} catch (error) {
		const failed = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failed.status ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
	}
})();
console.log(`\n== 1. preflight (exit ${preflight.status}) ==\n`);
console.log(preflight.out.trim().split("\n").slice(0, 22).join("\n"));

// 2. Extension-level: the stub must be refused outside a lab, and a UI-less session must not load.
process.env.GENTLE_BOUNTY_ROOT = root;
process.env.GENTLE_BOUNTY_PROGRAM = program;
process.env.GENTLE_BOUNTY_ALLOW_CONFIRM_STUB = "1";
process.env.GENTLE_BOUNTY_CONFIRM_TEST = "yes";
const mod = (await import("../extensions/bounty.ts")) as { default: (pi: unknown) => void };
const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, ctx?: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
mod.default({ registerTool: (spec: { name: string } & Record<string, unknown>) => tools.set(spec.name, spec as never) });

const scoped = await tools.get("bounty_scope")?.execute("1", { file: scopePath });
console.log(`\n== 2. bounty_scope con stub pedido y lab:false ==`);
console.log(`ok=${String(scoped?.details.ok)} · ${scoped?.content[0]?.text.split("\n").slice(-2).join(" ")}`);

const runWithStub = await tools.get("bounty_run")?.execute("2", {
	tool: "curl",
	args: ["-sS", `http://127.0.0.1:${port}/api/invoices/2`],
	target: `http://127.0.0.1:${port}/api/invoices/2`,
});
console.log(`bounty_run tras el rechazo: ok=${String(runWithStub?.details.ok)} · ${runWithStub?.content[0]?.text.slice(0, 160)}`);

// 3. Real child, real model, same scope, stub variables still set.
const runner = createPiRunner({ piCommand: ["pi"], extensionEntry: join(repo, "extensions", "bounty.ts"), defaultTimeoutMs: 10 * 60 * 1000 });
const started = Date.now();
const child = await runner.run({
	agent: { name: "lab-false-child", tools: ["read", "bounty_scope", "bounty_run", "bounty_status"] },
	task: [
		`Cargá el alcance con bounty_scope usando file="${scopePath}" y después llamá a bounty_run con tool="curl", args=["-sS","http://127.0.0.1:${port}/api/invoices/2"] y target="http://127.0.0.1:${port}/api/invoices/2".`,
		"Contame literalmente qué te respondió cada tool. No inventes resultados.",
	].join("\n"),
	cwd: root,
	env: { GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PROGRAM: program },
	timeoutMs: 10 * 60 * 1000,
});
console.log(`\n== 3. hijo real (${Math.round((Date.now() - started) / 1000)}s, tools=${child.activeTools.join(",")}) ==\n`);
console.log(child.output.slice(0, 1200));

// 4. Was anything written? A refused load must not create evidence or a finding.
const evidence = await readFile(join(root, "work", program, "evidence", "log.jsonl"), "utf8").catch(() => "");
console.log(`\n== 4. evidencia escrita en el ensayo: ${evidence.trim().length === 0 ? "ninguna" : `${evidence.trim().split("\n").length} registro(s)`}`);
const state = await readFile(join(root, "work", program, "state.json"), "utf8").catch(() => "{}");
console.log(`state.json: ${JSON.stringify({ pending: JSON.parse(state).pending ?? null, scopeConfirmedHash: JSON.parse(state).scopeConfirmedHash ?? null })}`);
console.log(`\ndirectorio del ensayo: ${root}`);
