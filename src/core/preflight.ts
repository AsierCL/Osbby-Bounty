/**
 * S75/task 4: offline preflight of a scope file.
 *
 * Read-only and with no network: it answers "what would the session think of this scope, and what
 * should I fix before confirming it?". The summary is the same one bounty_scope prints, so the
 * preflight cannot describe the scope differently from the session that will use it.
 */
import { parseScope, summarizeScope, type ScopePolicy } from "./scope.ts";

export interface PreflightScopeResult {
	ok: boolean;
	text: string;
	policy: ScopePolicy | null;
	warnings: string[];
}

const PRUDENT_RPS = 10;

export function preflightScope(text: string, options: { now?: () => number } = {}): PreflightScopeResult {
	const now = options.now ?? (() => Date.now());
	const parsed = parseScope(text);
	if (!parsed.ok) {
		return { ok: false, policy: null, warnings: [], text: `El alcance no parsea, así que no lo uso:\n- ${parsed.errors.join("\n- ")}` };
	}
	const policy = parsed.policy;
	const warnings: string[] = [];

	// Wildcards that do not pin a port cover every port of the names they match.
	for (const rule of policy.inScope) {
		if (rule.wildcard && rule.port === null) {
			warnings.push(`la regla ${rule.raw} no fija puerto: cubre todos los puertos de los nombres que matchean`);
		}
	}
	if (policy.outOfScope.length === 0) warnings.push("el programa no declara nada fuera de alcance: no puedo proteger nada que el alcance no excluya");
	if (policy.limits.rateRps === null) warnings.push("el scope no declara limits.rate_rps: el gate va a 1 req/s por defecto");
	else if (policy.limits.rateRps > PRUDENT_RPS) warnings.push(`el ritmo declarado (${policy.limits.rateRps} req/s) está por encima de lo prudente (${PRUDENT_RPS} req/s)`);
	if (policy.lab === false) {
		if (policy.authorizedOn === null) warnings.push("lab: false sin authorized_on: un programa real necesita la fecha de autorización");
		else {
			const at = Date.parse(policy.authorizedOn);
			if (Number.isNaN(at)) warnings.push(`authorized_on no es una fecha legible: ${policy.authorizedOn}`);
			else if (at > now()) warnings.push(`authorized_on está en el futuro (${policy.authorizedOn}): revisá la fecha antes de confirmar`);
		}
	}

	return { ok: true, policy, warnings, text: summarizeScope(policy, parsed.warnings, warnings) };
}
