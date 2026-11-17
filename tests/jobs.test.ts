/**
 * S108/T6: a job is a file both sides share. These tests pin what the session relies on when it comes
 * back later: a closed set of states, an id that cannot escape its directory, a list ordered by
 * recency, and a running job that died reported as failed instead of alive forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJobStore, newJobId, reconcileStaleJobs, renderJob } from "../src/core/jobs.ts";

async function withStore(run: (store: ReturnType<typeof createJobStore>, workspace: string) => Promise<void>): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "bounty-jobs-"));
	try {
		await run(createJobStore({ workspace }), workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

test("a new job is queued, named, and persisted as one file", async () => {
	await withStore(async (store, workspace) => {
		const job = await store.create({ kind: "recon", program: "acme", subject: "acme.com" });
		assert.match(job.id, /^J-[0-9]{14}-[0-9a-f]{6}$/);
		assert.equal(job.state, "queued");
		assert.equal(job.pid, null);
		const files = await readdir(join(workspace, "jobs"));
		assert.deepEqual(files, [`${job.id}.json`]);
		const onDisk = JSON.parse(await readFile(join(workspace, "jobs", `${job.id}.json`), "utf8")) as { id: string };
		assert.equal(onDisk.id, job.id);
	});
});

test("ids do not collide even when created in the same second", () => {
	const at = Date.parse("2026-11-18T10:00:00Z");
	const ids = new Set(Array.from({ length: 500 }, () => newJobId(at)));
	assert.equal(ids.size, 500);
});

test("updates move the state and keep the identity", async () => {
	await withStore(async (store) => {
		const job = await store.create({ kind: "recon", program: "acme", subject: "acme.com" });
		const running = await store.update(job.id, { state: "running", pid: 1234, startedAt: "2026-11-18T10:00:00.000Z" });
		assert.equal(running.state, "running");
		assert.equal(running.pid, 1234);
		assert.equal(running.id, job.id);
		assert.equal(running.createdAt, job.createdAt);
		const done = await store.update(job.id, { state: "done", summary: "38 hosts vivos" });
		assert.equal(done.summary, "38 hosts vivos");
	});
});

test("an invalid state or an unknown job is an error, not a silent write", async () => {
	await withStore(async (store) => {
		const job = await store.create({ kind: "recon", program: "acme", subject: "acme.com" });
		await assert.rejects(() => store.update(job.id, { state: "paused" as never }), /invalid job state/);
		await assert.rejects(() => store.update("J-20260101000000-abcdef", { state: "done" }), /does not exist/);
	});
});

test("a job id cannot be used to read outside the jobs directory", async () => {
	await withStore(async (store) => {
		assert.equal(await store.read("../../etc/passwd"), null);
		assert.equal(await store.read("J-20260101000000-ABCDEF"), null);
	});
});

test("the list is newest first and latest returns it", async () => {
	await withStore(async (store) => {
		const first = await store.create({ kind: "recon", program: "acme", subject: "one.acme.com" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await store.create({ kind: "recon", program: "acme", subject: "two.acme.com" });
		const list = await store.list();
		assert.equal(list[0]?.id, second.id);
		assert.equal(list[1]?.id, first.id);
		assert.equal((await store.latest())?.id, second.id);
	});
});

test("an empty workspace has no jobs, not an error", async () => {
	await withStore(async (store) => {
		assert.deepEqual(await store.list(), []);
		assert.equal(await store.latest(), null);
	});
});

test("a running job that went silent is reported failed, not alive forever", () => {
	const started = Date.parse("2026-11-18T10:00:00Z");
	const base = {
		id: "J-20261118100000-aaaaaa",
		kind: "recon" as const,
		program: "acme",
		subject: "acme.com",
		createdAt: "2026-11-18T10:00:00.000Z",
		updatedAt: "2026-11-18T10:00:00.000Z",
		startedAt: "2026-11-18T10:00:00.000Z",
		finishedAt: null,
		pid: 99,
		summary: "corriendo",
		error: null,
		artifacts: [],
	};
	const [done] = reconcileStaleJobs([{ ...base, state: "done" }], started + 10 * 60 * 60 * 1000);
	assert.equal(done?.state, "done", "a finished job is never rewritten");
	const [fresh] = reconcileStaleJobs([{ ...base, state: "running" }], started + 60 * 1000);
	assert.equal(fresh?.state, "running");
	const [stale] = reconcileStaleJobs([{ ...base, state: "running" }], started + 31 * 60 * 1000);
	assert.equal(stale?.state, "failed");
	assert.match(stale?.summary ?? "", /desapareció/);
});

test("the rendered job is one line plus its outcome", async () => {
	await withStore(async (store) => {
		const job = await store.create({ kind: "recon", program: "acme", subject: "acme.com" });
		const finished = await store.update(job.id, { state: "done", summary: "38 hosts vivos" });
		const rendered = renderJob(finished);
		assert.match(rendered, /recon acme\.com · done/);
		assert.match(rendered, /38 hosts vivos/);
	});
});
