/**
 * S91: reaching internal infrastructure or undocumented routes through a forwarding service is its own
 * destructive class, and it never inherits an authorization given earlier in the session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyDestructive, infraProbing } from "../src/core/destructive.ts";
import { createSession } from "../src/pi/session.ts";

test("the class is inferred from traversal, actuator and proxy-with-destination shapes", () => {
	assert.match(infraProbing(["/proxy?url=../../actuator/env"], "http://x/proxy") ?? "", /traversal/);
	assert.match(infraProbing(["/..%2f..%2factuator/env"], "http://x/") ?? "", /internal route/);
	assert.match(infraProbing(["/api/graphql?url=http://169.254.169.254/"], "http://x/api/graphql") ?? "", /forwarding endpoint|internal/);
	const verdict = classifyDestructive({ tool: "curl", args: ["-sS", "http://x/../../actuator/env"], scopeRateRps: 5 });
	assert.equal(verdict.destructive, true);
	assert.ok(verdict.classes.includes("infra-probing-via-proxy"), JSON.stringify(verdict.classes));
	assert.match(verdict.reason ?? "", /no hereda ninguna autorización previa/);
});

test("a normal API path is not this class", () => {
	assert.equal(infraProbing(["/api/invoices/2"], "http://x/api/invoices/2"), null);
	assert.equal(infraProbing(["/api/health"], "http://x/api/health"), null);
});

test("after approving a mutation, the traversal asks for its own confirmation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-infra-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 20\n  allowed_methods:\n    - GET\n    - POST\n", "utf8");
		const questions: string[] = [];
		const session = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" }),
				confirm: async (question) => {
					questions.push(question);
					return true;
				},
			},
		);
		await session.scope({ file: scopePath, confirm: async () => true });

		const mutation = await session.run({
			tool: "curl",
			args: ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "-d", '{"query":"mutation { x }"}', "http://127.0.0.1:3000/graphql"],
			target: "http://127.0.0.1:3000/graphql",
		});
		assert.equal(mutation.ok, true, mutation.text);

		const traversal = await session.run({
			tool: "curl",
			args: ["-sS", "http://127.0.0.1:3000/proxy?url=../../actuator/env"],
			target: "http://127.0.0.1:3000/proxy?url=../../actuator/env",
		});
		assert.equal(traversal.ok, true, traversal.text);
		assert.equal(questions.length, 2, "each action asks on its own");
		assert.match(questions[1] ?? "", /infra-probing-via-proxy/);
		assert.match(questions[1] ?? "", /no hereda ninguna autorización previa/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
