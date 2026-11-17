/**
 * S108/T6: the recon job's contract. The interesting cases are the two failures that must not look
 * like success: an unconfirmed scope (the child has no dialog) and a recon that failed. Both leave the
 * job `failed` with the reason written, never a `done` with no data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJobStore } from "../src/core/jobs.ts";
import { listJobs, runReconJob } from "../src/pi/recon-job.ts";

async function withStore(run: (store: ReturnType<typeof createJobStore>) => Promise<void>): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "bounty-recon-job-"));
	try {
		await run(createJobStore({ workspace, now: () => Date.parse("2026-11-18T10:00:00Z") }));
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

test("a good run records the artifact and the summary the session will read", async () => {
	await withStore(async (jobs) => {
		const result = await runReconJob(
			{ program: "acme", domain: "acme.com" },
			{
				jobs,
				loadScope: async () => ({ ok: true, text: "alcance cargado" }),
				recon: async () => ({ ok: true, text: "38 hosts vivos\nalive-hosts.json", artifacts: ["alive-hosts.json"] }),
				pid: 4242,
			},
		);
		assert.equal(result.ok, true);
		assert.equal(result.job.state, "done");
		assert.equal(result.job.summary, "38 hosts vivos");
		assert.deepEqual(result.job.artifacts, ["alive-hosts.json"]);
		assert.equal(result.job.pid, 4242);
		assert.ok(result.job.startedAt);
		assert.ok(result.job.finishedAt);
	});
});

test("an unconfirmed scope fails the job before any recon runs", async () => {
	await withStore(async (jobs) => {
		let reconCalled = false;
		const result = await runReconJob(
			{ program: "acme", domain: "acme.com" },
			{
				jobs,
				loadScope: async () => ({ ok: false, text: "El alcance nunca fue confirmado para este archivo" }),
				recon: async () => {
					reconCalled = true;
					return { ok: true, text: "" };
				},
			},
		);
		assert.equal(result.ok, false);
		assert.equal(reconCalled, false, "the job must not touch the network without a confirmed scope");
		assert.equal(result.job.state, "failed");
		assert.match(result.job.error ?? "", /nunca fue confirmado/);
	});
});

test("a failed recon leaves the reason written, not an empty success", async () => {
	await withStore(async (jobs) => {
		const result = await runReconJob(
			{ program: "acme", domain: "acme.com" },
			{
				jobs,
				loadScope: async () => ({ ok: true, text: "" }),
				recon: async () => ({ ok: false, text: "subfinder no está en el PATH" }),
			},
		);
		assert.equal(result.ok, false);
		assert.equal(result.job.state, "failed");
		assert.match(result.job.error ?? "", /subfinder/);
	});
});

test("resuming a job updates that job instead of starting another one", async () => {
	await withStore(async (jobs) => {
		const created = await jobs.create({ kind: "recon", program: "acme", subject: "acme.com" });
		const result = await runReconJob(
			{ program: "acme", domain: "acme.com", jobId: created.id },
			{ jobs, loadScope: async () => ({ ok: true, text: "" }), recon: async () => ({ ok: true, text: "ok" }) },
		);
		assert.equal(result.job.id, created.id);
		assert.equal((await jobs.list()).length, 1);
	});
});

test("the list applies the stale rule, so a dead child does not look alive", async () => {
	await withStore(async (jobs) => {
		const created = await jobs.create({ kind: "recon", program: "acme", subject: "acme.com" });
		await jobs.update(created.id, { state: "running", startedAt: "2026-11-18T09:00:00.000Z" });
		const list = await listJobs(jobs, Date.parse("2026-11-18T10:00:00Z"));
		assert.equal(list[0]?.state, "failed");
	});
});
