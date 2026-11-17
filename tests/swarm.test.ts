/**
 * S2/S5: the swarm runner, tested with a fake child. The properties pinned here are the ones that
 * make fan-out useful instead of expensive: declared order, a real concurrency cap, an aggregate
 * budget that stops launching, and one child's failure never taking down the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runSwarm, SWARM_ROLES, swarmTaskFor, summarizeSwarm, type SwarmRoleSpec } from "../src/pi/swarm.ts";

function role(name: string, tools: string[] = ["read"]): SwarmRoleSpec {
	return { role: name, task: `mandato de ${name}`, tools };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("every catalog role has an allowlist the runner accepts", () => {
	const names = Object.keys(SWARM_ROLES);
	assert.ok(names.length >= 5, `esperaba al menos 5 roles, encontré ${names.length}`);
	for (const [name, spec] of Object.entries(SWARM_ROLES)) {
		assert.ok(spec.tools.length > 0, `${name} has no tools`);
		assert.ok(!spec.tools.some((tool) => /bash|shell|exec|fetch|http|curl|wget|write|edit/i.test(tool)), `${name} declares a forbidden tool`);
	}
});

test("the catalog is complementary, not redundant: it has an authorization, a client and a skeptic role", () => {
	for (const name of ["authz-matrix", "js-analyst", "skeptic"]) assert.ok(name in SWARM_ROLES, `falta el rol ${name}`);
});

test("runs every role and keeps the declared order, not the completion order", async () => {
	const roles = [role("slow"), role("fast"), role("medium")];
	const delays: Record<string, number> = { slow: 30, fast: 1, medium: 10 };
	const run = await runSwarm({ roles, maxParallel: 3 }, { run: async (item) => {
		await sleep(delays[item.role] ?? 0);
		return { ok: true, output: item.role, toolCalls: 1, durationMs: 1, sessionId: `S-${item.role}` };
	} });

	assert.deepEqual(run.results.map((result) => result.role), ["slow", "fast", "medium"]);
	assert.equal(run.results.every((result) => result.status === "ran"), true);
	assert.equal(run.toolCalls, 3);
});

test("never exceeds the parallelism cap", async () => {
	let active = 0;
	let peak = 0;
	const roles = Array.from({ length: 6 }, (_unused, index) => role(`r${index}`));

	const run = await runSwarm({ roles, maxParallel: 2 }, { run: async (item) => {
		active += 1;
		peak = Math.max(peak, active);
		await sleep(12);
		active -= 1;
		return { ok: true, output: item.role, toolCalls: 1, durationMs: 12, sessionId: "S" };
	} });

	assert.equal(peak, 2);
	assert.equal(run.results.length, 6);
});

test("a cap bigger than the swarm is clamped, not an error", async () => {
	let peak = 0;
	let active = 0;
	const roles = [role("a"), role("b")];
	const run = await runSwarm({ roles, maxParallel: 9 }, { run: async () => {
		active += 1;
		peak = Math.max(peak, active);
		await sleep(5);
		active -= 1;
		return { ok: true, output: "", toolCalls: 0, durationMs: 5, sessionId: "S" };
	} });
	assert.equal(peak, 2);
	assert.equal(run.results.filter((result) => result.status === "ran").length, 2);
});

test("an empty swarm is refused instead of doing nothing silently", async () => {
	await assert.rejects(() => runSwarm({ roles: [] }, { run: async () => ({ ok: true, output: "", toolCalls: 0, durationMs: 0, sessionId: "" }) }), /at least one role/);
});

test("the same role twice is refused: that is redundancy, not complement", async () => {
	await assert.rejects(
		() => runSwarm({ roles: [role("authz-matrix"), role("authz-matrix")] }, { run: async () => ({ ok: true, output: "", toolCalls: 0, durationMs: 0, sessionId: "" }) }),
		/duplicated role/,
	);
});

test("a role that asks for a shell or a fetch never starts", async () => {
	for (const tools of [["bash"], ["web_fetch"], ["write"]]) {
		await assert.rejects(
			() => runSwarm({ roles: [role("bad", tools)] }, { run: async () => ({ ok: true, output: "", toolCalls: 0, durationMs: 0, sessionId: "" }) }),
			/never receive|not in the bounty allowlist/,
		);
	}
});

test("a role without a mandate is refused", async () => {
	await assert.rejects(
		() => runSwarm({ roles: [{ role: "empty", task: "  ", tools: ["read"] }] }, { run: async () => ({ ok: true, output: "", toolCalls: 0, durationMs: 0, sessionId: "" }) }),
		/no mandate/,
	);
});

test("the aggregate budget stops launching and says which roles never ran", async () => {
	const roles = [role("a"), role("b"), role("c")];
	const launched: string[] = [];
	const run = await runSwarm({ roles, maxParallel: 1, budgetToolCalls: 1000 }, { run: async (item) => {
		launched.push(item.role);
		return { ok: true, output: "", toolCalls: 600, durationMs: 1, sessionId: `S-${item.role}` };
	} });

	assert.deepEqual(launched, ["a", "b"]);
	assert.equal(run.stoppedByBudget, true);
	assert.equal(run.toolCalls, 1200);
	const skipped = run.results.filter((result) => result.status === "skipped");
	assert.deepEqual(skipped.map((result) => result.role), ["c"]);
});

test("a budget that is not spent lets every role run", async () => {
	const roles = [role("a"), role("b"), role("c")];
	const run = await runSwarm({ roles, maxParallel: 1, budgetToolCalls: 1000 }, { run: async (item) => ({ ok: true, output: "", toolCalls: 100, durationMs: 1, sessionId: `S-${item.role}` }) });
	assert.equal(run.stoppedByBudget, false);
	assert.equal(run.results.every((result) => result.status === "ran"), true);
	assert.equal(run.toolCalls, 300);
});

test("one child failing does not kill the swarm", async () => {
	const roles = [role("a"), role("b"), role("c")];
	const run = await runSwarm({ roles }, { run: async (item) => {
		if (item.role === "b") return { ok: false, output: "", toolCalls: 3, durationMs: 1, sessionId: "S-B", error: "gate blocked" };
		return { ok: true, output: item.role, toolCalls: 1, durationMs: 1, sessionId: `S-${item.role}` };
	} });

	assert.equal(run.results.filter((result) => result.status === "ran" && result.ok).length, 2);
	const failed = run.results.find((result) => result.role === "b");
	assert.equal(failed?.status, "ran");
	assert.equal(failed?.status === "ran" ? failed.ok : true, false);
	assert.match(summarizeSwarm(run), /b: falló \(gate blocked\)/);
});

test("a child that cannot even spawn is recorded, not propagated", async () => {
	const run = await runSwarm({ roles: [role("a")] }, { run: async () => {
		throw new Error("spawn failed");
	} });
	const [first] = run.results;
	assert.equal(first?.status, "ran");
	assert.equal(first?.status === "ran" ? first.ok : true, false);
	assert.match(first?.status === "ran" ? (first.error ?? "") : "", /spawn failed/);
});

test("the task names the program, the scope and the role mandate", () => {
	const spec = { role: "authz-matrix", task: SWARM_ROLES["authz-matrix"]?.brief ?? "", tools: SWARM_ROLES["authz-matrix"]?.tools ?? [] };
	const task = swarmTaskFor(spec, { program: "acme", scopePath: "/w/acme/scope.yaml", focus: "el endpoint de facturas" });
	assert.match(task, /programa acme/);
	assert.match(task, /\/w\/acme\/scope\.yaml/);
	assert.match(task, /authz-matrix/);
	assert.match(task, /bounty_blackboard claim/);
	assert.match(task, /Foco de esta corrida: el endpoint de facturas/);
	assert.match(task, /\{"role":"authz-matrix"/);
});

test("the focus is flattened and bounded", () => {
	const spec = { role: "skeptic", task: "refutar", tools: ["read"] };
	const long = swarmTaskFor(spec, { program: "acme", scopePath: "/s", focus: `linea1\nlinea2\r\n${"x".repeat(600)}` });
	const focusLine = long.split("\n").find((line) => line.startsWith("Foco de esta corrida:"));
	assert.ok(focusLine, "no focus line");
	assert.ok((focusLine as string).length < 460, "the focus line is not bounded");
	assert.doesNotMatch(focusLine as string, /\n/);
});

test("the summary counts what ran and reports the budget", () => {
	const summary = summarizeSwarm({
		results: [
			{ role: "a", status: "ran", ok: true, output: "", toolCalls: 4, durationMs: 2000, sessionId: "S-1" },
			{ role: "b", status: "skipped", reason: "budget" },
		],
		toolCalls: 4,
		stoppedByBudget: true,
	});
	assert.match(summary, /1 rol\(es\) ejecutado\(s\), 4 llamadas/);
	assert.match(summary, /presupuesto agotado/);
	assert.match(summary, /b: no se lanzó/);
});
