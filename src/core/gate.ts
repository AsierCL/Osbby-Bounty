/**
 * The gate: the single decision point between "the agent wants to run something" and "the tool
 * touches the network" (S10, S9).
 *
 * It validates every host that would be contacted — the target, every host inside argv (URLs, list
 * files, `Host:` headers, OOB callback URLs) — and the DNS chain behind each one. Anything it cannot
 * decide is a refusal. There is no "warn and continue" path.
 *
 * Injection: `deps` carries the DNS resolver and the file reader. A request may also carry its own
 * `dns` resolver (a runner passes the snapshot it used); `deps.readFile` is always authoritative so a
 * caller cannot fake a list file's contents.
 */
import { DEFAULT_FETCH_ALLOW, isFetchAllowed } from "./fetch-allow.ts";
import { evaluate, type ScopePolicy } from "./scope.ts";
import { parseLooseHost, parseTarget, type Target } from "./target.ts";

export interface DnsAnswer {
	cname?: string[];
	addresses?: string[];
}

export type DnsResolver = (host: string) => Promise<DnsAnswer | { error: string }>;

export interface GateDeps {
	dns: DnsResolver;
	readFile: (path: string) => Promise<string>;
	/** S33: operator-level download allowlist. Defaults to DEFAULT_FETCH_ALLOW. */
	fetchAllow?: readonly string[];
}

export interface GateRequest {
	target: string;
	argv?: string[];
	method?: string;
	headers?: Record<string, string>;
	technique?: string;
	followRedirects?: boolean;
	dns?: DnsResolver;
}

export type ContactSource = "target" | "argv" | "list" | "header-host" | "cname" | "fetch";

export interface Contact {
	host: string;
	source: ContactSource;
	raw: string;
}

export type GateResult =
	| { allowed: true; contacts: Contact[]; notes: string[] }
	| { allowed: false; reason: string; detail?: string; contacts?: Contact[] };

/** Flags whose following value is a local path, never a host. */
const FILE_FLAGS = new Set([
	"-o",
	"--output",
	"-oJ",
	"-oj",
	"--json",
	"--jsonl",
	"--json-export",
	"-t",
	"--templates",
	"--template",
	"-w",
	"--wordlist",
	"--config",
	"--config-file",
	"-O",
	"--output-dir",
	"--report",
	"--report-file",
	"--csv",
	"--html",
	"--markdown",
	"-stats-json",
	// Wordlist flags: their value is a local file, and a name like `passwords.txt` parses as a host.
	"-P",
	"--passwords",
	"-p",
	"--pass",
	"-U",
	"--userlist",
	"--user-list",
	"-L",
	"--login-list",
	"--logins",
]);

const LIST_FLAGS = new Set(["-l", "--list", "--list-file", "--hosts", "--targets", "-targets", "--host-file"]);
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,)]+/gi;
const HEADER_HOST = /(?:^|[\s,;])(?:host|x-forwarded-host|x-forwarded-server|forwarded|origin|referer)\s*:\s*([^\s,;]+)/gi;
const BARE_HOST = /^[A-Za-z0-9._:*[\]-]+$/;
const MAX_DNS_DEPTH = 6;

interface ParsedContact {
	contact: Contact;
	target: Target;
}

function canonical(value: string): Target | null {
	return parseLooseHost(value);
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
	if (!headers) return null;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return null;
}

