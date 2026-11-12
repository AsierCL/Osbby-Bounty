/**
 * `fetch_allow` matching (S33): an operator-level list of hosts the agent may *download* from even
 * when they are outside the program's scope. It never widens the scope itself: a fetch to an allowed
 * host does not make that host a valid target.
 *
 * Semantics mirror the scope matcher: `github.com` matches exactly, `*.github.com` matches
 * subdomains only. No wildcard means no wildcard; a bare `github.com` does not cover
 * `raw.githubusercontent.com`.
 */

export const DEFAULT_FETCH_ALLOW: readonly string[] = ["github.com", "raw.githubusercontent.com"];

interface FetchRule {
	host: string;
	wildcard: boolean;
}

function parseRule(entry: string): FetchRule | null {
	const text = entry.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	const host = text.split(/[/?#]/)[0] ?? "";
	if (host.length === 0) return null;
	const wildcard = host.startsWith("*.");
	const bare = wildcard ? host.slice(2) : host;
	if (bare.length === 0 || bare.includes("*")) return null;
	return { host: bare, wildcard };
}

export function isFetchAllowed(host: string, allow: readonly string[]): boolean {
	const needle = host.trim().toLowerCase().replace(/\.+$/, "");
	if (needle.length === 0) return false;
	for (const entry of allow) {
		const rule = parseRule(entry);
		if (rule === null) continue;
		if (rule.wildcard) {
			if (needle !== rule.host && needle.endsWith(`.${rule.host}`)) return true;
			continue;
		}
		if (needle === rule.host) return true;
	}
	return false;
}
