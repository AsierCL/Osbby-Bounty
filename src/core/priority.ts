/**
 * S104: not every endpoint deserves the same slice of the budget.
 *
 * The harness classifies a target path so the agent (and the budget) can put API surfaces and critical
 * user flows first: /api/v…, GraphQL, auth, password/privilege changes, purchase/rights flows. It is a
 * priority signal, not a permission: the gate still decides what runs.
 */
export type TargetKind = "api" | "graphql" | "auth" | "privilege" | "purchase" | "page";

export interface TargetPriority {
	kind: TargetKind;
	score: number;
	reason: string;
}

const RULES: { kind: TargetKind; test: RegExp; score: number; reason: string }[] = [
	{ kind: "graphql", test: /\/graphql(?:\/|$|\?)/i, score: 100, reason: "GraphQL expone el modelo completo: campos, mutaciones y autorización por objeto" },
	{ kind: "api", test: /\/api(?:\/|$|\?)|^\/v\d+(?:\/|$)|\/services\//i, score: 90, reason: "superficie de API: IDs, verbos y autorización por objeto" },
	{ kind: "privilege", test: /\b(admin|role|permission|privilege|staff|impersonat|act-as|sudo)\b/i, score: 85, reason: "gestión de privilegios: escalada de rol" },
	{ kind: "purchase", test: /\b(buy|checkout|payment|pay|order|booking|reserve|refund|cart|coupon|redeem|credit|balance|transfer)\b/i, score: 85, reason: "flujo con efecto económico: validación de importes y estados" },
	{ kind: "auth", test: /\b(login|signin|sign-in|auth|oauth|saml|sso|password|reset|forgot|mfa|token|session)\b/i, score: 75, reason: "autenticación y sesión: fijación, expiración, revocación" },
	{ kind: "page", test: /.*/, score: 10, reason: "página estática o ruta de contenido" },
];

export function classifyTarget(path: string): TargetPriority {
	const clean = path.split("?")[0] ?? path;
	for (const rule of RULES) {
		if (rule.test.test(clean)) return { kind: rule.kind, score: rule.score, reason: rule.reason };
	}
	return { kind: "page", score: 10, reason: "página estática o ruta de contenido" };
}

/** True when the target is worth protecting from spending the last slice of the host budget. */
export function isHighValue(path: string): boolean {
	return classifyTarget(path).score >= 75;
}

/** S104: keep this share of the per-host cap for high-value targets. */
export const HIGH_VALUE_RESERVE_RATIO = 0.2;

export function reserveFor(cap: number): number {
	return Math.floor(cap * HIGH_VALUE_RESERVE_RATIO);
}
