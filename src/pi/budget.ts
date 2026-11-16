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

/**
 * S89: volume is the main limit, the clock is a safety net. 500 tool calls is roughly a night of
 * methodical work; 8 hours is deliberately generous so it only catches a runaway session, not real
 * work. Tokens scale with the volume: ~50k tokens per call on average, with headroom.
 */
export const DEFAULT_BUDGET: Required<BudgetPolicy> = {
	maxWallMs: 8 * 60 * 60 * 1000,
	maxToolCalls: 500,
	maxTokens: 25_000_000,
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
	/** S101: the start is persisted, so a restart continues the same clock instead of resetting it. */
	startedAt: number;
}

export interface Budget {
	/** Call before executing a tool. Returns a refusal when the budget is spent. */
	toolCall(): BudgetExceeded | null;
	tokens(count: number): BudgetExceeded | null;
	exceeded(): BudgetExceeded | null;
	snapshot(): BudgetSnapshot;
	/** S101: continue from what the program already spent instead of starting at zero. */
	restore(snapshot: { toolCalls?: number; tokens?: number; startedAt?: number }): void;
}

function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createBudget(policy: BudgetPolicy = {}, now: () => number = () => Date.now()): Budget {
	const maxWallMs = positiveOr(policy.maxWallMs, DEFAULT_BUDGET.maxWallMs);
	const maxToolCalls = positiveOr(policy.maxToolCalls, DEFAULT_BUDGET.maxToolCalls);
	const maxTokens = positiveOr(policy.maxTokens, DEFAULT_BUDGET.maxTokens);
	let startedAt = now();
	let toolCalls = 0;
	let tokensUsed = 0;

	const wall = (): BudgetExceeded | null => {
		const elapsed = now() - startedAt;
		if (elapsed <= maxWallMs) return null;
		const hours = Math.round((maxWallMs / 3_600_000) * 10) / 10;
		return { limit: "wall", used: elapsed, max: maxWallMs, message: `pasó el límite de tiempo de la corrida (${hours} h), que es red de seguridad y no límite de trabajo` };
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
			return { toolCalls, tokens: tokensUsed, elapsedMs: now() - startedAt, startedAt };
		},

		restore(snapshot) {
			if (typeof snapshot.toolCalls === "number" && snapshot.toolCalls >= 0) {
				toolCalls = Math.max(toolCalls, Math.floor(snapshot.toolCalls));
			}
			if (typeof snapshot.tokens === "number" && snapshot.tokens >= 0) {
				tokensUsed = Math.max(tokensUsed, Math.floor(snapshot.tokens));
			}
			if (typeof snapshot.startedAt === "number" && Number.isFinite(snapshot.startedAt)) {
				startedAt = snapshot.startedAt;
			}
		},
	};
}
