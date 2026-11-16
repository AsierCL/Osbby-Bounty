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

/** Tools that understand curl's `-K` config file. Others must pass -H themselves. */
const SEEDABLE_TOOLS = new Set(["curl"]);

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
}): Promise<SeedResult | null> {
	const binary = (options.tool.trim().split(/[\\/]/).pop() ?? "").toLowerCase();
	if (!SEEDABLE_TOOLS.has(binary)) return null;

	const source = join(options.workspace, "session.headers");
	let text: string;
	try {
		text = await readFile(source, "utf8");
	} catch {
		return null;
	}

	const headers: { name: string; value: string }[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) continue;
		headers.push({ name: trimmed.slice(0, separator).trim(), value: trimmed.slice(separator + 1).trim() });
	}
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
