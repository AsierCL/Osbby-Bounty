/**
 * S66: the verifier script launches a child with the verifier flag and a task built from id + evidence
 * only. Contract test with a fake `pi` (S1b): no model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";

const REPO = new URL("..", import.meta.url).pathname;

test("the verifier child gets the flag and a task with the id and artifacts, never the notes", async () => {
	const root = await mkdtemp(join(tmpdir(), "bounty-verify-"));
	try {
		await mkdir(join(root, "work", "lab", "findings"), { recursive: true });
		await mkdir(join(root, "assets", "agents"), { recursive: true });
		await writeFile(
			join(root, "work", "lab", "findings", "F-0001.json"),
			JSON.stringify({ id: "F-0001", title: "SECRET-TITLE", notes: ["SECRET-NOTES"], state: "candidate" }),
			"utf8",
		);
		await writeFile(
			join(root, "assets", "agents", "bounty-verify.md"),
			"---\nname: bounty-verify\ntools: read, bounty_run, bounty_finding, bounty_evidence\n---\n",
			"utf8",
		);
		const store = createEvidenceStore(join(root, "work", "lab", "evidence"), { now: () => 1_700_000_000_000 });
		await store.append({ kind: "execution", payload: { tool: "curl", argv: ["curl", "-sS", "http://127.0.0.1:3000/api/2"] } });
		await store.append({ kind: "finding-note", payload: { note: "SECRET-NOTES" } });

		const dump = join(root, "dump.txt");
		const fakePi = join(root, "fake-pi.sh");
		await writeFile(
			fakePi,
			`#!/bin/sh\n{ echo "ARGV: $*"; echo "VERIFIER: $GENTLE_BOUNTY_VERIFIER"; } > ${dump}\necho '{"type":"agent_end","messages":[{"role":"system","toolsAdded":[{"name":"read"},{"name":"bounty_run"}]}]}'\nexit 0\n`,
			{ mode: 0o755 },
		);

		execFileSync(process.execPath, ["--experimental-strip-types", join(REPO, "scripts/verify-finding.ts"), "lab", "F-0001"], {
			encoding: "utf8",
			env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_PI: fakePi },
		});

		const captured = await readFile(dump, "utf8");
		assert.match(captured, /VERIFIER: 1/);
		assert.match(captured, /F-0001/);
		assert.match(captured, /bounty_run/);
		assert.ok(!captured.includes("SECRET-NOTES"), "the verifier task leaked the author's notes");
		assert.ok(!captured.includes("SECRET-TITLE"), "the verifier task leaked the title");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
