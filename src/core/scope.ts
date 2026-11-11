/**
 * Scope parsing and matching.
 *
 * Two rules govern this module:
 *
 * 1. **Parsing fails closed.** Unknown keys, tabs, duplicate keys and unpredictable shapes are
 *    errors. A typo must never turn `limits:` into "no limits".
 * 2. **Matching fails closed.** `unknown` is the answer whenever nothing proves membership, and
 *    out-of-scope always wins over in-scope.
 *
 * Matching semantics (documented because they are a product decision, not an implementation detail):
 *   - `acme.com`        → that exact host only. It does not cover subdomains.
 *   - `*.acme.com`      → one or more labels below `acme.com`. It does not cover the apex.
 *   - `*` or `*.*.com`  → rejected at parse time.
 *   - `host:8443`       → the port must match exactly.
 *   - `host/static/*`   → the path must start with `/static/`.
 *   - an IP rule matches IPs only; a name rule never matches an IP.
 */
import { canonicalHost, parseTarget, type Target } from "./target.ts";

export interface ScopeRule {
	raw: string;
	host: string;
	wildcard: boolean;
	isIp: boolean;
	pathPrefix: string | null;
	pathWildcard: boolean;
	port: number | null;
}

export interface ScopeLimits {
	rateRps: number | null;
	maxRequestsPerDay: number | null;
	forbidden: string[];
	allowedMethods: string[];
	redirects: "reject" | "revalidate";
}

export interface AutomationPolicy {
	aiAssistedReports: "allowed" | "forbidden" | "unknown";
	automatedScanning: "allowed" | "forbidden" | "unknown";
}

export interface ScopePolicy {
	program: string;
	platform: string | null;
	authorizedOn: string | null;
	inScope: ScopeRule[];
	outOfScope: ScopeRule[];
	limits: ScopeLimits;
	requiredHeaders: Record<string, string>;
	automation: AutomationPolicy;
	notes: string | null;
}

export type ScopeParseResult =
	| { ok: true; policy: ScopePolicy; warnings: string[] }
	| { ok: false; errors: string[] };

