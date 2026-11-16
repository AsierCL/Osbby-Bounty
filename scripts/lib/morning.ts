/**
 * S89/S90: one screen for every program, read-only and offline.
 *
 * Per program: phase, findings by state, whether it is stuck, whether a budget is exhausted, how many
 * destructive actions are queued, and what waits for a human decision.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

interface ProgramView {
	program: string;
	phase: string;
	findings: Record<string, number>;
	stuck: string | null;
	budget: string | null;
	pendingDestructive: number;
	waitingHuman: string[];
	lastVerification: string | null;
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export async function morningReport(root: string): Promise<{ programs: ProgramView[]; text: string }> {
	const entries = await readdir(join(root, "work"), { withFileTypes: true }).catch(() => []);
	const programs: ProgramView[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, "work", entry.name);
		const state = await readJson<{ phase?: string; stuck?: { key: string; count: number } | null; notes?: string[]; lastVerification?: { finding: string; event: string; detail: string } | null }>(join(dir, "state.json"));
		if (state === null) continue;
		const findingFiles = await readdir(join(dir, "findings")).catch(() => [] as string[]);
		const findings: Record<string, number> = {};
		for (const file of findingFiles) {
			if (!file.endsWith(".json")) continue;
			const finding = await readJson<{ state?: string }>(join(dir, "findings", file));
			const key = finding?.state ?? "unknown";
			findings[key] = (findings[key] ?? 0) + 1;
		}
		const queueLines = (await readFile(join(dir, "pending-destructive.jsonl"), "utf8").catch(() => ""))
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as { resolution?: unknown };
				} catch {
					return { resolution: {} };
				}
			})
			.filter((item) => item.resolution === undefined);
		const notes = state.notes ?? [];
		const budgetHit = notes.filter((note) => /presupuesto agotado|tope por host|frenado por ritmo/.test(note)).slice(-1)[0] ?? null;
		const waiting: string[] = [];
		if (notes.some((note) => /sin confirmación humana/.test(note))) waiting.push("alcance sin confirmar");
		if ((findings.disputed ?? 0) > 0) waiting.push("hallazgos en disputed");
		if (queueLines.length > 0) waiting.push(`${queueLines.length} acción(es) destructiva(s) en cola`);
		programs.push({
			program: entry.name,
			phase: state.phase ?? "?",
			findings,
			stuck: state.stuck === null || state.stuck === undefined ? null : `${state.stuck.count}× ${state.stuck.key}`,
			budget: budgetHit,
			pendingDestructive: queueLines.length,
			waitingHuman: waiting,
			lastVerification: state.lastVerification === undefined || state.lastVerification === null ? null : `${state.lastVerification.finding}: ${state.lastVerification.event}`,
		});
	}
	programs.sort((a, b) => a.program.localeCompare(b.program));
	const lines = ["Programa · fase · hallazgos · atascado · presupuesto · cola destructiva · espera humana"];
	for (const view of programs) {
		const counts = Object.entries(view.findings).map(([state, count]) => `${state}:${count}`).join(" ") || "—";
		lines.push(
			[
				view.program,
				view.phase,
				counts,
				view.stuck ?? "—",
				view.budget === null ? "—" : view.budget.slice(0, 40),
				String(view.pendingDestructive),
				view.waitingHuman.length === 0 ? "nada" : view.waitingHuman.join("; "),
			].join(" · "),
		);
	}
	return { programs, text: lines.join("\n") };
}
