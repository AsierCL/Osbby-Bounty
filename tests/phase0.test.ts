/**
 * S104: Phase 0 filters subdomains through httpx and hands the agent only live hosts; the budget
 * reserves its last slice for API/GraphQL/critical flows; a program can require an injected session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyTarget, isHighValue, reserveFor } from "../src/core/priority.ts";
import { filterAlive } from "../src/core/recon-tools.ts";
import { createSession } from "../src/pi/session.ts";

test("only 2xx/3xx/401/403 survive the filter", () => {
	const entries = [200, 301, 401, 403, 404, 500, 503].map((status) => ({ kind: "url" as const, value: `https://x/${status}`, status }));
	const alive = filterAlive(entries);
	assert.deepEqual(alive.map((host) => host.status), [200, 301, 401, 403]);
	assert.equal(filterAlive([{ kind: "url", value: "https://dead" }]).length, 0, "no status means dead");
});

test("priority: API, GraphQL and critical flows outrank pages", () => {
	assert.equal(classifyTarget("/api/v2/users/1").kind, "api");
	assert.equal(classifyTarget("/graphql").kind, "graphql");
	assert.equal(classifyTarget("/admin/roles").kind, "privilege");
	assert.equal(classifyTarget("/checkout").kind, "purchase");
	assert.equal(classifyTarget("/login").kind, "auth");
	assert.equal(classifyTarget("/about").kind, "page");
	assert.equal(isHighValue("/graphql"), true);
	assert.equal(isHighValue("/about"), false);
	assert.equal(reserveFor(300), 60);
});

test("phase 0 runs subfinder then httpx and keeps only the live subset", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-phase0-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(
			scopePath,
			["program: lab", "lab: true", "authorized_on: 2026-01-01", "in_scope:", "  - acme.com", "  - a.acme.com", "  - b.acme.com", "  - c.acme.com", "limits:", "  rate_rps: 50", ""].join("\n"),
			"utf8",
		);
		const session = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async (argv) => {
					if (argv[0] === "subfinder") return { exitCode: 0, stdout: "a.acme.com\nb.acme.com\nc.acme.com\n", stderr: "" };
					return {
						exitCode: 0,
						stdout: [
							JSON.stringify({ url: "https://a.acme.com", status_code: 200, title: "A" }),
							JSON.stringify({ url: "https://b.acme.com", status_code: 403 }),
							JSON.stringify({ url: "https://c.acme.com", status_code: 503 }),
						].join("\n"),
						stderr: "",
					};
				},
				confirm: async () => true,
			},
		);
		await session.scope({ file: scopePath, confirm: async () => true });
		const result = await session.reconPipeline({ domain: "acme.com" });
		assert.equal(result.ok, true, result.text);
		assert.match(result.text, /3 subdominio\(s\) → 2 vivo\(s\)/);
		const alive = JSON.parse(await readFile(join(dir, "work", "lab", "alive-hosts.json"), "utf8")) as { url: string; status: number }[];
		assert.deepEqual(alive.map((host) => host.status), [200, 403]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("requires_session blocks any run until the human seeds the session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-reqsession-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, ["program: lab", "lab: true", "authorized_on: 2026-01-01", "requires_session: true", "in_scope:", "  - 127.0.0.1:3000", "limits:", "  rate_rps: 50", ""].join("\n"), "utf8");
		const calls: string[][] = [];
		const session = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async (argv) => {
					calls.push(argv);
					return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" };
				},
				confirm: async () => true,
			},
		);
		await session.scope({ file: scopePath, confirm: async () => true });
		const blocked = await session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.equal(blocked.ok, false);
		assert.match(blocked.text, /exige sesión inyectada/);
		assert.equal(calls.length, 0);

		await writeFile(join(dir, "work", "lab", "session.headers"), "Cookie: session=abc\n", "utf8");
		const allowed = await session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.equal(allowed.ok, true, allowed.text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