export type ScopeVerdict =
	| { verdict: "in"; rule: string }
	| { verdict: "out"; rule: string }
	| { verdict: "unknown"; reason: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const TOP_LEVEL_KEYS = new Set([
	"program",
	"platform",
	"authorized_on",
	"in_scope",
	"out_of_scope",
	"limits",
	"required_headers",
	"automation",
	"notes",
]);
const LIMIT_KEYS = new Set([
	"rate_rps",
	"max_requests_per_day",
	"forbidden",
	"allowed_methods",
	"redirects",
]);
const AUTOMATION_KEYS = new Set(["ai_assisted_reports", "automated_scanning"]);
const TRI_STATE = new Set(["allowed", "forbidden", "unknown"]);

interface Line {
	no: number;
	indent: number;
	text: string;
}

type Node = string | Node[] | { [key: string]: Node };

function tokenize(text: string, errors: string[]): Line[] {
	const out: Line[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index] ?? "";
		if (/^\s*$/.test(raw)) continue;
		if (/^[ ]*#/.test(raw)) continue;
		if (/^\s*\t/.test(raw)) {
			errors.push(`line ${index + 1}: tab indentation is not allowed`);
			continue;
		}
		const indent = (raw.match(/^[ ]*/) ?? [""])[0].length;
		out.push({ no: index + 1, indent, text: raw.slice(indent).replace(/\s+$/, "") });
	}
	return out;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseBlock(
	lines: Line[],
	start: number,
	indent: number,
	errors: string[],
): { value: Node; next: number } | null {
	const first = lines[start];
	if (!first) return null;

	if (first.text.startsWith("- ")) {
		const items: Node[] = [];
		let index = start;
		while (index < lines.length) {
			const line = lines[index];
			if (!line || line.indent < indent) break;
			if (line.indent > indent) {
				errors.push(`line ${line.no}: unexpected indentation inside a list`);
				index += 1;
				continue;
			}
			if (!line.text.startsWith("- ")) break;
			const item = line.text.slice(2).trim();
			// A map entry inside a list looks like `key: value` or `key:`. A scope rule such as
			// `api.acme.com:8443` also contains a colon, so the colon must be followed by space or
			// end-of-line to count as a map entry.
			if (/^[A-Za-z_][A-Za-z0-9_-]*:(\s|$)/.test(item)) {
				errors.push(`line ${line.no}: maps inside lists are not supported`);
			}
			items.push(unquote(item));
			index += 1;
		}
		return { value: items, next: index };
	}

	const map: { [key: string]: Node } = {};
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (!line || line.indent < indent) break;
		if (line.indent > indent) {
			errors.push(`line ${line.no}: unexpected indentation`);
			index += 1;
			continue;
		}
		if (line.text.startsWith("- ")) {
			errors.push(`line ${line.no}: unexpected list item`);
			index += 1;
			continue;
		}
		const colon = line.text.indexOf(":");
		if (colon < 0) {
			errors.push(`line ${line.no}: expected "key: value"`);
			index += 1;
			continue;
		}
		const key = line.text.slice(0, colon).trim();
		const rest = line.text.slice(colon + 1).trim();
		if (Object.hasOwn(map, key)) {
			errors.push(`line ${line.no}: duplicate key ${JSON.stringify(key)}`);
			index += 1;
			continue;
		}
		index += 1;

		if (rest === "") {
			const child = lines[index];
			if (child && child.indent > indent) {
				const parsed = parseBlock(lines, index, child.indent, errors);
				if (parsed) {
					map[key] = parsed.value;
					index = parsed.next;
				}
			} else {
				map[key] = "";
			}
			continue;
		}
		if (rest === "|") {
			const body: string[] = [];
			let childIndent: number | null = null;
			while (index < lines.length) {
				const bodyLine = lines[index];
				if (!bodyLine || bodyLine.indent <= indent) break;
				childIndent ??= bodyLine.indent;
				body.push(bodyLine.text);
				index += 1;
			}
			map[key] = body.join("\n");
			continue;
		}
		if (rest === "[]") {
			map[key] = [];
			continue;
		}
		map[key] = unquote(rest);
	}
	return { value: map, next: index };
}

function parseRule(raw: string): { ok: true; rule: ScopeRule } | { ok: false; error: string } {
	const text = raw.trim().replace(SCHEME_RE, "");
	if (text.length === 0) return { ok: false, error: `invalid rule ${JSON.stringify(raw)}: empty` };

	// Split the path before validating wildcards: `*.acme.com/static/*` has one wildcard in the
	// host position and one trailing wildcard in the path, which is legal.
	let hostPart = text;
	let pathPrefix: string | null = null;
	const slash = text.indexOf("/");
	if (slash >= 0) {
		hostPart = text.slice(0, slash);
		pathPrefix = text.slice(slash);
	}

	if (hostPart === "*" || hostPart === "*." || hostPart === ".*") {
		return { ok: false, error: `bare wildcard rule ${JSON.stringify(raw)} is not allowed` };
	}
	const hostStars = (hostPart.match(/\*/g) ?? []).length;
	if (hostStars > 1) return { ok: false, error: `wildcard rule ${JSON.stringify(raw)} has more than one "*"` };

	if (pathPrefix !== null) {
		const pathStars = (pathPrefix.match(/\*/g) ?? []).length;
		if (pathStars > 1) return { ok: false, error: `wildcard rule ${JSON.stringify(raw)} has more than one "*"` };
		if (pathStars === 1 && !pathPrefix.endsWith("*")) {
			return { ok: false, error: `invalid rule ${JSON.stringify(raw)}: a path wildcard must be trailing` };
		}
	}

	let port: number | null = null;
	if (!hostPart.startsWith("[")) {
		const colon = hostPart.lastIndexOf(":");
		if (colon >= 0) {
			const portText = hostPart.slice(colon + 1);
			if (!/^\d{1,5}$/.test(portText)) {
				return { ok: false, error: `invalid rule ${JSON.stringify(raw)}: ${JSON.stringify(portText)} is not a port` };
			}
			port = Number(portText);
			hostPart = hostPart.slice(0, colon);
		}
	}

	const wildcard = hostPart.startsWith("*.");
	const hostText = wildcard ? hostPart.slice(2) : hostPart;
	if (hostText.includes("*")) {
		return { ok: false, error: `wildcard rule ${JSON.stringify(raw)} is not supported in that position` };
	}
	const parsed = parseTarget(hostText);
	if (!parsed.ok) return { ok: false, error: `invalid rule ${JSON.stringify(raw)}: ${parsed.error}` };

	let pathWildcard = false;
	if (pathPrefix !== null) {
		pathWildcard = pathPrefix.endsWith("*");
		if (pathWildcard) pathPrefix = pathPrefix.slice(0, -1);
		if (!pathPrefix.startsWith("/")) pathPrefix = `/${pathPrefix}`;
	}

	return {
		ok: true,
		rule: {
			raw,
			host: parsed.target.host,
			wildcard,
			isIp: parsed.target.isIp,
			pathPrefix,
			pathWildcard,
			port,
		},
	};
}

function asString(node: Node | undefined, key: string, errors: string[]): string | null {
	if (node === undefined) return null;
	if (typeof node !== "string") {
		errors.push(`${key} must be a single value`);
		return null;
	}
	return node;
}

function asList(node: Node | undefined, key: string, errors: string[]): string[] | null {
	if (node === undefined) return null;
	if (!Array.isArray(node)) {
		errors.push(`${key}: expected a list, got ${typeof node === "string" ? JSON.stringify(node) : "a map"}`);
		return null;
	}
	return node.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
}

function asNumber(node: Node | undefined, key: string, errors: string[]): number | null {
	const text = asString(node, key, errors);
	if (text === null) return null;
	if (!/^\d+$/.test(text)) {
		errors.push(`${key} must be a non-negative integer, got ${JSON.stringify(text)}`);
		return null;
	}
	return Number(text);
}

function asMap(node: Node | undefined, key: string, errors: string[]): Record<string, string> | null {
	if (node === undefined) return null;
	if (typeof node === "string" || Array.isArray(node)) {
		errors.push(`${key} must be a map of name: value`);
		return null;
	}
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(node)) {
		if (typeof value !== "string") {
			errors.push(`${key}.${name} must be a single value`);
			continue;
		}
		out[name] = value;
	}
	return out;
}

