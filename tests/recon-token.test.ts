/**
 * S103: structured recon evidence from the CLI tools, and token lifecycle warnings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseReconOutput, summarizeRecon } from "../src/core/recon-tools.ts";
import { jwtExpiry, tokenStatus } from "../src/core/session-token.ts";
import { createEvidenceStore } from "../src/core/evidence.ts";
import { createSession } from "../src/pi/session.ts";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "HS256" })}.${b64({ exp })}.sig`;

test("httpx NDJSON, subfinder lines, katana urls and gobuster lines parse into entries", () => {
	const httpx = parseReconOutput("httpx", '{"url":"https://a.acme.com","status_code":200,"title":"Home","tech":["nginx"]}\n{"url":"https://b.acme.com","status_code":403}');
	assert.equal(httpx.length, 2);
	assert.deepEqual([httpx[0]?.kind, httpx[0]?.status, httpx[0]?.technologies], ["url", 200, ["nginx"]]);
	assert.equal(parseReconOutput("subfinder", "a.acme.com\nb.acme.com").length, 2);
	assert.equal(parseReconOutput("katana", '{"url":"https://a.acme.com/api/x"}')[0]?.kind, "url");
	assert.equal(parseReconOutput("gobuster", "/admin (Status: 403)")[0]?.kind, "line");
	assert.match(summarizeRecon(httpx), /2 url/);
});

test("a recon run appends structured recon-intelligence next to the raw result", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-recon-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 50\n", "utf8");
		const session = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: '{"url":"http://127.0.0.1:3000/api/x","status_code":200}\n', stderr: "" }),
				confirm: async () => true,
			},
		);
		await session.scope({ file: scopePath, confirm: async () => true });
		const result = await session.run({ tool: "httpx", args: ["-u", "http://127.0.0.1:3000/api/x", "-json"], target: "http://127.0.0.1:3000/api/x", reconTool: "httpx" });
		assert.equal(result.ok, true, result.text);
		assert.match(result.text, /Recon \(httpx\): 1 url/);
		const store = createEvidenceStore(join(dir, "work", "lab", "evidence"));
		const recon = (await store.read()).filter((record) => record.kind === "recon-intelligence").at(-1);
		assert.ok(recon);
		assert.equal((recon?.payload as { entries: { kind: string }[] }).entries[0]?.kind, "url");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the token status reads exp and refuses to waste a burst on an expired session", async () => {
	const now = () => Date.parse("2026-11-17T12:00:00Z");
	assert.equal(jwtExpiry(jwt(Math.floor(now() / 1000) + 3600)), Math.floor(now() / 1000) + 3600);
	assert.equal(tokenStatus(`Authorization: Bearer ${jwt(Math.floor(now() / 1000) + 3600)}`, now).state, "valid");
	assert.equal(tokenStatus(`Authorization: Bearer ${jwt(Math.floor(now() / 1000) + 120)}`, now).state, "expiring");
	assert.equal(tokenStatus(`Authorization: Bearer ${jwt(Math.floor(now() / 1000) - 60)}`, now).state, "expired");
	assert.equal(tokenStatus("Cookie: a=b", now).state, "unknown");
	assert.equal(tokenStatus(null, now).state, "missing");

	const dir = await mkdtemp(join(tmpdir(), "bounty-token-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 50\n", "utf8");
		await writeFile(join(dir, "work", "lab", "session.headers"), `Authorization: Bearer ${jwt(Math.floor(Date.now() / 1000) - 600)}\n`, "utf8");
		const calls: string[][] = [];
		const session = createSession(
			{ root: dir, program: "lab" },
			{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async (argv) => { calls.push(argv); return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" }; }, confirm: async () => true },
		);
		await session.scope({ file: scopePath, confirm: async () => true });
		const burst = await session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x", burst: 3 });
		assert.equal(burst.ok, false);
		assert.match(burst.text, /Ráfaga cancelada: el token ya expiró/);
		assert.equal(calls.length, 0, "nothing may run with an expired token");
		const status = await readFile(join(dir, "work", "lab", "status.md"), "utf8");
		assert.match(status, /sesión: .*token/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
