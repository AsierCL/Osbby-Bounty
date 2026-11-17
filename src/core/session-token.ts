/**
 * S103: short-lived sessions (JWT/cookies) expire while the agent works.
 *
 * This module reads the human's `session.headers` and tells the agent, before a burst, how much life is
 * left in the bearer token. It never refreshes anything by itself: a token is the human's, and asking
 * for a new storage state is a human step. On 401/403 the session records "session expired" so the
 * operator sees it in status.md instead of the agent retrying a dead token.
 */
export type TokenState = "missing" | "unknown" | "valid" | "expiring" | "expired";

export interface TokenStatus {
	state: TokenState;
	/** Epoch seconds, when the bearer token declares one. */
	expiresAt: number | null;
	minutesLeft: number | null;
	hasCookie: boolean;
	detail: string;
}

const EXPIRING_MINUTES = 10;

function decodeBase64Url(value: string): string | null {
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
		return Buffer.from(padded, "base64").toString("utf8");
	} catch {
		return null;
	}
}

/** Reads the `exp` claim of a JWT without verifying it (the gate is not an auth server). */
export function jwtExpiry(token: string): number | null {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	const payload = decodeBase64Url(parts[1] as string);
	if (payload === null) return null;
	try {
		const parsed = JSON.parse(payload) as { exp?: unknown };
		return typeof parsed.exp === "number" && Number.isFinite(parsed.exp) ? parsed.exp : null;
	} catch {
		return null;
	}
}

export function tokenStatus(headersText: string | null, now: () => number = () => Date.now()): TokenStatus {
	if (headersText === null) {
		return { state: "missing", expiresAt: null, minutesLeft: null, hasCookie: false, detail: "no hay work/<programa>/session.headers" };
	}
	let bearer: string | null = null;
	let hasCookie = false;
	for (const line of headersText.split(/\r?\n/)) {
		const trimmed = line.trim();
		const separator = trimmed.indexOf(":");
		if (separator <= 0) continue;
		const name = trimmed.slice(0, separator).trim().toLowerCase();
		const value = trimmed.slice(separator + 1).trim();
		if (name === "cookie") hasCookie = true;
		if (name === "authorization" && /^bearer\s+/i.test(value)) bearer = value.replace(/^bearer\s+/i, "").trim();
	}
	if (bearer === null) {
		return {
			state: hasCookie ? "unknown" : "missing",
			expiresAt: null,
			minutesLeft: null,
			hasCookie,
			detail: hasCookie ? "hay cookie de sesión; la caducidad no se puede leer sin un JWT" : "no hay Authorization: Bearer",
		};
	}
	const expiresAt = jwtExpiry(bearer);
	if (expiresAt === null) {
		return { state: "unknown", expiresAt: null, minutesLeft: null, hasCookie, detail: "el Bearer no es un JWT con exp legible" };
	}
	const minutesLeft = Math.floor((expiresAt * 1000 - now()) / 60_000);
	if (minutesLeft <= 0) return { state: "expired", expiresAt, minutesLeft, hasCookie, detail: "el token ya expiró" };
	if (minutesLeft <= EXPIRING_MINUTES) return { state: "expiring", expiresAt, minutesLeft, hasCookie, detail: `al token le quedan ${minutesLeft} min` };
	return { state: "valid", expiresAt, minutesLeft, hasCookie, detail: `al token le quedan ${minutesLeft} min` };
}
