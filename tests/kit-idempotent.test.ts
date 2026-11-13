/**
 * S74/task 2: the kit's scope is idempotent and does not depend on the system clock.
 * Two runs on either side of midnight must produce the same file hash and must not archive anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

test("two runs with different dates (across midnight) produce the same scope and no archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-kit-idem-"));
	try {
		const bin = join(root, "fakebin");
		await mkdir(join(root, ".lab"), { recursive: true });
		await mkdir(bin, { recursive: true });
		await writeFile(join(root, ".lab", "port"), "8787\n", "utf8");
		const dateFile = join(root, "date.txt");
		// A fake clock: the script only uses `date` for the archive name, and that is the point.
		await writeFile(join(bin, "date"), `#!/bin/sh\ncat ${dateFile}\n`, { mode: 0o755 });

		const runPrepare = (fakeDate: string) => {
			execFileSync("sh", ["-c", `printf '%s' '${fakeDate}' > ${dateFile}`], { encoding: "utf8" });
			return execFileSync("sh", [join(REPO, "scripts", "s43-prepare.sh")], {
				encoding: "utf8",
				cwd: REPO,
				env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_S43_BIN: join(root, "bin"), PATH: `${bin}:${process.env.PATH}`, GENTLE_BOUNTY_S43_MARKER: join(root, "marker") },
			});
		};

		const first = runPrepare("2026-11-12-235959");
		const scopePath = join(root, "work", "lab-s43", "scope.yaml");
		const hashOne = createHash("sha256").update(await readFile(scopePath, "utf8"), "utf8").digest("hex");

		const second = runPrepare("2026-11-13-000001");
		const hashTwo = createHash("sha256").update(await readFile(scopePath, "utf8"), "utf8").digest("hex");

		assert.equal(hashOne, hashTwo, "the scope hash must not depend on the clock");
		assert.match(second, /scope idéntico al anterior/);
		const dirs = await readdir(join(root, "work"));
		assert.deepEqual(dirs.filter((entry) => entry.includes("archivo")), [], "an identical scope must not archive the run");
		assert.match(first, /Listo\./);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
