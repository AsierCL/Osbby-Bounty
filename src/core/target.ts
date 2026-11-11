/**
 * Target normalization.
 *
 * Why this module exists: `acme.com`, `ACME.COM.`, `http://acme.com./`, `2130706433`, `[::1]`,
 * `acme.com@otro.com` and `%2e`-encoded variants are read differently by different tools. The gate
 * cannot decide "in scope" on a spelling, only on a canonical host. Everything ambiguous is an
 * error, never a guess (S17: "El parseo del matcher falla cerrado").
 */

export interface Target {
	raw: string;
	scheme: string | null;
	host: string;
	isIp: boolean;
	ipVersion: 4 | 6 | null;
	port: number | null;
	path: string;
	query: string | null;
	userinfo: string | null;
	/** Every transformation applied to reach `host`, for the evidence record. */
	normalizations: string[];
}

export type ParseResult = { ok: true; target: Target } | { ok: false; error: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WS_OR_CONTROL = /[\u0000-\u0020\u007f]/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DOTTED_QUAD_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/** The host exactly as the caller spelled it, before any URL parser normalization. */
function hostSpellingOf(input: string): string {
	let authority = input;
	const schemeMatch = input.match(SCHEME_RE);
	if (schemeMatch) authority = input.slice(schemeMatch[0].length);
	else if (authority.startsWith("//")) authority = authority.slice(2);
	authority = authority.split(/[/?#]/)[0] ?? "";

	const at = authority.lastIndexOf("@");
	if (at >= 0) authority = authority.slice(at + 1);

	if (authority.startsWith("[")) {
		const end = authority.indexOf("]");
		return end >= 0 ? authority.slice(0, end + 1) : authority;
	}
	const colon = authority.lastIndexOf(":");
	if (colon >= 0 && /^\d+$/.test(authority.slice(colon + 1))) authority = authority.slice(0, colon);
	return authority;
}

function dottedQuadVersion(host: string): 4 | null {
	if (!DOTTED_QUAD_RE.test(host)) return null;
	for (const part of host.split(".")) {
		if (Number(part) > 255) return null;
	}
	return 4;
}

function validateHostSyntax(host: string): string | null {
	if (host.length === 0) return "invalid host syntax: empty host";
	if (host.length > MAX_HOST_LENGTH) return `host too long: ${host.length} > ${MAX_HOST_LENGTH}`;
	for (const label of host.split(".")) {
		if (label.length === 0) return "invalid host syntax: empty label";
		if (label.length > MAX_LABEL_LENGTH) return `invalid host syntax: label longer than ${MAX_LABEL_LENGTH}`;
		if (!LABEL_RE.test(label)) return `invalid host syntax: ${JSON.stringify(label)}`;
	}
	return null;
}

export function parseTarget(input: string): ParseResult {
	if (typeof input !== "string") return { ok: false, error: "empty target" };
	const trimmed = input.trim();
	if (trimmed.length === 0) return { ok: false, error: "empty target" };
	if (WS_OR_CONTROL.test(trimmed)) {
		// Whitespace and control characters are rejected before the URL parser gets a chance to
		// silently strip them (WHATWG removes tab/LF/CR, which is a smuggling primitive).
		return { ok: false, error: "whitespace or control characters in target" };
	}

	const normalizations: string[] = [];
	const spelling = hostSpellingOf(trimmed);

	let url: URL;
	let scheme: string | null = null;
	try {
		if (SCHEME_RE.test(trimmed)) {
			url = new URL(trimmed);
			scheme = url.protocol.replace(/:$/, "");
		} else if (trimmed.startsWith("//")) {
			url = new URL(`http:${trimmed}`);
			normalizations.push("scheme-relative");
		} else {
			url = new URL(`http://${trimmed}`);
		}
	} catch (error) {
		const code = (error as { code?: string }).code ?? "unparseable";
		return { ok: false, error: `invalid url: ${code}` };
	}

	let host = url.hostname;
	let isIp = false;
	let ipVersion: 4 | 6 | null = null;

	if (host.startsWith("[")) {
		const inner = host.slice(1, -1);
		isIp = true;
		ipVersion = 6;
		if (spelling.replace(/^\[|\]$/g, "").toLowerCase() !== inner) normalizations.push("ipv6-compressed");
		host = inner;
	} else {
		const withoutTrailingDots = host.replace(/\.+$/, "");
		if (withoutTrailingDots !== host) {
			normalizations.push("trailing-dot");
			host = withoutTrailingDots;
			// Stripping the dot can turn an IPv4-looking spelling into a different parse
			// (`0x7f.` → `0x7f` → `0.0.0.127`). Canonicalization must be a fixed point, so re-parse
			// the stripped host and adopt its result instead of inventing a third spelling.
			if (host !== url.hostname) {
				const again = parseTarget(host);
				if (!again.ok) return { ok: false, error: again.error };
				return {
					ok: true,
					target: {
						...again.target,
						raw: input,
						scheme: again.target.scheme ?? scheme,
						normalizations: [...new Set([...normalizations, ...again.target.normalizations])],
						userinfo:
							again.target.userinfo ??
							(url.username === "" && url.password === ""
								? null
								: `${url.username}${url.password === "" ? "" : `:${url.password}`}`),
						port: again.target.port ?? (url.port === "" ? null : Number(url.port)),
					},
				};
			}
		}
		const strippedSpelling = spelling.replace(/\.+$/, "");
		if (strippedSpelling !== strippedSpelling.toLowerCase()) normalizations.push("case-folded");
		if (/[^\x00-\x7f]/.test(spelling)) normalizations.push("idn-to-punycode");

		const version = dottedQuadVersion(host);
		if (version === 4) {
			isIp = true;
			ipVersion = 4;
			if (strippedSpelling.toLowerCase() !== host) normalizations.push("ipv4-legacy");
		} else {
			const syntaxError = validateHostSyntax(host);
			if (syntaxError) return { ok: false, error: syntaxError };
		}
	}

	return {
		ok: true,
		target: {
			raw: input,
			scheme,
			host,
			isIp,
			ipVersion,
			port: url.port === "" ? null : Number(url.port),
			path: url.pathname === "" ? "/" : url.pathname,
			query: url.search === "" ? null : url.search.slice(1),
			userinfo:
				url.username === "" && url.password === ""
					? null
					: `${url.username}${url.password === "" ? "" : `:${url.password}`}`,
			normalizations,
		},
	};
}

/** Canonical host for a bare host string, or `null` when it cannot be canonicalized. */
export function canonicalHost(input: string): string | null {
	return parseLooseHost(input)?.host ?? null;
}

/**
 * Parse a host that may arrive already canonicalized, including a bare IPv6 literal (`::1`, which a
 * URL authority cannot express without brackets). Everything else still fails closed.
 */
export function parseLooseHost(input: string): Target | null {
	const direct = parseTarget(input);
	if (direct.ok) return direct.target;
	if (input.includes(":") && /^[0-9a-fA-F:.]+$/.test(input)) {
		const bracketed = parseTarget(`[${input}]`);
		if (bracketed.ok) return bracketed.target;
	}
	return null;
}
