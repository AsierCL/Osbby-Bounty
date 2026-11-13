/**
 * S75/task 1: cleaning up the kit must never delete evidence. The work directory is archived with a
 * timestamp and the path is reported; only the marker and the hydra stub are removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

const exists = (path: string) => stat(path).then(() => true, () => false);

test("cleanup archives the work dir with a timestamp and deletes only marker and stub", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-cleanup-"));
	try {
		const bin = join(root, "bin");
		const marker = join(root, "marker");
		await mkdir(join(root, "work", "lab-s43", "evidence"), { recursive: true });
		await mkdir(bin, { recursive: true });
		await writeFile(join(root, "work", "lab-s43", "evidence", "log.jsonl"), "{}\n", "utf8");
		await writeFile(marker, "called\n", "utf8");
		await writeFile(join(bin, "hydra"), "#!/bin/sh\n", { mode: 0o755 });

		const out = execFileSync("sh", [join(REPO, "scripts", "s43-cleanup.sh")], {
			encoding: "utf8",
			env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_S43_BIN: bin, GENTLE_BOUNTY_S43_MARKER: marker },
		});

		assert.equal(await exists(marker), false, "the marker is disposable");
		assert.equal(await exists(join(bin, "hydra")), false, "the stub is disposable");
		assert.equal(await exists(join(root, "work", "lab-s43")), false, "the work dir moves, not disappears");
		const archived = (await readdir(join(root, "work"))).filter((entry) => /^lab-s43-archivo-\d{8}-\d{6}$/.test(entry));
		assert.equal(archived.length, 1, out);
		assert.equal(await exists(join(root, "work", archived[0] as string, "evidence", "log.jsonl")), true);
		assert.match(out, /evidencia archivada en .*lab-s43-archivo-/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cleanup on an empty kit says so instead of inventing an archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-cleanup-empty-"));
	try {
		const out = execFileSync("sh", [join(REPO, "scripts", "s43-cleanup.sh")], {
			encoding: "utf8",
			env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_S43_BIN: join(root, "bin"), GENTLE_BOUNTY_S43_MARKER: join(root, "m") },
		});
		assert.match(out, /no había evidencia que archivar/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
