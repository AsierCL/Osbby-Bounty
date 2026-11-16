/**
 * S100: one screen for every program, read-only and offline.
 *
 * It walks work/, reads state.json, findings/*.json, status.md and the destructive queue, and prints a
 * compact table designed to be read in five seconds with five terminals open. It never launches a
 * process, never touches the network and never writes.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

interface ProgramView {
	program: string;
	phase: string;
	findings: Record<string, number>;
	status: "activa" | "espera humana" | "atascada" | "presupuesto agotado";
	stuck: string | null;
	budget: string | null;
	pendingDestructive: number;
	waiting: string;
	nextStep: string;
	lastVerification: string | null;
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Reads the "waiting for you" block out of status.md, without interpreting the whole file. */
function waitingSection(statusText: string): string {
	const start = statusText.search(/^## (Esperando tu confirmación|Parado: esperando una decisión tuya)/m);
	if (start < 0) return "";
	const rest = statusText.slice(start);
	const end = rest.slice(4).search(/^## /m);
	const block = end < 0 ? rest : rest.slice(0, end + 4);
	return block
		.split("\n")
		.slice(1)
		.map((line) => line.replace(/^[-*]\s*/, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("## "))
		.join(" · ");
}

function truncate(value: string, width: number): string {
	return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

export async function morningReport(root: string): Promise<{ programs: ProgramView[]; text: string }> {
	const entries = await readdir(join(root, "work"), { withFileTypes: true }).catch(() => []);
	const programs: ProgramView[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, "work", entry.name);
		const state = await readJson<{
			phase?: string;
			nextStep?: string;
			stuck?: { key: string; count: number } | null;
			notes?: string[];
			pending?: { kind: string } | null;
			lastVerification?: { finding: string; event: string } | null;
		}>(join(dir, "state.json"));
		if (state === null) continue;

		const findings: Record<string, number> = {};
		for (const file of await readdir(join(dir, "findings")).catch(() => [] as string[])) {
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

		const statusText = await readFile(join(dir, "status.md"), "utf8").catch(() => "");
		const notes = state.notes ?? [];
		const budget = notes.filter((note) => /presupuesto agotado|tope por host|frenado por ritmo/.test(note)).slice(-1)[0] ?? null;
		const stuck = state.stuck === null || state.stuck === undefined ? null : `${state.stuck.count}× ${state.stuck.key}`;

		const waitingParts: string[] = [];
		if (state.pending !== null && state.pending !== undefined) waitingParts.push(`pendiente: ${state.pending.kind}`);
		if ((findings.disputed ?? 0) > 0) waitingParts.push("disputas");
		if (queueLines.length > 0) waitingParts.push(`${queueLines.length} destructiva(s) en cola`);
		const waitingText = waitingSection(statusText);

		const status: ProgramView["status"] =
			stuck !== null ? "atascada" : budget !== null ? "presupuesto agotado" : waitingParts.length > 0 ? "espera humana" : "activa";

		programs.push({
			program: entry.name,
			phase: state.phase ?? "?",
			findings,
			status,
			stuck,
			budget,
			pendingDestructive: queueLines.length,
			waiting: waitingText.length > 0 ? waitingText : waitingParts.join(", "),
			nextStep: state.nextStep ?? "",
			lastVerification: state.lastVerification === undefined || state.lastVerification === null ? null : `${state.lastVerification.finding}: ${state.lastVerification.event}`,
		});
	}

	programs.sort((a, b) => a.program.localeCompare(b.program));
	const rows = programs.map((view) => {
		const counts = (["candidate", "verified", "disputed", "rejected", "dismissed"] as const)
			.filter((state) => (view.findings[state] ?? 0) > 0)
			.map((state) => `${state.slice(0, 3)} ${view.findings[state]}`)
			.join(" · ");
		return {
			program: view.program,
			phase: view.phase,
			findings: counts.length === 0 ? "—" : counts,
			status: view.status,
			needs: view.waiting.length > 0 ? view.waiting : view.nextStep,
		};
	});

	const widths = {
		program: Math.max(7, ...rows.map((row) => row.program.length)),
		phase: Math.max(5, ...rows.map((row) => row.phase.length)),
		findings: Math.max(8, ...rows.map((row) => row.findings.length)),
		status: Math.max(6, ...rows.map((row) => row.status.length)),
	};
	const header = ["PROGRAMA", "FASE", "HALLAZGOS", "ESTADO", "NECESITA DE VOS"];
	const lines = [header.map((label, index) => label.padEnd(Object.values(widths)[index] ?? label.length)).join("  ")];
	const rule = Object.values(widths).map((width) => "─".repeat(width)).join("──");
	lines.push(rule);
	for (const row of rows) {
		lines.push(
			[
				row.program.padEnd(widths.program),
				row.phase.padEnd(widths.phase),
				row.findings.padEnd(widths.findings),
				row.status.padEnd(widths.status),
				truncate(row.needs, 70),
			].join("  "),
		);
	}
	if (rows.length === 0) lines.push("(no hay programas en work/)");

	const waitingCount = programs.filter((view) => view.status !== "activa").length;
	lines.push("");
	lines.push(
		`${programs.length} programa(s) · ${waitingCount} con algo para vos · ${programs.reduce((total, view) => total + view.pendingDestructive, 0)} acción(es) destructiva(s) en cola`,
	);
	return { programs, text: lines.join("\n") };
}
