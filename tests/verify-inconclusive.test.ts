/**
 * S76/task 3: the real failure, reproduced. A verifier child that answers NO_REPRODUCIDO with no
 * executions of its own must not touch the finding: the effective verdict is INCONCLUSO.
 *
 * One root per file: the extension captures its root at module load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = await mkdtemp(join(tmpdir(), "bounty-inconclusive-"));
await mkdir(join(ROOT, "work", "lab", "findings"), { recursive: true });
await mkdir(join(ROOT, "work", "lab", "evidence"), { recursive: true });
await writeFile(join(ROOT, "work", "lab", "scope.yaml"), "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n", "utf8");
await writeFile(
	join(ROOT, "work", "lab", "findings", "F-0001.json"),
	JSON.stringify({
		id: "F-0001",
		program: "lab",
		title: "IDOR",
		state: "candidate",
		class: "idor",
		endpoint: "/api/invoices/2",
		parameter: "id",
		confidence: "high",
		cvss: null,
		score: null,
		sensitive: false,
		notes: [],
		fingerprint: "x",
		transitions: [],
		createdAt: "2026-11-11T00:00:00Z",
		updatedAt: "2026-11-11T00:00:00Z",
	}),
	"utf8",
);

const fakePi = join(ROOT, "fake-pi.sh");
const verdict = '{"finding":"F-0001","verdict":"NO_REPRODUCIDO","seqs":[],"reason":"El gate bloqueó toda ejecución: no cargué el alcance."}';
const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `No pude ejecutar nada.\n${verdict}` }] } });
await writeFile(fakePi, `#!/bin/sh\ncat <<'JSON'\n${event}\nJSON\nexit 0\n`, { mode: 0o755 });

process.env.GENTLE_BOUNTY_ROOT = ROOT;
process.env.GENTLE_BOUNTY_PI = fakePi;

const mod = (await import("../extensions/bounty.ts")) as { default: (pi: unknown) => void };
const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
mod.default({ registerTool: (spec: { name: string } & Record<string, unknown>) => tools.set(spec.name, spec as never) });

test("a NO_REPRODUCIDO with no signed executions leaves the finding untouched", async () => {
	const verify = tools.get("bounty_verify");
	assert.ok(verify);
	const result = await verify.execute("1", { program: "lab", finding_id: "F-0001" });
	const text = result.content[0]?.text ?? "";
	assert.equal(result.details.ok, false, text);
	assert.match(text, /Veredicto del verificador: NO_REPRODUCIDO/);
	assert.match(text, /Veredicto efectivo: INCONCLUSO \(convertido por el código\)/);
	assert.match(text, /sin ejecuciones firmadas/);

	const finding = JSON.parse(await readFile(join(ROOT, "work", "lab", "findings", "F-0001.json"), "utf8"));
	assert.equal(finding.state, "candidate", "the finding must not move on an inconclusive verdict");

	const status = await readFile(join(ROOT, "work", "lab", "status.md"), "utf8");
	assert.match(status, /INCONCLUSO/);
	assert.match(status, /sin ejecuciones firmadas/);

	const log = (await readFile(join(ROOT, "work", "lab", "evidence", "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const verification = log.filter((record: { kind: string }) => record.kind === "verification").at(-1);
	assert.equal(verification.payload.effective, "INCONCLUSO");
	assert.equal(verification.payload.converted, true);
	assert.equal(verification.payload.verdict, "NO_REPRODUCIDO");
});

test.after(async () => {
	delete process.env.GENTLE_BOUNTY_PI;
	await rm(ROOT, { recursive: true, force: true });
});
