/**
 * Part B at the extension level: tool_path (B1), the dialog with "No" first (B4) and the bounty_verify
 * wiring (D3). One root per file: the extension captures its root at module load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = await mkdtemp(join(tmpdir(), "bounty-ext-b-"));
const BIN = join(ROOT, "bin");
const MARKER = join(ROOT, "hydra.marker");
await mkdir(join(ROOT, "work", "lab"), { recursive: true });
await mkdir(join(ROOT, ".bounty"), { recursive: true });
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, "hydra"), `#!/bin/sh\necho called >> ${MARKER}\nexit 0\n`, { mode: 0o755 });
// B1: tool_path in the operator's config is the only way the child finds the binary; PATH lacks BIN.
await writeFile(join(ROOT, ".bounty", "config.json"), JSON.stringify({ tool_path: [BIN] }), "utf8");
await writeFile(join(ROOT, "work", "lab", "scope.yaml"), "program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n", "utf8");

process.env.GENTLE_BOUNTY_ROOT = ROOT;
process.env.PATH = "/usr/bin:/bin";
delete process.env.GENTLE_BOUNTY_ALLOW_CONFIRM_STUB;
delete process.env.GENTLE_BOUNTY_CONFIRM_TEST;

const mod = (await import("../extensions/bounty.ts")) as { default: (pi: unknown) => void };
const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, ctx?: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
mod.default({ registerTool: (spec: { name: string } & Record<string, unknown>) => tools.set(spec.name, spec as never) });

interface SelectCall {
	title: string;
	options: string[];
}

function ctxSelecting(answer: string, calls: SelectCall[]) {
	return {
		ui: {
			select: async (title: string, options: string[]) => {
				calls.push({ title, options });
				return answer;
			},
		},
	};
}

test("B1 + B4: the child finds the binary through tool_path, and No is the first option", async () => {
	const calls: SelectCall[] = [];
	const ctx = ctxSelecting("Sí, ejecutar", calls);
	await tools.get("bounty_scope")?.execute("1", { program: "lab", file: join(ROOT, "work", "lab", "scope.yaml") }, undefined, undefined, ctx);
	const run = await tools.get("bounty_run")?.execute(
		"2",
		{ program: "lab", tool: "hydra", args: ["-L", "l", "-P", "p", "127.0.0.1:3000", "ssh"], target: "http://127.0.0.1:3000/login" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(run?.details.ok, true, run?.content[0]?.text);
	const exists = await stat(MARKER).then(() => true, () => false);
	assert.equal(exists, true, "tool_path was not added to the child PATH");

	const destructive = calls.find((call) => /DESTRUCTIVA/.test(call.title));
	assert.ok(destructive, "no destructive dialog was recorded");
	assert.equal(destructive?.options[0], "No, no ejecutar", "No must be the first option");
	assert.match(destructive?.title ?? "", /hydra/);
	assert.match(destructive?.title ?? "", /brute-force/);
});

test("B4: answering the first option (No) does not execute", async () => {
	const calls: SelectCall[] = [];
	const ctx = ctxSelecting("No, no ejecutar", calls);
	const before = await stat(MARKER).then(() => 1, () => 0);
	const run = await tools.get("bounty_run")?.execute(
		"3",
		{ program: "lab", tool: "hydra", args: ["-L", "l", "-P", "p", "127.0.0.1:3000", "ssh"], target: "http://127.0.0.1:3000/login" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(run?.content[0]?.text ?? "", /denegada por el humano/);
	assert.equal(await stat(MARKER).then(() => 1, () => 0), before);
});

test("D3: bounty_verify launches the verifier and applies an unsupported verdict as candidate", async () => {
	// A fake `pi` that answers a verdict claiming a reproduction without evidence in its session.
	// The event is built with JSON.stringify and written through a heredoc, so no shell quoting games.
	const fakePi = join(ROOT, "fake-pi.sh");
	const verdictLine = '{"finding":"F-0001","verdict":"REPRODUCIDO","seqs":[1],"reason":"lo vi"}';
	const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Listo.\n${verdictLine}` }] } });
	await writeFile(fakePi, `#!/bin/sh\ncat <<'JSON'\n${event}\nJSON\nexit 0\n`, { mode: 0o755 });
	process.env.GENTLE_BOUNTY_PI = fakePi;
	await mkdir(join(ROOT, "work", "lab", "findings"), { recursive: true });
	await writeFile(
		join(ROOT, "work", "lab", "findings", "F-0001.json"),
		JSON.stringify({ id: "F-0001", program: "lab", title: "IDOR", state: "candidate", class: "idor", endpoint: "/api/invoices/2", parameter: "id", confidence: "high", cvss: null, score: null, sensitive: false, notes: [], fingerprint: "x", transitions: [], createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z" }),
		"utf8",
	);
	const verify = tools.get("bounty_verify");
	assert.ok(verify, "bounty_verify is not registered");
	const result = await verify.execute("4", { program: "lab", finding_id: "F-0001" });
	assert.equal(result.details.ok, false, result.content[0]?.text);
	assert.match(result.content[0]?.text ?? "", /Veredicto efectivo: INCONCLUSO/);
	assert.match(result.content[0]?.text ?? "", /sin ejecuciones firmadas/);
	const finding = JSON.parse(await readFile(join(ROOT, "work", "lab", "findings", "F-0001.json"), "utf8"));
	assert.equal(finding.state, "candidate", "an unsupported verdict must not verify the finding");
	// The verifier's answer was parsed (D2) and the finding is untouched.
	const records = await readdir(join(ROOT, "work", "lab", "evidence"));
	assert.ok(records.includes("log.jsonl"));
});