async function collectFromArgv(
	argv: string[],
	readFile: (path: string) => Promise<string>,
): Promise<{
	parsed: ParsedContact[];
	fetches: ParsedContact[];
	skipped: string[];
	problem?: { reason: string; detail?: string };
}> {
	const parsed: ParsedContact[] = [];
	const fetches: ParsedContact[] = [];

	// S24: every token that parses as a host, URL or IP is validated wherever it appears, with no
	// per-tool profile. A token that does not parse as a host is not a host: it is noted and does not
	// block the run.
	const skipped: string[] = [];
	const push = (raw: string, source: ContactSource): null => {
		const target = canonical(raw);
		if (!target) {
			skipped.push(raw);
			return null;
		}
		parsed.push({ contact: { host: target.host, source, raw }, target });
		return null;
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] as string;

		if (LIST_FLAGS.has(token) || [...LIST_FLAGS].some((flag) => token.startsWith(`${flag}=`))) {
			const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
			const path = inline ?? argv[index + 1];
			if (inline === undefined) index += 1;
			if (!path) return { parsed, fetches, skipped, problem: { reason: `list flag ${token} has no file` } };
			let text: string;
			try {
				text = await readFile(path);
			} catch (error) {
				return {
					parsed,
					fetches,
					skipped,
					problem: { reason: `cannot read list file ${path}`, detail: (error as Error).message },
				};
			}
			for (const line of text.split(/\r?\n/)) {
				const entry = line.trim();
				if (entry.length === 0 || entry.startsWith("#")) continue;
				push(entry, "list");
			}
			continue;
		}

		if (FILE_FLAGS.has(token) || FILE_FLAGS.has(token.split("=")[0] ?? "")) {
			// S33: a file flag usually holds a local path, which is not validated. But if the value is
			// a scheme-qualified URL the tool is going to *fetch* it, and that is network traffic.
			const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[index + 1];
			if (!token.includes("=")) index += 1;
			if (typeof inline === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(inline)) {
				const target = canonical(inline);
				if (target === null) {
					return { parsed, fetches, skipped, problem: { reason: `file flag value is not parseable: ${inline}` } };
				}
				fetches.push({ contact: { host: target.host, source: "fetch", raw: inline }, target });
			}
			continue;
		}

		if (token.startsWith("-") && !token.includes("=")) continue;

		const values = [token];
		const equals = token.indexOf("=");
		if (equals >= 0) values.push(token.slice(equals + 1));

		for (const value of values) {
			for (const match of value.matchAll(URL_IN_TEXT)) {
				push(match[0], "argv");
			}
			for (const match of value.matchAll(HEADER_HOST)) {
				const headerHost = match[1];
				if (!headerHost) continue;
				push(headerHost, "header-host");
			}
		}

		// A bare token that looks like a hostname must be in scope; refusing to guess is the point.
		const bare = equals >= 0 ? (token.slice(equals + 1) as string) : token;
		if (bare !== token || !token.startsWith("-")) {
			if (bare === "localhost" || (BARE_HOST.test(bare) && bare.includes(".") && !URL_IN_TEXT.test(bare))) {
				URL_IN_TEXT.lastIndex = 0;
				push(bare, "argv");
			}
			URL_IN_TEXT.lastIndex = 0;
		}
	}

	return { parsed, fetches, skipped };
}

