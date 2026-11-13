/**
 * S59: `bin/gentle-bounty --preflight <programa>`.
 *
 * The preflight is the human's first command before a live session, so the tests are about its
 * verdict, its exit code and — importantly — that it is read-only: it must not create a work
 * directory, must not touch the network and must not run any bounty tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = new URL("../bin/gentle-bounty.mjs", import.meta.url).pathname;

interface Run {
	status: number;
	out: string;
}

function preflight(root: string, program = "lab", env: Record<string, string> = {}): Run {
	try {
		const out = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--disable-warning=ExperimentalWarning", LAUNCHER, "--preflight", program],
			{ encoding: "utf8", env: { ...process.env, GENTLE_BOUNTY_ROOT: root, ...env }, stdio: ["ignore", "pipe", "pipe"] },
		);
		return { status: 0, out };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

const SCOPE = `program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n`;

const REPO = new URL("..", import.meta.url).pathname;

async function withRoot<T>(run: (root: string) => Promise<T>, scope: string = SCOPE): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "bounty-preflight-"));
	try {
		await mkdir(join(root, "work", "lab"), { recursive: true });
		await writeFile(join(root, "work", "lab", "scope.yaml"), scope, "utf8");
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("a healthy lab scope gets an OK verdict and exit 0", async () => {
	await withRoot(async (root) => {
		const result = preflight(root);
		assert.equal(result.status, 0, result.out);
		assert.match(result.out, /VEREDICTO: OK/);
		assert.match(result.out, /variables de test sin definir/);
		assert.match(result.out, /el scope parsea y declara lab: true/);
		assert.match(result.out, /ritmo declarado: 5 req\/s/);
		assert.match(result.out, /curl instalado/);
	});
});

test("the preflight creates nothing: it is read-only", async () => {
	await withRoot(async (root) => {
		const before = (await readdir(root)).sort();
		preflight(root);
		const after = (await readdir(root)).sort();
		assert.deepEqual(after, before);
		// And the program folder still has only the scope.
		assert.deepEqual((await readdir(join(root, "work", "lab"))).sort(), ["scope.yaml"]);
	});
});

test("stub variables present means NO, naming each variable", async () => {
	await withRoot(async (root) => {
		const result = preflight(root, "lab", { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1", GENTLE_BOUNTY_CONFIRM_TEST: "yes" });
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /VEREDICTO: NO/);
		assert.match(result.out, /GENTLE_BOUNTY_ALLOW_CONFIRM_STUB está definida/);
		assert.match(result.out, /GENTLE_BOUNTY_CONFIRM_TEST está definida/);
	});
});

test("a preload variable also means NO", async () => {
	await withRoot(async (root) => {
		const result = preflight(root, "lab", { GENTLE_BOUNTY_PRELOAD_SCOPE: join(root, "work", "lab", "scope.yaml") });
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /GENTLE_BOUNTY_PRELOAD_SCOPE está definida/);
	});
});

test("a scope without rate_rps is a warning: the gate falls back to 1 req/s", async () => {
	await withRoot(
		async (root) => {
			const result = preflight(root);
			assert.match(result.out, /AVISO el scope no declara limits\.rate_rps/);
			assert.doesNotMatch(result.out, /FALLA el scope no declara limits\.rate_rps/);
		},
		"program: lab\nlab: true\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  allowed_methods:\n    - GET\n",
	);
});

test("a scope without lab is a parse failure", async () => {
	await withRoot(
		async (root) => {
			const result = preflight(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /el scope no parsea/);
			assert.match(result.out, /lab is required/);
		},
		"program: lab\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n",
	);
});

test("a missing scope file is reported by path", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-preflight-missing-"));
	try {
		const result = preflight(root);
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /no encuentro el scope/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an invalid config file fails", async () => {
	await withRoot(async (root) => {
		await mkdir(join(root, ".bounty"), { recursive: true });
		await writeFile(join(root, ".bounty", "config.json"), '{"fetch_alow":["x"]}', "utf8");
		const result = preflight(root);
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /la configuración no es válida/);
	});
});

test("a dirty tree fails on a real program and only warns on a lab", async () => {
	const realScope = SCOPE.replace("lab: true", "lab: false");
	await withRoot(
		async (root) => {
			execFileSync("git", ["init", "-q"], { cwd: root });
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: root });
			await writeFile(join(root, "dirty.txt"), "x", "utf8");
			const result = preflight(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /árbol git tiene cambios sin commitear/);
		},
		realScope,
	);
	await withRoot(async (root) => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: root });
		await writeFile(join(root, "dirty.txt"), "x", "utf8");
		const result = preflight(root);
		assert.equal(result.status, 0, result.out);
		assert.match(result.out, /en un lab no importa/);
	});
});

test("the preflight never launches a session: pi is not required on PATH", async () => {
	await withRoot(async (root) => {
		const result = preflight(root, "lab", { PATH: "/usr/bin:/bin" });
		// Whatever the verdict, it must be a verdict, not a spawn failure.
		assert.match(result.out, /VEREDICTO/);
		assert.ok(!/could not start pi/.test(result.out), result.out);
	});
});

test("the launcher disables the host skill catalog for the bounty session (S75/task 5)", async () => {
	await withRoot(async () => {
		const result = spawnSync(process.execPath, [join(REPO, "bin", "gentle-bounty.mjs"), "--check", "lab"], { encoding: "utf8", cwd: REPO });
		assert.equal(result.status, 0, result.stderr);
		const args = JSON.parse(result.stdout).args;
		assert.ok(args.includes("-ns"), "the bounty session must not load the gentle-pi skills");
	});
});
