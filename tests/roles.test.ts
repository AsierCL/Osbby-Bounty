/**
 * S106: the role matrix needs one session per role, and the credential still must never reach argv
 * or the evidence chain. These tests pin the three properties that make it safe: one parser for both
 * session files, author names only in every output, and a role that is injected exactly like the
 * single session already is (curl's private config).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { duplicatedHeaderNames, parseHeaderLines } from "../src/core/headers.ts";
import { createRoleStore, normalizeRoleName } from "../src/core/roles.ts";
import { createSession } from "../src/pi/session.ts";
import { createEvidenceStore } from "../src/core/evidence.ts";

const SECRET = "s3cr3t-cookie-value";

test("the header parser ignores comments and blanks, and keeps duplicates", () => {
	const parsed = parseHeaderLines("# comentario\n\nCookie: a=1\nmalformed line\nAuthorization: Bearer x\nCookie: b=2\n");
	assert.deepEqual(parsed, [
		{ name: "Cookie", value: "a=1" },
		{ name: "Authorization", value: "Bearer x" },
		{ name: "Cookie", value: "b=2" },
	]);
	assert.deepEqual(duplicatedHeaderNames(parsed), ["Cookie"]);
});

test("a role name cannot escape its directory", () => {
	assert.equal(normalizeRoleName("User-A"), "user-a");
	assert.equal(normalizeRoleName(" admin "), "admin");
	for (const bad of ["", "../escape", "a/b", "a b", "-x", "x".repeat(43)]) {
		assert.throws(() => normalizeRoleName(bad), /rol inválido/, bad);
	}
});

async function withRoles(run: (store: ReturnType<typeof createRoleStore>, workspace: string) => Promise<void>): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "bounty-roles-"));
	try {
		await run(createRoleStore({ workspace }), workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

test("a role file is written 0600 and listed by header name only", async () => {
	await withRoles(async (store, workspace) => {
		await store.write("user-a", `Cookie: session=${SECRET}\nX-Team: a\n`);
		const info = await store.write("user-b", `Authorization: Bearer ${SECRET}\n`);

		const mode = (await stat(store.file("user-a"))).mode & 0o777;
		assert.equal(mode, 0o600);
		assert.deepEqual(info.headerNames, ["Authorization"]);

		const listed = await store.list();
		assert.deepEqual(listed.map((entry) => entry.role), ["user-a", "user-b"]);
		assert.deepEqual(listed[0]?.headerNames, ["Cookie", "X-Team"]);
		// The listing is what the model sees: it must not contain the value.
		assert.ok(!JSON.stringify(listed).includes(SECRET), "a listing leaked a credential value");
		assert.deepEqual(listed[0]?.warnings, []);
		assert.ok(workspace.length > 0);
	});
});

test("a role with no cookie or authorization says it probably authenticates nothing", async () => {
	await withRoles(async (store) => {
		const info = await store.write("anonymous", "X-Team: public\n");
		assert.match(info.warnings.join(" "), /no tiene Cookie ni Authorization/);
	});
});

test("reading a missing role is null, not an empty session", async () => {
	await withRoles(async (store) => {
		assert.equal(await store.read("user-c"), null);
		assert.deepEqual(await store.list(), []);
	});
});

async function sessionWith(scopeExtra: string, setupRoles: (workspace: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-role-run-"));
	const workspace = join(dir, "work", "lab");
	await mkdir(workspace, { recursive: true });
	await setupRoles(workspace);
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, `program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 50\n${scopeExtra}`, "utf8");
	const executed: string[][] = [];
	const session = createSession(
		{ root: dir, program: "lab" },
		{ dns: async () => ({ cname: [] }), readFile: (path) => readFile(path, "utf8"), runTool: async (argv) => { executed.push(argv); return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{}", stderr: "" }; }, confirm: async () => true },
	);
	await session.scope({ file: scopePath, confirm: async () => true });
	return { dir, workspace, session, executed, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a named role is injected through curl's private config, and the evidence keeps the name only", async () => {
	const h = await sessionWith("", async (workspace) => {
		await createRoleStore({ workspace }).write("user-b", `Cookie: session=${SECRET}\n`);
	});
	try {
		const result = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/invoices/42"], target: "http://127.0.0.1:3000/invoices/42", role: "user-b" });
		assert.equal(result.ok, true, result.text);
		const argv = h.executed[0] ?? [];
		assert.ok(argv.includes("-K"), `argv must carry -K: ${argv.join(" ")}`);
		assert.ok(!argv.join(" ").includes(SECRET), "the credential leaked into argv");
		const configPath = argv[argv.indexOf("-K") + 1] as string;
		assert.match(await readFile(configPath, "utf8"), new RegExp(`header = "Cookie: session=${SECRET}"`));

		const store = createEvidenceStore(join(h.workspace, "evidence"));
		const execution = (await store.read()).filter((record) => record.kind === "execution").at(-1);
		const payload = execution?.payload as { role?: string; seededHeaders?: string[]; argv?: string[] };
		assert.equal(payload.role, "user-b");
		assert.deepEqual(payload.seededHeaders, ["Cookie"]);
		assert.ok(!JSON.stringify(payload).includes(SECRET), "the credential leaked into the chain");
	} finally {
		await h.cleanup();
	}
});

test("a role that was never loaded is a refusal, not an anonymous request", async () => {
	const h = await sessionWith("", async () => undefined);
	try {
		const result = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x", role: "user-a" });
		assert.equal(result.ok, false);
		assert.match(result.text, /sessions\/user-a\.headers/);
		assert.equal(h.executed.length, 0, "nothing may run without the session it asked for");
	} finally {
		await h.cleanup();
	}
});

test("a role on a tool that cannot take a private config is refused", async () => {
	const h = await sessionWith("", async (workspace) => {
		await createRoleStore({ workspace }).write("user-a", `Cookie: session=${SECRET}\n`);
	});
	try {
		const result = await h.session.run({ tool: "nuclei", args: ["-u", "http://127.0.0.1:3000"], target: "http://127.0.0.1:3000", role: "user-a" });
		assert.equal(result.ok, false);
		assert.match(result.text, /se inyecta con curl/);
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("an invalid role name is refused before anything else", async () => {
	const h = await sessionWith("", async () => undefined);
	try {
		const result = await h.session.run({ tool: "curl", args: ["http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x", role: "../../etc/passwd" });
		assert.equal(result.ok, false);
		assert.match(result.text, /rol inválido/);
		assert.equal(h.executed.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("requires_session is satisfied by a role, without a single session file", async () => {
	const h = await sessionWith("requires_session: true\n", async (workspace) => {
		await createRoleStore({ workspace }).write("anonymous", "X-None: 1\n");
	});
	try {
		const withoutRole = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x" });
		assert.equal(withoutRole.ok, false);
		assert.match(withoutRole.text, /requires_session/);

		const withRole = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/x"], target: "http://127.0.0.1:3000/x", role: "anonymous" });
		assert.equal(withRole.ok, true, withRole.text);
	} finally {
		await h.cleanup();
	}
});