export async function gate(policy: ScopePolicy, request: GateRequest, deps: GateDeps): Promise<GateResult> {
	const dns = request.dns ?? deps.dns;
	const readFile = deps.readFile ?? (async () => {
		throw new Error("no file reader injected");
	});
	const method = (request.method ?? "GET").toUpperCase();
	const notes: string[] = [];

	// 1. method allowlist
	if (policy.limits.allowedMethods.length > 0 && !policy.limits.allowedMethods.includes(method)) {
		return { allowed: false, reason: `method ${method} is not allowed by the program (allowed: ${policy.limits.allowedMethods.join(", ")})` };
	}

	// 2. forbidden technique
	if (request.technique && policy.limits.forbidden.includes(request.technique)) {
		return { allowed: false, reason: `forbidden technique ${request.technique} is listed by the program` };
	}

	// 3. redirect policy
	if (request.followRedirects) {
		if (policy.limits.redirects === "reject") {
			return { allowed: false, reason: "redirects must not be followed: the program policy is reject" };
		}
		notes.push("each redirect hop must be re-gated before following it");
	}

	// 4. required program headers
	for (const name of Object.keys(policy.requiredHeaders)) {
		if (headerValue(request.headers, name) === null) {
			return { allowed: false, reason: `required header ${name} is missing` };
		}
	}

	// 5. an explicit rate is mandatory: without it the runner has no budget to respect
	if (policy.limits.rateRps === null) {
		return { allowed: false, reason: "the scope declares no rate limit: refusing to run any tool without an explicit rate" };
	}

	// 6. the target itself
	const target = canonical(request.target);
	if (!target) {
		const parsed = parseTarget(request.target);
		return { allowed: false, reason: "target is not parseable", detail: parsed.ok ? undefined : parsed.error };
	}

	const contacts: ParsedContact[] = [{ contact: { host: target.host, source: "target", raw: request.target }, target }];

	const hostHeader = headerValue(request.headers, "host") ?? headerValue(request.headers, "x-forwarded-host");
	if (hostHeader) {
		const parsedHeader = canonical(hostHeader);
		if (!parsedHeader) {
			return { allowed: false, reason: "host header is not parseable", detail: hostHeader };
		}
		contacts.push({ contact: { host: parsedHeader.host, source: "header-host", raw: hostHeader }, target: parsedHeader });
	}

	const fromArgv = await collectFromArgv(request.argv ?? [], readFile);
	if (fromArgv.problem) {
		return { allowed: false, reason: fromArgv.problem.reason, detail: fromArgv.problem.detail, contacts: fromArgv.parsed.map((entry) => entry.contact) };
	}
	contacts.push(...fromArgv.parsed);
	if (fromArgv.skipped.length > 0) {
		notes.push(`argv tokens that are not hosts were ignored: ${fromArgv.skipped.slice(0, 5).join(", ")}`);
	}

	// 7. scope decision for every contacted host, deduplicated by canonical host
	const seen = new Set<string>();
	const unique: ParsedContact[] = [];
	for (const entry of contacts) {
		if (seen.has(entry.contact.host)) continue;
		seen.add(entry.contact.host);
		unique.push(entry);
	}

	for (const entry of unique) {
		const verdict = evaluate(policy, entry.target);
		if (verdict.verdict === "in") continue;
		if (verdict.verdict === "out") {
			return {
				allowed: false,
				reason: `out of scope: ${entry.contact.host}`,
				detail: `rule "${verdict.rule}" excludes it (reached via ${entry.contact.source} ${JSON.stringify(entry.contact.raw)})`,
				contacts: unique.map((item) => item.contact),
			};
		}
		return {
			allowed: false,
			reason: `no in_scope rule matched ${entry.contact.host}${entry.target.port === null ? "" : `:${entry.target.port}`}`,
			detail: `${verdict.reason} (reached via ${entry.contact.source} ${JSON.stringify(entry.contact.raw)})`,
			contacts: unique.map((item) => item.contact),
		};
	}

	// 7b. S33: downloads requested through a file flag. In scope is fine; otherwise fetch_allow may
	// cover it, which never widens the scope for actual targets.
	const fetchAllow = deps.fetchAllow ?? DEFAULT_FETCH_ALLOW;
	for (const entry of fromArgv.fetches) {
		const verdict = evaluate(policy, entry.target);
		if (verdict.verdict === "in") {
			notes.push(`download of ${entry.contact.host} is inside the scope`);
			continue;
		}
		if (isFetchAllowed(entry.contact.host, fetchAllow)) {
			notes.push(`download of ${entry.contact.host} allowed by fetch_allow (not a target in scope)`);
			continue;
		}
		return {
			allowed: false,
			reason: `file flag value is a URL outside the scope and outside fetch_allow: ${entry.contact.host}`,
			detail: `${entry.contact.raw} would be downloaded, and fetch_allow only allows ${fetchAllow.join(", ")}`,
			contacts: unique.map((item) => item.contact),
		};
	}

	// 8. DNS: every hop must resolve and stay in scope
	const queue = [...unique];
	const visited = new Set<string>(unique.map((entry) => entry.contact.host));
	let depth = 0;
	while (queue.length > 0 && depth < MAX_DNS_DEPTH) {
		const batch = queue.splice(0, queue.length);
		depth += 1;
		for (const entry of batch) {
			let answer: Awaited<ReturnType<DnsResolver>>;
			try {
				answer = await dns(entry.contact.host);
			} catch (error) {
				return { allowed: false, reason: `dns resolution failed for ${entry.contact.host}`, detail: (error as Error).message };
			}
			if ("error" in answer) {
				return { allowed: false, reason: `dns resolution failed for ${entry.contact.host}`, detail: answer.error };
			}
			for (const name of answer.cname ?? []) {
				const cnameTarget = canonical(name);
				if (!cnameTarget) {
					return { allowed: false, reason: `cname target is not parseable: ${name}` };
				}
				const verdict = evaluate(policy, cnameTarget);
				if (verdict.verdict !== "in") {
					return {
						allowed: false,
						reason: `cname target ${cnameTarget.host} is not in scope`,
						detail:
							verdict.verdict === "out"
								? `rule "${verdict.rule}" excludes the cname target`
								: `no in_scope rule matched the cname target ${cnameTarget.host}`,
					};
				}
				if (visited.has(cnameTarget.host)) continue;
				visited.add(cnameTarget.host);
				const cnameContact: ParsedContact = {
					contact: { host: cnameTarget.host, source: "cname", raw: name },
					target: cnameTarget,
				};
				unique.push(cnameContact);
				queue.push(cnameContact);
			}
		}
	}

	return { allowed: true, contacts: unique.map((entry) => entry.contact), notes };
}
