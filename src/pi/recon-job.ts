/**
 * S108/T6: the recon job's logic, separated from the process that runs it.
 *
 * `scripts/recon-job.ts` builds a real session and calls this; the tests pass a fake session. The
 * contract is small on purpose: the job records its own state transitions and nothing else. Scope,
 * rate, gate and evidence are the session's business, identical to a foreground run.
 */
import type { JobRecord, JobStore } from "../core/jobs.ts";
import { reconcileStaleJobs } from "../core/jobs.ts";

export interface ReconJobDeps {
	jobs: JobStore;
	/** Loads the program's confirmed scope. A child has no dialog: an unconfirmed scope fails. */
	loadScope: () => Promise<{ ok: boolean; text: string }>;
	/** Runs subfinder + httpx through the gate and the shared limiter. */
	recon: (domain: string) => Promise<{ ok: boolean; text: string; artifacts?: string[] }>;
	now?: () => number;
	pid?: number;
}

export interface ReconJobResult {
	job: JobRecord;
	ok: boolean;
	/** The recon output, so the child can log it. */
	text: string;
}

export async function runReconJob(input: { program: string; domain: string; jobId?: string }, deps: ReconJobDeps): Promise<ReconJobResult> {
	const now = deps.now ?? (() => Date.now());

	const job =
		input.jobId === undefined
			? await deps.jobs.create({ kind: "recon", program: input.program, subject: input.domain })
			: (await deps.jobs.read(input.jobId)) ?? (await deps.jobs.create({ kind: "recon", program: input.program, subject: input.domain }));

	await deps.jobs.update(job.id, { state: "running", startedAt: new Date(now()).toISOString(), pid: deps.pid ?? process.pid, summary: "corriendo" });

	const scope = await deps.loadScope();
	if (!scope.ok) {
		const failed = await deps.jobs.update(job.id, {
			state: "failed",
			finishedAt: new Date(now()).toISOString(),
			summary: "no pude cargar el alcance confirmado",
			error: scope.text.slice(0, 500),
		});
		return { job: failed, ok: false, text: scope.text };
	}

	const recon = await deps.recon(input.domain);
	const finished = await deps.jobs.update(job.id, {
		state: recon.ok ? "done" : "failed",
		finishedAt: new Date(now()).toISOString(),
		summary: recon.ok ? recon.text.split("\n")[0] ?? "terminado" : "el recon falló",
		...(recon.artifacts === undefined ? {} : { artifacts: recon.artifacts }),
		...(recon.ok ? {} : { error: recon.text.slice(0, 500) }),
	});
	return { job: finished, ok: recon.ok, text: recon.text };
}

/** Job list for `bounty_job`: stale running jobs are reported as failed, not as alive. */
export async function listJobs(jobs: JobStore, at: number): Promise<JobRecord[]> {
	return reconcileStaleJobs(await jobs.list(), at);
}
