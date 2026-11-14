/**
 * S81/task 2: a GraphQL mutation changes state, so it pauses like hydra does. This is the floor under
 * the model's judgment, not a replacement: any `mutation` in a GraphQL body pauses, whatever its name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyDestructive, graphqlMutation } from "../src/core/destructive.ts";
import { startLab } from "../lab/server.ts";
import { createSession } from "../src/pi/session.ts";

const leaky = (args: string[]) => ({ tool: "curl", args, scopeRateRps: 5 });
const run = (argv: string[]) =>
	new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
		const [command, ...rest] = argv;
		execFile(command as string, rest, (error, stdout, stderr) => {
			resolve({ exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});

test("a JSON GraphQL mutation is destructive, by shape and not by name", () => {
	const verdict = classifyDestructive(leaky(["-sS", "-H", "Content-Type: application/json", "-d", '{"query":"mutation { addNote(text:\\"x\\") { ok } }"}']));
	assert.equal(verdict.destructive, true);
	assert.deepEqual(verdict.classes, ["graphql-mutation"]);
	assert.match(verdict.reason ?? "", /GraphQL mutation/);
});

test("a query is not a mutation, and a comment mentioning mutation does not count", () => {
	const query = classifyDestructive(leaky(["-H", "Content-Type: application/json", "-d", '{"query":"query { invoices { id } }"}']));
	assert.equal(query.destructive, false);
	const commented = classifyDestructive(leaky(["-H", "Content-Type: application/json", "-d", '# mutation ignored\n{"query":"query { id }"}']));
	assert.equal(commented.destructive, false);
});

test("raw application/graphql bodies count, and so does an unlabelled JSON body", () => {
	const raw = graphqlMutation(["-H", "Content-Type: application/graphql", "-d", "mutation { pay(amount: 1) { ok } }"]);
	assert.notEqual(raw, null);
	const json = graphqlMutation(["-d", '{"operationName":"x","query":"mutation { transfer { ok } }"}']);
	assert.notEqual(json, null);
});

test("the destructive pause happens against the lab with a test mutation", async () => {
	const lab = await startLab(0);
	const dir = await mkdtemp(join(tmpdir(), "bounty-gql-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, `program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:${lab.port}\nlimits:\n  rate_rps: 10\n  allowed_methods:\n    - GET\n    - POST\n`, "utf8");

		const questions: string[] = [];
		const declined = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: run,
				confirm: async (question) => {
					if (!/DESTRUCTIVA|GraphQL mutation/.test(question)) return true;
					questions.push(question);
					return false;
				},
			},
		);
		await declined.scope({ file: scopePath });
		const target = `http://127.0.0.1:${lab.port}/graphql`;
		const blocked = await declined.run({
			tool: "curl",
			args: ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "-d", '{"query":"mutation { addNote(text:\\"hola\\") { ok } }"}', target],
			target,
		});
		assert.equal(blocked.ok, false, blocked.text);
		assert.match(blocked.text, /denegada por el humano|no ejecuté/i);
		assert.equal(questions.length, 1, "the mutation must always ask");
		assert.match(questions[0] ?? "", /GraphQL mutation/);
		assert.deepEqual(lab.mutations, [], "nothing may reach the lab when the human says no");

		const accepted = createSession(
			{ root: dir, program: "lab" },
			{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: run, confirm: async () => true },
		);
		await accepted.scope({ file: scopePath, confirm: async () => true });
		const allowed = await accepted.run({
			tool: "curl",
			args: ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "-d", '{"query":"mutation { addNote(text:\\"hola\\") { ok } }"}', target],
			target,
		});
		assert.equal(allowed.ok, true, allowed.text);
		assert.equal(lab.mutations.length, 1, "the mutation reached the lab only after the human said yes");

		// A query does not pause: same endpoint, same headers, no mutation.
		const querySession = createSession(
			{ root: dir, program: "lab" },
			{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: run, confirm: async () => { throw new Error("a query must not ask"); } },
		);
		await querySession.scope({ file: scopePath, confirm: async () => true });
		const queryRun = await querySession.run({
			tool: "curl",
			args: ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "-d", '{"query":"query { invoices { id } }"}', target],
			target,
		});
		assert.equal(queryRun.ok, true, queryRun.text);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await lab.close();
	}
});
