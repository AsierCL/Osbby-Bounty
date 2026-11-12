/**
 * S43: the confirmation path exercised through the real extension code — real tool handlers, real
 * destructive classification, real process spawn — with the UI callback injected instead of a
 * keystroke. Pi's own widget is the only part this cannot cover.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTENSION = new URL("../extensions/bounty.ts", import.meta.url).pathname;

interface Registered {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		update?: unknown,
		ctx?: { ui?: { confirm?: (title: string, message?: string) => Promise<boolean> } },
	) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}

async function loadExtension(): Promise<Map<string, Registered>> {
	const module = (await import(EXTENSION)) as { default: (pi: unknown) => void };
	const tools = new Map<string, Registered>();
	module.default({
		registerTool(spec: Registered) {
			tools.set(spec.name, spec);
		},
	});
	return tools;
}

async function scenario(answer: boolean) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-ext-"));
	const binDir = join(dir, "bin");
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	await mkdir(binDir, { recursive: true });
	const marker = join(dir, "hydra-ran.marker");
	const fake = join(binDir, "hydra");
	await writeFile(fake, `#!/bin/sh\necho called >> ${marker}\nexit 0\n`, { mode: 0o755 });
	await writeFile(
		join(dir, "scope.yaml"),
		`program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n  allowed_req: []\n`.replace("  allowed_req: []\n", ""),
		"utf8",
	);

	const previous = {
		root: process.env.GENTLE_BOUNTY_ROOT,
		path: process.env.PATH,
		stub: process.env.GENTLE_BOUNTY_CONFIRM_TEST,
		allow: process.env.GENTLE_BOUNTY_ALLOW_CONFIRM_STUB,
	};
	process.env.GENTLE_BOUNTY_ROOT = dir;
	process.env.PATH = `${binDir}:${previous.path ?? ""}`;
	// The confirmation must come from the UI callback, not from the stub.
	delete process.env.GENTLE_BOUNTY_CONFIRM_TEST;
	delete process.env.GENTLE_BOUNTY_ALLOW_CONFIRM_STUB;

	try {
		const tools = await loadExtension();
		const scope = tools.get("bounty_scope");
		const run = tools.get("bounty_run");
		assert.ok(scope && run, "the extension must register bounty_scope and bounty_run");

		const questions: string[] = [];
		const ctx = {
			ui: {
				confirm: async (title: string, message?: string) => {
					questions.push(`${title}: ${message}`);
					return answer;
				},
			},
		};

		await scope.execute("1", { program: "lab", file: join(dir, "scope.yaml"), confirm: true });
		const result = await run.execute(
			"2",
			{
				program: "lab",
				tool: "hydra",
				args: ["-L", "logins.txt", "-P", "passwords.txt", "127.0.0.1", "ssh"],
				target: "http://127.0.0.1:3000/login",
			},
			undefined,
			undefined,
			ctx,
		);
		const executed = await stat(marker).then(
			() => true,
			() => false,
		);
		const status = await readFile(join(dir, "work", "lab", "status.md"), "utf8");
		return { result, executed, questions, status };
	} finally {
		if (previous.root === undefined) delete process.env.GENTLE_BOUNTY_ROOT;
		else process.env.GENTLE_BOUNTY_ROOT = previous.root;
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		await rm(dir, { recursive: true, force: true });
	}
}

test("answered no: the destructive command never runs and the pause is visible", async () => {
	const outcome = await scenario(false);
	assert.equal(outcome.questions.length, 1, "the human must be asked exactly once");
	assert.match(outcome.questions[0] ?? "", /brute-force/);
	assert.equal(outcome.executed, false, "the binary ran even though the human said no");
	assert.match(outcome.result.content[0]?.text ?? "", /clase destructiva/);
	assert.match(outcome.status, /destructiva necesita tu OK explícito/);
});

test("answered yes: the destructive command runs", async () => {
	const outcome = await scenario(true);
	assert.equal(outcome.questions.length, 1);
	assert.equal(outcome.executed, true, "the binary did not run even though the human said yes");
	assert.match(outcome.result.content[0]?.text ?? "", /hydra/);
});
