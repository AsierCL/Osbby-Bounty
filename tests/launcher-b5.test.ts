/**
 * B5: the launcher never hands the dead verifier variable to the session, and the preflight says NO if
 * it is defined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const LAUNCHER = join(REPO, "bin", "gentle-bounty.mjs");

test("the preflight says NO when GENTLE_BOUNTY_VERIFIER is defined", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-b5-"));
	try {
		await mkdir(join(root, "work", "lab"), { recursive: true });
		await writeFile(join(root, "work", "lab", "scope.yaml"), "program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 5\n", "utf8");
		const failing = await run(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", LAUNCHER, "--preflight", "lab"], {
			...process.env,
			GENTLE_BOUNTY_ROOT: root,
			GENTLE_BOUNTY_VERIFIER: "1",
		}).catch((error: { status?: number; stdout?: string }) => ({ status: error.status, stdout: error.stdout ?? "" }));
		assert.equal(failing.status, 1);
		assert.match(failing.stdout ?? "", /GENTLE_BOUNTY_VERIFIER está definida/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the launcher strips GENTLE_BOUNTY_VERIFIER from the session environment", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-b5-run-"));
	try {
		const bin = join(root, "bin");
		await mkdir(bin, { recursive: true });
		await mkdir(join(root, "work", "lab"), { recursive: true });
		const dump = join(root, "env.txt");
		// A fake `pi` that records whether the variable reached it.
		await writeFile(join(bin, "pi"), `#!/bin/sh\necho "VERIFIER=[$GENTLE_BOUNTY_VERIFIER]" > ${dump}\nexit 0\n`, { mode: 0o755 });
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_VERIFIER: "1" };
		execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", LAUNCHER, "lab"], { env, encoding: "utf8", cwd: root });
		assert.equal((await readFile(dump, "utf8")).trim(), "VERIFIER=[]");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		const [command, ...args] = argv;
		const child = execFileSync(command as string, args, { env, encoding: "utf8" });
		resolve({ status: 0, stdout: child });
	});
}
