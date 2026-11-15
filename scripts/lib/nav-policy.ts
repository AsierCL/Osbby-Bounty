/**
 * S88: what a browser is allowed to fetch.
 *
 * A real browser makes many requests the argv never mentions: analytics, fonts, DataDome's script,
 * CDNs. Handing a browser to the agent without a per-request check would open a channel the gate never
 * sees. This module answers one question per request, with the same scope matcher the gate uses.
 */
import { evaluate, parseScope, type ScopePolicy } from "../../src/core/scope.ts";
import { parseTarget } from "../../src/core/target.ts";

export interface NavDecision {
	allowed: boolean;
	reason: string;
}

export interface NavPolicy {
	decide(url: string): NavDecision;
	policy: ScopePolicy;
}

export function makeNavPolicy(scopeText: string): NavPolicy {
	const parsed = parseScope(scopeText);
	if (!parsed.ok) throw new Error(`scope does not parse: ${parsed.errors.join("; ")}`);
	const policy = parsed.policy;
	return {
		policy,
		decide(url: string): NavDecision {
			const trimmed = url.trim();
			if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { allowed: true, reason: "not a URL with a scheme" };
			if (!/^https?:/i.test(trimmed)) return { allowed: true, reason: "not network traffic" };
			const target = parseTarget(trimmed);
			if (!target.ok) return { allowed: false, reason: `unparseable url: ${target.error}` };
			const verdict = evaluate(policy, target.target);
			if (verdict.verdict === "in") return { allowed: true, reason: verdict.rule };
			return { allowed: false, reason: verdict.verdict === "out" ? `out of scope by rule ${verdict.rule}` : `no in_scope rule matched ${target.target.host}` };
		},
	};
}

/**
 * S88: recognize an anti-bot wall so the run STOPS instead of grinding. Solving a captcha is evading a
 * third party's access control: the program does not authorize it, and this tool does not do it. The
 * honest output is "a human is needed here".
 */
const ANTI_BOT_MARKERS: { provider: string; markers: RegExp[] }[] = [
	{ provider: "datadome", markers: [/captcha-delivery\.com/i, /datadome/i, /geo\.captcha-delivery/i] },
	{ provider: "cloudflare", markers: [/cf-challenge/i, /challenges\.cloudflare\.com/i, /cf_chl_opt/i] },
	{ provider: "perimeterx", markers: [/px-captcha/i, /perimeterx/i, /_pxI/i] },
	{ provider: "hcaptcha", markers: [/hcaptcha\.com/i, /h-captcha/i] },
	{ provider: "recaptcha", markers: [/recaptcha\/api\.js/i, /g-recaptcha/i] },
];

export function detectAntiBot(html: string, blockedUrls: string[] = []): { detected: boolean; provider: string | null } {
	const haystack = `${html}\n${blockedUrls.join("\n")}`;
	for (const entry of ANTI_BOT_MARKERS) {
		if (entry.markers.some((marker) => marker.test(haystack))) return { detected: true, provider: entry.provider };
	}
	return { detected: false, provider: null };
}
