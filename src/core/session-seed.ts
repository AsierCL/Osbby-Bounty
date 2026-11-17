/**
 * S97: the human logs in with a browser and hands the session to the tool.
 *
 * The file lives in `work/<program>/session.headers`, one `Name: value` per line. It is never put in
 * argv: for curl the headers travel in a private config file passed with `-K`, so the evidence chain
 * records only the path. That keeps cookies and bearer tokens out of the immutable log while letting
 * every HTTP call use the human's session.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseHeaderLines } from "./headers.ts";

/** Tools that understand curl's `-K` config file. Others must pass -H themselves. */
const SEEDABLE_TOOLS = new Set(["curl"]);

/** S106: a role can only be injected where the single session already can: curl's private config. */
export function canSeedHeaders(tool: string): boolean {
	const binary = (tool.trim().split(/[\\/]/).pop() ?? "").toLowerCase();
	return SEEDABLE_TOOLS.has(binary);
}

export interface SeedResult {
	/** Arguments to execute: the original ones plus `-K <private config>`. */
	args: string[];
	/** Header names injected, for the evidence record. Never their values. */
	headers: string[];
	/** Absolute path of the private config file (recorded in evidence, harmless). */
	configPath: string;
}

export async function seedSessionHeaders(options: {
	workspace: string;
	tool: string;
	args: string[];
	/** S106: an absolute path (a role file) instead of the single session file. */
	source?: string;
}): Promise<SeedResult | null> {
	const binary = (options.tool.trim().split(/[\\/]/).pop() ?? "").toLowerCase();
	if (!SEEDABLE_TOOLS.has(binary)) return null;

	const source = options.source ?? join(options.workspace, "session.headers");
	let text: string;
	try {
		text = await readFile(source, "utf8");
	} catch {
		return null;
	}

	const headers = parseHeaderLines(text);
	if (headers.length === 0) return null;

	const dir = join(options.workspace, ".session");
	await mkdir(dir, { recursive: true });
	const configPath = join(dir, "curl.conf");
	const body = [
		"# S97: session seeded from the human's browser. Private; never in the evidence chain.",
		...headers.map((header) => `header = "${header.name}: ${header.value.replace(/"/g, '\\"')}"`),
		"",
	].join("\n");
	await writeFile(configPath, body, { encoding: "utf8", mode: 0o600 });

	return { args: [...options.args, "-K", configPath], headers: headers.map((header) => header.name), configPath };
}
