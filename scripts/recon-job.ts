/**
 * S108/T6: the background recon job.
 *
 * It is a separate process on purpose: the session that launches it can end, and the job still
 * finishes. It builds the same session the extension builds — same gate, same shared limiter, same
 * evidence chain — because a job is scheduling, never a second way to touch the network.
 *
 *   node --experimental-strip-types scripts/recon-job.ts <program> <domain> [jobId] [scopePath]
 *
 * Environment: GENTLE_BOUNTY_ROOT (defaults to the current directory).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createSession } from "../src/pi/session.ts";
import { createJobStore } from "../src/core/jobs.ts";
import { runReconJob } from "../src/pi/recon-job.ts";
import { createSharedBlackboard } from "../src/core/blackboard.ts";
import { loadGlobalConfig } from "../src/core/config.ts";
import { resolveForGate } from "../src/pi/dns.ts";
import { runProcess } from "../src/pi/process.ts";

const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
const [program, domain, jobId, scopeArg] = process.argv.slice(2);
if (!program || !domain) {
	console.error("uso: recon-job.ts <programa> <dominio> [jobId] [scopePath]");
	process.exit(2);
}

const workspace = join(root, "work", program);
const jobs = createJobStore({ workspace });
const config = await loadGlobalConfig((path) => readFile(path, "utf8"), join(root, ".bounty", "config.json")).catch(() => null);

const session = createSession(
	{
		root,
		program,
		redaction: config?.redaction ?? (process.env.GENTLE_BOUNTY_REDACTION === "on" ? "on" : "off"),
		budget: config?.budget,
		reportRedact: config?.reportRedact ?? true,
		reportLang: config?.reportLang ?? "en",
	},
	{
		dns: resolveForGate,
		readFile: (path) => readFile(path, "utf8"),
		runTool: (argv) => runProcess(argv, root, config?.toolPath ?? []),
		cwd: root,
	},
);

const scopePath = scopeArg ?? join(workspace, "scope.yaml");

const result = await runReconJob(
	{ program, domain, ...(jobId === undefined ? {} : { jobId }) },
	{
		jobs,
		loadScope: async () => {
			const loaded = await session.scope({ file: scopePath });
			return { ok: loaded.ok, text: loaded.text };
		},
		recon: async (subject) => {
			const recon = await session.reconPipeline({ domain: subject });
			return { ok: recon.ok, text: recon.text, artifacts: [join(workspace, "alive-hosts.json")] };
		},
	},
);

// S108: the board is the swarm's input, so the job publishes what it found before exiting.
try {
	const alive = JSON.parse(await readFile(join(workspace, "alive-hosts.json"), "utf8")) as { url: string; status: number; title?: string }[];
	const blackboard = createSharedBlackboard({ dir: workspace, program });
	for (const host of alive) {
		await blackboard.publish({
			category: "endpoint",
			target: host.url,
			data: { status: host.status, ...(host.title === undefined ? {} : { title: host.title }) },
			discoveredBy: `job:${result.job.id}`,
		});
	}
	console.log(`pizarra: ${alive.length} host(s) publicados por ${result.job.id}`);
} catch (error) {
	console.error(`pizarra: no publiqué los hosts (${(error as Error).message})`);
}

console.log(JSON.stringify({ job: result.job.id, state: result.job.state, summary: result.job.summary }));
process.exit(result.ok ? 0 : 1);
