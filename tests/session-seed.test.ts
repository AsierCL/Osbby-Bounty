/**
 * S97: the human's session is injected from a local file and travels to curl in a private config, so
 * the evidence chain records the path and the header names, never the cookie or the token. The
 * program's required headers still have to come from argv.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";

async function setup(withSessionFile: boolean, requiredUa = false) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-seed-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(
		scopePath,
		`program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 20\n${requiredUa ? "required_headers:\n  User-Agent:\n    value: bugcrowd\n    mode: contains\n" : ""}`,
		"utf8",
	);
	if (withSessionFile) {
		await writeFile(join(dir, "work", "lab", "session.headers"), "# sesión del humano\nCookie: datadome=abc123; session=xyz.789\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.token\n", "utf8");
	}
	const executed: string[][] = [];
	const session = createSession(
		{ root: dir, program: "lab" },
		{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async (argv) => { executed.push(argv); return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" }; }, confirm: async () => true },
	);
	await session.scope({ file: scopePath, confirm: async () => true });
	return { dir, session, executed, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("the session file is injected through a private config, not through argv", async () => {
	const h = await setup(true);
	try {
		const result = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.equal(result.ok, true, result.text);
		const argv = h.executed[0] ?? [];
		assert.ok(argv.includes("-K"), `argv must carry -K: ${argv.join(" ")}`);
		const configIndex = argv.indexOf("-K");
		const configPath = argv[configIndex + 1] as string;
		assert.ok(configPath.includes(".session/curl.conf"));
		const config = await readFile(configPath, "utf8");
		assert.match(config, /header = "Cookie: datadome=abc123; session=xyz\.789"/);
		assert.match(config, /header = "Authorization: Bearer eyJ/);
		const mode = (await stat(configPath)).mode & 0o777;
		assert.equal(mode, 0o600, "the private config must not be world-readable");

		// The evidence records the path and the header names, never the values.
		const { createEvidenceStore } = await import("../src/core/evidence.ts");
		const store = createEvidenceStore(join(h.dir, "work", "lab", "evidence"));
		const execution = (await store.read()).filter((record) => record.kind === "execution").at(-1);
		const payload = execution?.payload as { argv: string[]; seededHeaders?: string[] };
		assert.deepEqual(payload.seededHeaders, ["Cookie", "Authorization"]);
		assert.ok(!JSON.stringify(payload).includes("abc123"), "the cookie value must not be in the chain");
		assert.ok(!JSON.stringify(payload).includes("eyJhbGciOiJIUzI1NiJ9"), "the token must not be in the chain");
	} finally {
		await h.cleanup();
	}
});

test("without a session file nothing is injected", async () => {
	const h = await setup(false);
	try {
		await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.ok(!(h.executed[0] ?? []).includes("-K"));
	} finally {
		await h.cleanup();
	}
});

test("seeding does not satisfy required headers: the User-Agent still has to be in argv", async () => {
	const h = await setup(true, true);
	try {
		const withoutUa = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.equal(withoutUa.ok, false);
		assert.match(withoutUa.text, /required header User-Agent is missing/);
		const withUa = await h.session.run({
			tool: "curl",
			args: ["-sS", "-H", "User-Agent: bugcrowd-research", "http://127.0.0.1:3000/x"],
			target: "http://127.0.0.1:3000/x",
		});
		assert.equal(withUa.ok, true, withUa.text);
		const argv = h.executed.at(-1) ?? [];
		assert.ok(argv.includes("-K"));
		assert.ok(argv.includes("User-Agent: bugcrowd-research"));
	} finally {
		await h.cleanup();
	}
});

test("S97: a 403 with x-datadome is named as protected infrastructure and the session pivots", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-waf-"));
	try {
		await mkdir(join(dir, "work", "lab"), { recursive: true });
		const scopePath = join(dir, "scope.yaml");
		await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 20\n", "utf8");
		const session = createSession(
			{ root: dir, program: "lab" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: "HTTP/1.1 403 Forbidden\r\nx-datadome: protected\r\n\r\nblocked", stderr: "" }),
				confirm: async () => true,
			},
		);
		await session.scope({ file: scopePath, confirm: async () => true });
		await session.run({ tool: "curl", args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		const status = await readFile(join(dir, "work", "lab", "status.md"), "utf8");
		assert.match(status, /Infraestructura protegida \(WAF: DataDome\)/);
		assert.match(status, /session\.headers/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
