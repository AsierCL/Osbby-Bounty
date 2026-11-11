/**
 * Redaction of the view that reaches the model (S11 C4).
 *
 * The rule is structural, not textual: `bounty_run` returns *this* view, and the raw bytes only ever
 * land in the evidence store. Every redaction is named so the model knows something was withheld.
 * Labels never contain the value they replaced.
 */

export interface RedactOptions {
	maxBodyBytes?: number;
}

export interface RedactedView {
	headers: Record<string, string>;
	body: string | null;
	redactions: string[];
	truncatedBytes?: number;
}

export interface RedactedResponseView extends RedactedView {
	status: number;
}

export interface RedactedRequestView extends RedactedView {
	method: string;
	url: string;
}

export interface RawRequest {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: string | null;
}

export interface RawResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string | null;
}

const DEFAULT_MAX_BODY_BYTES = 2048;

const SENSITIVE_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"api-key",
	"apikey",
	"x-auth-token",
	"x-csrf-token",
	"x-xsrf-token",
	"x-session-token",
	"session",
	"x-amz-security-token",
]);

const SENSITIVE_QUERY = new Set([
	"token",
	"access_token",
	"id_token",
	"refresh_token",
	"api_key",
	"apikey",
	"key",
	"sig",
	"signature",
	"password",
	"passwd",
	"secret",
	"code",
	"auth",
	"session",
]);

const REDACTED = "[REDACTED]";

export function redactHeaders(input: Record<string, string>): { headers: Record<string, string>; redactions: string[] } {
	const headers: Record<string, string> = {};
	const redactions: string[] = [];
	for (const [name, value] of Object.entries(input)) {
		if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
			headers[name] = REDACTED;
			redactions.push(`header:${name.toLowerCase()}`);
			continue;
		}
		headers[name] = value;
	}
	return { headers, redactions };
}

export function redactUrl(input: string): { url: string; redactions: string[] } {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return { url: input, redactions: [] };
	}
	const redactions: string[] = [];
	for (const key of [...parsed.searchParams.keys()]) {
		if (!SENSITIVE_QUERY.has(key.toLowerCase())) continue;
		parsed.searchParams.set(key, REDACTED);
		redactions.push(`query:${key.toLowerCase()}`);
	}
	return { url: parsed.toString(), redactions };
}

export function redactText(input: string): { text: string; redactions: string[] } {
	const redactions: string[] = [];
	let text = input;

	// JWT: three base64url segments, the first always starts with `eyJ`.
	const jwt = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
	if (jwt.test(text)) {
		text = text.replace(jwt, "[REDACTED:jwt]");
		redactions.push("body:jwt");
	}

	const bearer = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
	if (bearer.test(text)) {
		text = text.replace(bearer, "$1[REDACTED]");
		redactions.push("body:bearer");
	}

	const credentialField = /("?(?:password|passwd|pwd|secret|client_secret|private_key)"?\s*[:=]\s*)"[^"]*"/gi;
	if (credentialField.test(text)) {
		text = text.replace(credentialField, `$1"${REDACTED}"`);
		redactions.push("body:credential-field");
	}

	const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
	if (email.test(text)) {
		text = text.replace(email, "[REDACTED:email]");
		redactions.push("body:email");
	}

	// Long opaque values assigned to a sensitive-looking key, with no recognizable prefix.
	const opaque = /((?:key|token|secret|sig|signature|session|auth)\s*=\s*)[A-Za-z0-9._~+/=-]{16,}/gi;
	if (opaque.test(text)) {
		text = text.replace(opaque, `$1${REDACTED}`);
		redactions.push("body:opaque-value");
	}

	return { text, redactions };
}

function truncate(body: string, options: RedactOptions): { body: string; truncatedBytes?: number } {
	const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	if (body.length <= limit) return { body };
	const dropped = body.length - limit;
	return { body: `${body.slice(0, limit)}... [truncated ${dropped} bytes]`, truncatedBytes: dropped };
}

export function redactRequest(request: RawRequest, options: RedactOptions = {}): RedactedRequestView {
	const url = redactUrl(request.url);
	const headers = redactHeaders(request.headers ?? {});
	const redactions = [...url.redactions, ...headers.redactions];

	if (request.body === undefined || request.body === null) {
		return { method: request.method ?? "GET", url: url.url, headers: headers.headers, body: null, redactions };
	}
	const text = redactText(request.body);
	redactions.push(...text.redactions);
	const body = truncate(text.text, options);
	return {
		method: request.method ?? "GET",
		url: url.url,
		headers: headers.headers,
		body: body.body,
		redactions,
		...(body.truncatedBytes === undefined ? {} : { truncatedBytes: body.truncatedBytes }),
	};
}

export function redactResponse(response: RawResponse, options: RedactOptions = {}): RedactedResponseView {
	const headers = redactHeaders(response.headers ?? {});
	const redactions = [...headers.redactions];

	if (response.body === undefined || response.body === null) {
		return { status: response.status, headers: headers.headers, body: null, redactions };
	}
	const text = redactText(response.body);
	redactions.push(...text.redactions);
	const body = truncate(text.text, options);
	return {
		status: response.status,
		headers: headers.headers,
		body: body.body,
		redactions,
		...(body.truncatedBytes === undefined ? {} : { truncatedBytes: body.truncatedBytes }),
	};
}
