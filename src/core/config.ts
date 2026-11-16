/**
 * Global configuration (S33). Deliberately NOT part of the program scope: `fetch_allow` is an
 * operator-level list, edited by the human, for the tools that need to download something (nuclei
 * templates from GitHub, for example). Putting it in the scope would let a program's YAML widen what
 * the agent may fetch, which is the wrong direction.
 *
 * Stored as JSON in `.bounty/config.json` (gitignored) so the same file holds test credentials.
 */
import { DEFAULT_FETCH_ALLOW } from "./fetch-allow.ts";

export interface BudgetConfig {
	/** Milliseconds; the operator writes hours in the config file (S89). */
	maxWallMs?: number;
	maxToolCalls?: number;
	maxTokens?: number;
}

export interface GlobalConfig {
	/** Directories prepended to the child PATH by bounty_run. Operator-only, never model-driven (B1). */
	toolPath: string[];
	/** Hosts the agent may fetch from even when they are outside the program's scope. */
	fetchAllow: string[];
	/** Approved MCP server names for the main session launcher. Empty means `--no-mcp`. */
	mcp: string[];
	redaction: "off" | "on";
	budget: BudgetConfig;
	/** S75/task 3d: redact secrets and third-party personal data in the written report. Default on. */
	reportRedact: boolean;
	/** S75/task 3f: language of the written report. Default "en"; the lab uses "es". */
	reportLang: "en" | "es";
}

export const DEFAULT_CONFIG: GlobalConfig = {
	toolPath: [],
	fetchAllow: [...DEFAULT_FETCH_ALLOW],
	mcp: [],
	redaction: "off",
	budget: {},
	reportRedact: true,
	reportLang: "en",
};

const KNOWN_KEYS = new Set(["fetch_allow", "tool_path", "mcp", "redaction", "budget", "accounts", "report_redact", "report_lang"]);
const KNOWN_BUDGET_KEYS = new Set(["max_wall_ms", "max_duration_hours", "max_tool_calls", "max_tokens"]);

export function parseGlobalConfig(text: string): { ok: true; config: GlobalConfig } | { ok: false; errors: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [`config is not valid JSON: ${(error as Error).message}`] };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, errors: ["config must be a JSON object"] };
	}
	const doc = raw as Record<string, unknown>;
	const errors: string[] = [];
	for (const key of Object.keys(doc)) {
		if (!KNOWN_KEYS.has(key)) errors.push(`unknown key ${JSON.stringify(key)} in config`);
	}

	let toolPath: string[] = [];
	if (doc.tool_path !== undefined) {
		if (!Array.isArray(doc.tool_path) || doc.tool_path.some((entry) => typeof entry !== "string")) {
			errors.push("tool_path must be an array of directory paths");
		} else {
			toolPath = doc.tool_path.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
		}
	}

	let fetchAllow = [...DEFAULT_FETCH_ALLOW];
	if (doc.fetch_allow !== undefined) {
		if (!Array.isArray(doc.fetch_allow) || doc.fetch_allow.some((entry) => typeof entry !== "string")) {
			errors.push("fetch_allow must be an array of host names");
		} else {
			fetchAllow = doc.fetch_allow.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry.length > 0);
		}
	}

	let mcp: string[] = [];
	if (doc.mcp !== undefined) {
		if (!Array.isArray(doc.mcp) || doc.mcp.some((entry) => typeof entry !== "string")) {
			errors.push("mcp must be an array of MCP server names");
		} else {
			mcp = doc.mcp.map((entry) => String(entry));
		}
	}

	let redaction: "off" | "on" = "off";
	if (doc.redaction !== undefined) {
		if (doc.redaction !== "off" && doc.redaction !== "on") errors.push(`redaction must be "off" or "on"`);
		else redaction = doc.redaction;
	}

	let reportRedact = true;
	if (doc.report_redact !== undefined) {
		if (typeof doc.report_redact !== "boolean") errors.push("report_redact must be true or false");
		else reportRedact = doc.report_redact;
	}

	let reportLang: "en" | "es" = "en";
	if (doc.report_lang !== undefined) {
		if (doc.report_lang !== "en" && doc.report_lang !== "es") errors.push(`report_lang must be "en" or "es"`);
		else reportLang = doc.report_lang;
	}

	const budget: BudgetConfig = {};
	if (doc.budget !== undefined) {
		if (typeof doc.budget !== "object" || doc.budget === null || Array.isArray(doc.budget)) {
			errors.push("budget must be an object");
		} else {
			const node = doc.budget as Record<string, unknown>;
			for (const key of Object.keys(node)) {
				if (!KNOWN_BUDGET_KEYS.has(key)) errors.push(`unknown key ${JSON.stringify(key)} in budget`);
			}
			const positive = (key: string, value: unknown): number | undefined => {
				if (value === undefined) return undefined;
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
					errors.push(`budget.${key} must be a positive number`);
					return undefined;
				}
				return value;
			};
			budget.maxWallMs = positive("max_wall_ms", node.max_wall_ms);
			const hours = positive("max_duration_hours", node.max_duration_hours);
			if (hours !== undefined) budget.maxWallMs = hours * 60 * 60 * 1000;
			budget.maxToolCalls = positive("max_tool_calls", node.max_tool_calls);
			budget.maxTokens = positive("max_tokens", node.max_tokens);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, config: { toolPath, fetchAllow, mcp, redaction, budget, reportRedact, reportLang } };
}

/** Loads `.bounty/config.json`. A missing file means the defaults, not an error. */
export async function loadGlobalConfig(readFile: (path: string) => Promise<string>, path: string): Promise<GlobalConfig> {
	let text: string;
	try {
		text = await readFile(path);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return { ...DEFAULT_CONFIG, fetchAllow: [...DEFAULT_FETCH_ALLOW] };
		throw error;
	}
	const parsed = parseGlobalConfig(text);
	if (!parsed.ok) throw new Error(`invalid "${path}": ${parsed.errors.join("; ")}`);
	return parsed.config;
}
