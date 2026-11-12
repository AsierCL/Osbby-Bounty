/**
 * S37: budgets stop the work, not the evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBudget, DEFAULT_BUDGET } from "../src/pi/budget.ts";
import { createStopController } from "../src/pi/stop.ts";

function clock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
	};
}

test("the wall clock limit refuses once time is spent", () => {
	const c = clock();
	const budget = createBudget({ maxWallMs: 1000 }, c.now);
	assert.equal(budget.exceeded(), null);
	c.advance(1001);
	const hit = budget.exceeded();
	assert.equal(hit?.limit, "wall");
	assert.match(hit?.message ?? "", /límite de tiempo/);
});

test("the tool call limit refuses the next call instead of counting forever", () => {
	const budget = createBudget({ maxToolCalls: 2 }, () => 0);
	assert.equal(budget.toolCall(), null);
	assert.equal(budget.toolCall(), null);
	const third = budget.toolCall();
	assert.equal(third?.limit, "toolCalls");
	assert.match(third?.message ?? "", /2 llamadas/);
	assert.equal(budget.snapshot().toolCalls, 2);
});

test("the token limit reports how much was used", () => {
	const budget = createBudget({ maxTokens: 100 }, () => 0);
	assert.equal(budget.tokens(60), null);
	const hit = budget.tokens(60);
	assert.equal(hit?.limit, "tokens");
	assert.equal(hit?.used, 120);
});

test("defaults exist and are finite", () => {
	assert.ok(DEFAULT_BUDGET.maxWallMs > 0);
	assert.ok(DEFAULT_BUDGET.maxToolCalls > 0);
	assert.ok(DEFAULT_BUDGET.maxTokens > 0);
	const budget = createBudget({}, () => 0);
	for (let index = 0; index < 3; index += 1) assert.equal(budget.toolCall(), null);
});

test("stop kills every registered child and reports how many", () => {
	const killed: number[] = [];
	const controller = createStopController({ now: () => 5_000 });
	const child = (pid: number) => ({ pid, kill: () => (killed.push(pid), true) });
	controller.register(child(11));
	const dispose = controller.register(child(22));
	controller.register(child(33));
	dispose();
	const result = controller.stop("prueba");
	assert.equal(result.stopped, true);
	assert.equal(result.killed, 2);
	assert.deepEqual(killed.sort(), [11, 33]);
	assert.equal(controller.isStopped(), true);
	assert.equal(controller.reason(), "prueba");
	assert.equal(controller.live(), 0);
});

test("a child that already exited does not break the stop", () => {
	const controller = createStopController();
	controller.register({
		pid: 1,
		kill() {
			throw new Error("ESRCH");
		},
	});
	const result = controller.stop("prueba");
	assert.equal(result.stopped, true);
	assert.equal(result.killed, 0);
});
