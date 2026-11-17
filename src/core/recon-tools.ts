/**
 * S103: the recon CLIs write JSON/NDJSON, and the chain should keep the structure, not just the bytes.
 *
 * When a run declares `recon_tool`, the harness parses the tool's own output and appends a
 * `recon-intelligence` record with the hosts/endpoints it found. It is evidence, not an execution, and
 * it never changes the argv: the tools still run through the gate like any other binary.
 */
export type ReconTool = "subfinder" | "httpx" | "katana" | "nuclei" | "gobuster";

export const RECON_TOOLS: ReconTool[] = ["subfinder", "httpx", "katana", "nuclei", "gobuster"];

export interface ReconEntry {
	kind: "host" | "url" | "finding" | "line";
	value: string;
	status?: number;
	title?: string;
	technologies?: string[];
}

function parseJsonLine(line: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Best-effort, per tool, over stdout: JSON/NDJSON when the tool wrote it, plain lines otherwise. */
export function parseReconOutput(tool: string, stdout: string): ReconEntry[] {
	const entries: ReconEntry[] = [];
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (line.startsWith("{")) {
			const record = parseJsonLine(line);
			if (record === null) continue;
			const url = typeof record.url === "string" ? record.url : typeof record.input === "string" ? record.input : null;
			const host = typeof record.host === "string" ? record.host : typeof record.domain === "string" ? record.domain : null;
			if (url !== null) {
				entries.push({
					kind: "url",
					value: url,
					...(typeof record.status_code === "number" ? { status: record.status_code } : {}),
					...(typeof record.title === "string" ? { title: record.title } : {}),
					...(Array.isArray(record.tech) ? { technologies: record.tech.filter((item): item is string => typeof item === "string") } : {}),
				});
				continue;
			}
			if (host !== null) {
				entries.push({ kind: "host", value: host });
				continue;
			}
			const template = typeof record["template-id"] === "string" ? record["template-id"] : typeof record.info === "object" ? String((record.info as { name?: unknown }).name ?? "") : "";
			const matched = typeof record["matched-at"] === "string" ? record["matched-at"] : typeof record.host === "string" ? record.host : "";
			if (template.length > 0 || matched.length > 0) {
				entries.push({ kind: "finding", value: `${template} ${matched}`.trim() });
				continue;
			}
			continue;
		}
		// Plain lines: subfinder prints hosts, gobuster prints "path (Status: 200)".
		entries.push({ kind: tool === "gobuster" ? "line" : "host", value: line });
	}
	return entries;
}

/** A short, readable summary for status.md and the tool result. */
export function summarizeRecon(entries: ReconEntry[]): string {
	const counts = entries.reduce<Record<string, number>>((acc, entry) => {
		acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
		return acc;
	}, {});
	return Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(", ") || "sin resultados";
}
