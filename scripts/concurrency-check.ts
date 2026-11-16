/**
 * S89/task 3: concurrency, proven with evidence instead of assumed.
 *
 * Two worker processes run at the same time against the lab:
 *   1. different programs: their evidence chains must not interfere;
 *   2. the same program twice: the chain lock must serialize without losing writes, and the
 *      program's rate must hold across processes (two in-memory limiters would double it).
 *
 * Usage: node --experimental-strip-types scripts/concurrency-check.ts
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";

const root = process.cwd();
const port = Number((await readFile(join(root, ".lab", "port"), "utf8")).trim());
const worker = join(root, "scripts", "lib", "concurrency-worker.ts");
// Low rate and a small burst make the difference measurable: with one shared bucket, six executions
// at 2/s cannot finish in under ~2s; with one bucket per process, each burst is free and it finishes
// much faster.
const rate = 2;

async function scopeFor(program: string): Promise<string> {
	await mkdir(join(root, "work", program), { recursive: true });
	const path = join(root, "work", program, "scope.yaml");
	await writeFile(
		path,
		`program: ${program}\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:${port}\nlimits:\n  rate_rps: ${rate}\n`,
		"utf8",
	);
	return path;
}

function spawnWorker(program: string, scopePath: string, runs: number): Promise<{ program: string; ok: boolean; executed: number; failed: number; elapsedMs: number }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			["--experimental-strip-types", worker, root, program, scopePath, String(port), String(runs)],
			{ cwd: root, timeout: 120_000 },
			(error, stdout) => {
				try {
					const parsed = JSON.parse((stdout.trim().split("\n").pop() ?? "").trim()) as { program: string; ok: boolean; executed?: number; failed?: number; elapsedMs?: number };
					resolve({ program, ok: parsed.ok, executed: parsed.executed ?? 0, failed: parsed.failed ?? 0, elapsedMs: parsed.elapsedMs ?? 0 });
				} catch {
					resolve({ program, ok: false, executed: 0, failed: -1, elapsedMs: 0 });
				}
				void error;
			},
		);
	});
}

async function chainOf(program: string) {
	const store = createEvidenceStore(join(root, "work", program, "evidence"));
	const records = await store.read();
	const verified = await store.verify();
	const executions = records.filter((record) => record.kind === "execution").map((record) => String((record.payload as { at?: string }).at ?? ""));
	return { count: records.length, ok: verified.ok, executions: executions.length, times: executions };
}

function windowMs(times: string[]): number {
	const stamps = times.map((value) => Date.parse(value)).filter((value) => !Number.isNaN(value)).sort((a, b) => a - b);
	if (stamps.length < 2) return 0;
	return (stamps.at(-1) as number) - (stamps[0] as number);
}

function maxPerSecond(times: string[]): number {
	const stamps = times.map((value) => Date.parse(value)).filter((value) => !Number.isNaN(value)).sort((a, b) => a - b);
	let best = 0;
	for (let start = 0; start < stamps.length; start += 1) {
		let end = start;
		while (end < stamps.length && (stamps[end] as number) - (stamps[start] as number) < 1000) end += 1;
		best = Math.max(best, end - start);
	}
	return best;
}

const report: Record<string, unknown> = { rate, results: {} as Record<string, unknown> };

// 1. Different programs, at the same time.
for (const program of ["conc-a", "conc-b"]) await rm(join(root, "work", program), { recursive: true, force: true });
const [scopeA, scopeB] = await Promise.all([scopeFor("conc-a"), scopeFor("conc-b")]);
const parallel = await Promise.all([spawnWorker("conc-a", scopeA, 6), spawnWorker("conc-b", scopeB, 6)]);
const chains = { a: await chainOf("conc-a"), b: await chainOf("conc-b") };
(report.results as Record<string, unknown>).differentPrograms = { workers: parallel, chains };

// 2. The same program, twice, at the same time.
await rm(join(root, "work", "conc-shared"), { recursive: true, force: true });
const scopeShared = await scopeFor("conc-shared");
const same = await Promise.all([spawnWorker("conc-shared", scopeShared, 3), spawnWorker("conc-shared", scopeShared, 3)]);
const sharedChain = await chainOf("conc-shared");
(report.results as Record<string, unknown>).sameProgram = {
	workers: same,
	chain: { count: sharedChain.count, ok: sharedChain.ok, executions: sharedChain.executions },
	windowMs: windowMs(sharedChain.times),
	// Six executions at 2/s with a burst of 2 need at least (6-2)/2 = 2s of wall time.
	minimumExpectedMs: Math.round(((6 - 2) / rate) * 1000),
	rateHeld: windowMs(sharedChain.times) >= 1800,
};

console.log(JSON.stringify(report, null, 2));
