/**
 * Per-run budget (S37). Three limits, all optional, with conservative defaults: wall time, tool
 * calls, and tokens when the runtime reports them.
 *
 * Failing to respect a budget is how an agent burns a night and a provider quota against a program
 * that asked for five requests per second. Hitting a limit stops the work in order and says so in
 * status.md; it never throws away evidence.
 */

export interface BudgetPolicy {
	maxWallMs?: number;
	maxToolCalls?: number;
	maxTokens?: number;
}

export const DEFAULT_BUDGET: Required<BudgetPolicy> = {
	maxWallMs: 45 * 60 * 1000,
	maxToolCalls: 40,
	maxTokens: 2_000_000,
};

export type BudgetLimit = "wall" | "toolCalls" | "tokens";

export interface BudgetExceeded {
	limit: BudgetLimit;
	used: number;
	max: number;
	message: string;
}

export interface BudgetSnapshot {
	toolCalls: number;
	tokens: number;
	elapsedMs: number;
}

export interface Budget {
	/** Call before executing a tool. Returns a refusal when the budget is spent. */
	toolCall(): BudgetExceeded | null;
	tokens(count: number): BudgetExceeded | null;
	exceeded(): BudgetExceeded | null;
	snapshot(): BudgetSnapshot;
}

function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createBudget(policy: BudgetPolicy = {}, now: () => number = () => Date.now()): Budget {
	const maxWallMs = positiveOr(policy.maxWallMs, DEFAULT_BUDGET.maxWallMs);
	const maxToolCalls = positiveOr(policy.maxToolCalls, DEFAULT_BUDGET.maxToolCalls);
	const maxTokens = positiveOr(policy.maxTokens, DEFAULT_BUDGET.maxTokens);
	const startedAt = now();
	let toolCalls = 0;
	let tokensUsed = 0;

	const wall = (): BudgetExceeded | null => {
		const elapsed = now() - startedAt;
		if (elapsed <= maxWallMs) return null;
		const minutes = Math.round(maxWallMs / 60000);
		return { limit: "wall", used: elapsed, max: maxWallMs, message: `pasó el límite de tiempo de la corrida (${minutes} min)` };
	};

	return {
		toolCall() {
			const wallHit = wall();
			if (wallHit) return wallHit;
			if (toolCalls >= maxToolCalls) {
				return {
					limit: "toolCalls",
					used: toolCalls,
					max: maxToolCalls,
					message: `se alcanzó el límite de ${maxToolCalls} llamadas a herramientas en esta corrida`,
				};
			}
			toolCalls += 1;
			return null;
		},

		tokens(count) {
			tokensUsed += Math.max(0, count);
			if (tokensUsed <= maxTokens) return null;
			return {
				limit: "tokens",
				used: tokensUsed,
				max: maxTokens,
				message: `se alcanzó el límite de ${maxTokens} tokens en esta corrida`,
			};
		},

		exceeded: wall,

		snapshot() {
			return { toolCalls, tokens: tokensUsed, elapsedMs: now() - startedAt };
		},
	};
}
