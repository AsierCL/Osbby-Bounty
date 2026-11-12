/**
 * S69: the lab listens on a fixed default port (8787) and the preflight warns when a lab scope points
 * at a port where nothing listens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const LAUNCHER = join(REPO, "bin", "gentle-bounty.mjs");

test("lab-up.sh brings the lab up on the requested port and writes it to .lab/port", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-lab-port-"));
	try {
		// A stale pid from an earlier run would make lab-up return the old port.
		execFileSync("sh", [join(REPO, "scripts", "lab-down.sh")], { encoding: "utf8", cwd: REPO });
		execFileSync("sh", [join(REPO, "scripts", "lab-up.sh")], {
			encoding: "utf8",
			env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_LAB_PORT: "8899" },
			cwd: REPO,
		});
		// lab-up.sh works on its own repo root, so assert against the repo's .lab/port.
		const port = (await readFile(join(REPO, ".lab", "port"), "utf8")).trim();
		assert.equal(port, "8899");
	} finally {
		execFileSync("sh", [join(REPO, "scripts", "lab-down.sh")], { encoding: "utf8", cwd: REPO });
		await rm(root, { recursive: true, force: true });
	}
});

test("the preflight warns when the lab scope points at a dead port", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-preflight-port-"));
	try {
		await mkdir(join(root, "work", "lab"), { recursive: true });
		await writeFile(
			join(root, "work", "lab", "scope.yaml"),
			"program: lab\nlab: true\nauthorized_on: 2026-11-11\nin_scope:\n  - 127.0.0.1:33999\nlimits:\n  rate_rps: 5\n",
			"utf8",
		);
		const out = execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", LAUNCHER, "--preflight", "lab"], {
			encoding: "utf8",
			env: { ...process.env, GENTLE_BOUNTY_ROOT: root },
		});
		assert.match(out, /en 127\.0\.0\.1:33999 no escucha nada/);
		assert.match(out, /lab-up\.sh/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
