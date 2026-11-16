/**
 * Destructive classification (S35). The model does not get to decide this: the gate infers it from
 * the binary name and the argv. A class the model *declares* only adds a reason to pause; it can
 * never remove one.
 *
 * Bias, stated by the operator: when in doubt, pause. A false positive costs one confirmation; a
 * false negative crosses red line #2.
 */

import { isInternalAddress } from "./ip-safety.ts";

export const DESTRUCTIVE_TECHNIQUES = new Set([
	"dos",
	"ddos",
	"brute-force",
	"bruteforce",
	"password-spray",
	"credential-stuffing",
	"credential-stuffing-spray",
	"fuzzing-flood",
	"flood",
]);

const BRUTE_FORCE_BINARIES = /(^|[\/\\])(hydra|medusa|ncrack|patator|crowbar|legba|john|hashcat|aircrack-ng)(\.exe)?$/i;
const FLOOD_FLAGS = /^(--?flood|--?dos|--?ddos)$/i;
const RATE_FLAGS = new Set(["-rate", "--rate", "--rate-limit", "-rl", "--rps", "-rps"]);
const CONCURRENCY_FLAGS = new Set(["-c", "--concurrency", "-t", "--threads", "-threads"]);
const WORDLIST_FLAGS = new Set(["-w", "--wordlist", "-P", "--passwords", "-p", "--pass"]);
const TAGS_FLAGS = new Set(["-tags", "--tags", "-t", "--template-tags"]);
const TARGET_FLAGS = new Set(["-u", "--url", "-target", "--target", "-host", "--host"]);
const PASSWORD_WORDLIST = /(pass|cred|pw|rockyou|spray|logins?)/i;
const LOGIN_PATH = /\/(login|signin|sign-in|auth|authenticate|session|token|oauth|admin\/login)/i;
const DANGEROUS_TAGS = /(^|,)\s*(dos|fuzz|fuzzing|intrusive|brute|bruteforce|spray)\s*(,|$)/i;

/**
 * S81/task 2: a GraphQL mutation is a state-changing request, so it pauses like hydra does. This is a
 * floor, not a replacement for judgment: a mutation whose name looks innocent (or a REST endpoint that
 * mutates without saying "mutation") still passes through the model's own reasoning, but every
 * `mutation` inside a GraphQL body pauses.
 *
 * Known limitation, stated in docs/gate.md: financial-effect names (buy, pay, transfer) are not
 * detected by name. Only the general shape counts.
 */
const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json"]);

/**
 * S91: reaching internal infrastructure or undocumented routes through something that forwards to a
 * backend (path traversal, actuator/health/env, debug endpoints). It is its own class, it ALWAYS pauses,
 * and it never inherits an authorization given earlier in the session: approving "test the mutations"
 * says nothing about probing a backend.
 */
const TRAVERSAL = /(?:\.\.\/|%2e%2e(?:%2f|\/)|%252e%252e|\.\.%5c|%5c\.\.)/i;
const INTERNAL_ROUTES = /(?:\/actuator(?:\/|$)|\/actuator\/(?:env|health|heapdump|threaddump|mappings|configprops)|\/env\b|\/heapdump|\/threaddump|\/management\/(?:health|env|info)|\/__admin|\/debug\b|\/server-status|\/internal\/|\/admin\/(?:env|config|status)|\/wp-json\/wp\/v2\/users|\/console\b|\/jolokia)/i;