function rejectUnknownKeys(node: { [key: string]: Node }, allowed: Set<string>, section: string, errors: string[]): void {
	for (const key of Object.keys(node)) {
		if (!allowed.has(key)) errors.push(`unknown key ${JSON.stringify(key)}${section === "" ? "" : ` in ${section}`}`);
	}
}

export function parseScope(text: string): ScopeParseResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const lines = tokenize(text, errors);
	if (lines.length === 0) return { ok: false, errors: [...errors, "empty scope document"] };

	const root = parseBlock(lines, 0, lines[0]?.indent ?? 0, errors);
	if (!root || typeof root.value === "string" || Array.isArray(root.value)) {
		const detail = Array.isArray(root?.value) ? "unexpected list item: " : "";
		return { ok: false, errors: [...errors, `${detail}scope must be a map of keys`] };
	}
	const doc = root.value;
	rejectUnknownKeys(doc, TOP_LEVEL_KEYS, "", errors);

	const program = asString(doc.program, "program", errors);
	if (program === null || program.length === 0) errors.push("program is required");

	const parseRules = (key: string): ScopeRule[] => {
		const list = asList(doc[key], key, errors);
		if (list === null) return [];
		const rules: ScopeRule[] = [];
		for (const raw of list) {
			const parsed = parseRule(raw);
			if (parsed.ok) rules.push(parsed.rule);
			else errors.push(parsed.error);
		}
		return rules;
	};
	const inScope = parseRules("in_scope");
	const outOfScope = parseRules("out_of_scope");

	const limitsNode = doc.limits;
	let limits: ScopeLimits = {
		rateRps: null,
		maxRequestsPerDay: null,
		forbidden: [],
		allowedMethods: [],
		redirects: "reject",
	};
	if (limitsNode !== undefined) {
		if (typeof limitsNode === "string" || Array.isArray(limitsNode)) {
			errors.push("limits must be a map");
		} else {
			rejectUnknownKeys(limitsNode, LIMIT_KEYS, "limits", errors);
			const redirects = asString(limitsNode.redirects, "limits.redirects", errors);
			if (redirects !== null && redirects !== "reject" && redirects !== "revalidate") {
				errors.push(`limits.redirects must be "reject" or "revalidate", got ${JSON.stringify(redirects)}`);
			}
			limits = {
				rateRps: asNumber(limitsNode.rate_rps, "limits.rate_rps", errors),
				maxRequestsPerDay: asNumber(limitsNode.max_requests_per_day, "limits.max_requests_per_day", errors),
				forbidden: asList(limitsNode.forbidden, "limits.forbidden", errors) ?? [],
				allowedMethods: (asList(limitsNode.allowed_methods, "limits.allowed_methods", errors) ?? []).map((method) =>
					method.toUpperCase(),
				),
				redirects: redirects === "revalidate" ? "revalidate" : "reject",
			};
		}
	}

	let automation: AutomationPolicy = { aiAssistedReports: "unknown", automatedScanning: "unknown" };
	const automationNode = doc.automation;
	if (automationNode !== undefined) {
		if (typeof automationNode === "string" || Array.isArray(automationNode)) {
			errors.push("automation must be a map");
		} else {
			rejectUnknownKeys(automationNode, AUTOMATION_KEYS, "automation", errors);
			const read = (key: string, field: string): "allowed" | "forbidden" | "unknown" => {
				const value = asString(automationNode[field], `automation.${field}`, errors);
				if (value === null) return "unknown";
				if (!TRI_STATE.has(value)) {
					errors.push(`automation.${field} must be allowed, forbidden or unknown, got ${JSON.stringify(value)}`);
					return "unknown";
				}
				return value as "allowed" | "forbidden" | "unknown";
			};
			automation = {
				aiAssistedReports: read("ai_assisted_reports", "ai_assisted_reports"),
				automatedScanning: read("automated_scanning", "automated_scanning"),
			};
		}
	}

	const requiredHeaders = asMap(doc.required_headers, "required_headers", errors) ?? {};
	const authorizedOn = asString(doc.authorized_on, "authorized_on", errors);
	const platform = asString(doc.platform, "platform", errors);
	const notes = doc.notes === undefined ? null : typeof doc.notes === "string" ? doc.notes : null;

	if (errors.length > 0) return { ok: false, errors };

	if (authorizedOn === null) warnings.push("authorized_on missing: the scope records no authorization date");
	if (inScope.length === 0) warnings.push("in_scope is empty: every target will be unknown");
	if (limits.rateRps === null) warnings.push("limits.rate_rps missing: no tool may run without an explicit rate");

	return {
		ok: true,
		warnings,
		policy: {
			program: program ?? "",
			platform,
			authorizedOn,
			inScope,
			outOfScope,
			limits,
			requiredHeaders,
			automation,
			notes,
		},
	};
}