export function infraProbing(args: string[], target: string): string | null {
	// The path can arrive in the target, in a URL argument, in a query value, or URL-encoded.
	const haystack = `${target} ${args.join(" ")}`;
	const traversal = TRAVERSAL.exec(haystack);
	if (traversal !== null) return `path traversal (${traversal[0]})`;
	const route = INTERNAL_ROUTES.exec(haystack);
	if (route !== null) return `undocumented internal route (${route[0]})`;
	// A parameter that carries a destination pointing at an internal address: the SSRF shape a forwarding
	// service turns into a request to somewhere the scope never allowed. Only embedded destinations count,
	// not the target of a normal lab request (127.0.0.1 is the lab itself).
	for (const match of haystack.matchAll(/(?:url|target|dest|destination|next|redirect|callback|webhook|fetch|proxy)\s*=\s*([^&\s"']+)/gi)) {
		const value = decodeURIComponent((match[1] ?? "").replace(/^\/+/, ""));
		const host = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i.exec(value)?.[1] ?? value.split(/[/?#]/)[0] ?? "";
		const address = host.replace(/^\[|\]$/g, "").split(":")[0] ?? "";
		if (address.length > 0 && isInternalAddress(address)) return `forwarded destination to an internal address (${address})`;
	}
	// A proxy-style request that carries an absolute internal URL in a header or parameter.
	if (/\/(?:proxy|forward|fetch|relay|gateway)\?[^\s]*(?:url|target|dest|next)=/i.test(haystack)) return "forwarding endpoint with an embedded destination";
	return null;
}
const HEADER_FLAGS = new Set(["-H", "--header"]);
const GRAPHQL_CONTENT_TYPE = /^application\/(?:json|graphql)/i;
const GRAPHQL_COMMENT = /#[^\n]*/g;

function headerValues(args: string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		const name = token.startsWith("--header=") ? "--header" : token;
		if (!HEADER_FLAGS.has(name)) continue;
		const value = token.startsWith("--header=") ? token.slice("--header=".length) : args[index + 1];
		if (typeof value === "string") out.push(value);
	}
	return out;
}

function bodyValues(args: string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		const equals = token.indexOf("=");
		const name = equals > 0 && token.startsWith("--") ? token.slice(0, equals) : token;
		const attached = /^-d.+/.test(token) && !token.startsWith("-d=") ? token.slice(2) : null;
		if (attached !== null) {
			out.push(attached);
			continue;
		}
		if (!DATA_FLAGS.has(name)) continue;
		const value = token.startsWith("--") && equals > 0 ? token.slice(equals + 1) : args[index + 1];
		if (typeof value === "string" && !value.startsWith("@")) out.push(value);
	}
	return out;
}

/** True when the args carry a GraphQL mutation (state-changing), ignoring comments. */
export function graphqlMutation(args: string[]): string | null {
	const bodies = bodyValues(args);
	if (bodies.length === 0) return null;
	const declared = headerValues(args).some((header) => {
		const match = /^\s*content-type\s*:\s*([^;]+)/i.exec(header);
		return match !== null && GRAPHQL_CONTENT_TYPE.test(match[1]!.trim());
	});
	for (const body of bodies) {
		const withoutComments = body.replace(GRAPHQL_COMMENT, "");
		if (!/\bmutation\b/i.test(withoutComments)) continue;
		const looksLikeGraphql =
			declared ||
			/^\s*\{/.test(body) ||
			/^\s*mutation\b/i.test(body) ||
			/"query"\s*:/i.test(body) ||
			/"operationName"\s*:/i.test(body);
		if (looksLikeGraphql) return withoutComments.replace(/\s+/g, " ").trim().slice(0, 120);
	}
	return null;
}

export interface DestructiveInput {
	tool: string;
	args: string[];
	technique?: string;
	scopeRateRps: number | null;
	forbidden?: string[];
	targetPath?: string;
}

export interface DestructiveVerdict {
	destructive: boolean;
	reason: string | null;
	signals: string[];
	/** Classes the heuristics actually matched, so the session can intersect them with the program's forbidden list (S64). */
	classes: string[];
}

function numericValue(args: string[], flags: Set<string>, shortWithValue: boolean): number | null {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		const equals = token.indexOf("=");
		const name = equals >= 0 && token.startsWith("--") ? token.slice(0, equals) : token;
		const inlineValue = equals >= 0 ? token.slice(equals + 1) : null;
		if (flags.has(name)) {
			const raw = inlineValue ?? args[index + 1];
			if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
			continue;
		}
		// Attached short form such as `-c50`.
		if (shortWithValue && /^-[a-z]\d+$/i.test(token)) {
			const short = token.slice(0, 2);
			if (flags.has(short)) return Number(token.slice(2));
		}
	}
	return null;
}

function stringValue(args: string[], flags: Set<string>): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		const equals = token.indexOf("=");
		const name = equals >= 0 && token.startsWith("--") ? token.slice(0, equals) : token;
		if (!flags.has(name)) continue;
		const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
		if (typeof value === "string") return value;
	}
	return null;
}

export function classifyDestructive(input: DestructiveInput): DestructiveVerdict {
	const signals: string[] = [];
	const strong: string[] = [];
	const weak: string[] = [];
	const binary = input.tool.trim();
	const targetPath = input.targetPath ?? stringValue(input.args, TARGET_FLAGS) ?? "";

	const classes: string[] = [];
	if (BRUTE_FORCE_BINARIES.test(binary)) {
		strong.push(`binary "${binary}" is a credential brute-force tool`);
		classes.push("brute-force");
	}

	if (input.args.some((arg) => FLOOD_FLAGS.test(arg))) {
		strong.push("flooding flag in argv");
		classes.push("dos");
	}
	if (input.args.some((arg) => /rate[-_]?limit\s*[=\s]?0\b/i.test(arg))) {
		strong.push("rate limited to zero means no limit");
		classes.push("fuzzing-flood");
	}

	// S91: infrastructure probing through a proxy pauses on its own, whatever was authorized before.
	const probing = infraProbing(input.args, targetPath);
	if (probing !== null) {
		strong.push(
			`intento de alcanzar infraestructura interna o una ruta no documentada a través de un servicio que reenvía: ${probing}. Esto no hereda ninguna autorización previa de la sesión`,
		);
		classes.push("infra-probing-via-proxy");
	}

	// S81/task 2: every GraphQL mutation is state-changing until a human says otherwise.
	const mutation = graphqlMutation(input.args);
	if (mutation !== null) {
		strong.push(`GraphQL mutation in the request body: ${mutation}`);
		classes.push("graphql-mutation");
	}

	const tags = stringValue(input.args, TAGS_FLAGS);
	if (tags !== null && DANGEROUS_TAGS.test(tags)) {
		strong.push(`nuclei tags "${tags}" include an intrusive class`);
		classes.push("dos");
	}

	const wordlist = stringValue(input.args, WORDLIST_FLAGS);
	if (wordlist !== null && PASSWORD_WORDLIST.test(wordlist)) {
		if (LOGIN_PATH.test(targetPath) || BRUTE_FORCE_BINARIES.test(binary)) {
			strong.push(`password wordlist "${wordlist}" against a login/session endpoint`);
			classes.push("password-spray");
		} else {
			weak.push(`password-looking wordlist "${wordlist}"`);
		}
	}

	const rate = numericValue(input.args, RATE_FLAGS, true);
	if (rate !== null) {
		if (rate === 0) strong.push("rate limited to zero means no limit");
		else if (input.scopeRateRps === null) strong.push(`explicit rate ${rate} with no rate declared by the program`);
		else if (rate > input.scopeRateRps) strong.push(`rate ${rate} exceeds the program rate of ${input.scopeRateRps}/s`);
	}

	const concurrency = numericValue(input.args, CONCURRENCY_FLAGS, true);
	if (concurrency !== null && concurrency > 20) weak.push(`concurrency ${concurrency} is aggressive`);

	if (LOGIN_PATH.test(targetPath)) weak.push("target is a login/session endpoint");

	const forbidden = (input.forbidden ?? []).filter((item) => DESTRUCTIVE_TECHNIQUES.has(item));
	if (input.technique !== undefined && forbidden.includes(input.technique)) {
		strong.push(`class "${input.technique}" is on the program's forbidden list`);
	} else if (input.technique !== undefined && DESTRUCTIVE_TECHNIQUES.has(input.technique)) {
		strong.push(`declared class "${input.technique}" is destructive`);
	}

	signals.push(...strong, ...weak);

	// Ambiguity resolves toward pausing: two weak signals together are treated as destructive.
	if (input.technique !== undefined && DESTRUCTIVE_TECHNIQUES.has(input.technique)) classes.push(input.technique);
	if (strong.length > 0) return { destructive: true, reason: strong[0] ?? "destructive signal", signals, classes: [...new Set(classes)] };
	if (weak.length >= 2) return { destructive: true, reason: `ambiguous combination: ${weak.join("; ")}`, signals, classes: [...new Set(classes)] };
	return { destructive: false, reason: null, signals, classes: [...new Set(classes)] };
}