function ruleMatches(rule: ScopeRule, host: string, isIp: boolean, path: string, port: number | null): boolean {
	if (rule.isIp !== isIp) return false;
	if (rule.wildcard) {
		if (host === rule.host) return false;
		if (!host.endsWith(`.${rule.host}`)) return false;
	} else if (host !== rule.host) {
		return false;
	}
	if (rule.port !== null && port !== rule.port) return false;
	if (rule.pathPrefix !== null) {
		if (rule.pathWildcard ? !path.startsWith(rule.pathPrefix) : path !== rule.pathPrefix) return false;
	}
	return true;
}

export function evaluate(
	policy: ScopePolicy,
	target: Pick<Target, "host" | "path" | "port"> | { host: string },
): ScopeVerdict {
	const rawHost = typeof target?.host === "string" ? target.host : "";
	const host = canonicalHost(rawHost);
	if (host === null) {
		return { verdict: "unknown", reason: `host is not canonicalizable: ${JSON.stringify(rawHost)}` };
	}
	const parsed = parseTarget(rawHost);
	const isIp = parsed.ok ? parsed.target.isIp : false;
	const path = typeof target.path === "string" && target.path.length > 0 ? target.path : "/";
	const port = typeof target.port === "number" ? target.port : null;

	for (const rule of policy.outOfScope) {
		if (ruleMatches(rule, host, isIp, path, port)) return { verdict: "out", rule: rule.raw };
	}
	for (const rule of policy.inScope) {
		if (ruleMatches(rule, host, isIp, path, port)) return { verdict: "in", rule: rule.raw };
	}
	return {
		verdict: "unknown",
		reason: `no in_scope rule matched ${host}${port === null ? "" : `:${port}`}${path}`,
	};
}
