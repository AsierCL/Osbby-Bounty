/**
 * S9-S12: the swarm, tested with a fake child. Pinned here: the gate runs before any spawn, the
 * concurrency cap is real, a child can never receive `bounty_swarm`, and the fan-in keeps each child's
 * identity (sessionId + invocationToken).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runSwarm, SWARM_ROLES, DEFAULT_ROLES, renderSnapshot, summarizeSwarm, swarmTaskFor } from "../src/pi/swarm.ts";
import { validateTools } from "../src/pi/runner.ts";

const ARTIFACT = { id: "0123456789abcdef", category: "endpoint" as const, target: "https://a.acme.com/api", data: { method: "GET" }, discoveredBy: "S-1", ts: "2026-11-18T10:00:00.000Z" };

function outcome(role: string) {
	return { ok: true, output: role, toolCalls: 2, durationMs: 10, sessionId: `S-${role}`, invocationToken: `tok-${role}` };
}

test("the catalog is the four orthogonal profiles and every allowlist is valid", () => {
	assert.deepEqual([...DEFAULT_ROLES].sort(), ["authz", "headers-config", "js-analyzer", "schema"]);
	for (const [name, role] of Object.entries(SWARM_ROLES)) {
		assert.ok(role.tools.includes("bounty_blackboard"), `${name} cannot publish`);
		assert.doesNotThrow(() => validateTools(role.tools), `${name} has a tool the runner rejects`);
	}
});

test("S11: a child can never receive bounty_swarm", () => {
	assert.throws(() => validateTools(["bounty_swarm"]), /not in the bounty allowlist/);
	// And no role in the catalog declares it.
	for (const role of Object.values(SWARM_ROLES)) assert.ok(!role.tools.includes("bounty_swarm"));
});

test("an out-of-scope target aborts before spawning a single child", async () => {
	let spawned = 0;
	const run = await runSwarm(
		{ target: "https://evil.example" },
		{
			checkTarget: async () => ({ ok: false, reason: "host fuera del alcance permitido" }),
			run: async () => {
				spawned += 1;
				return outcome("x");
			},
		},
	);
	assert.equal(run.aborted, true);
	assert.match(run.reason, /fuera del alcance/);
	assert.equal(spawned, 0);
	assert.equal(run.results.length, 0);
	assert.match(summarizeSwarm(run), /abortado antes de lanzar nada/);
});

test("the concurrency cap is respected", async () => {
	let active = 0;
	let peak = 0;
	const run = await runSwarm(
		{ target: "https://a.acme.com", maxParallel: 2 },
		{
			checkTarget: async () => ({ ok: true }),
			run: async (role) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return outcome(role.role);
			},
		},
	);
	assert.equal(peak, 2);
	assert.equal(run.results.length, 4);
});

test("the cap is clamped to the hard maximum and to the role count", async () => {
	let peak = 0;
	let active = 0;
	await runSwarm(
		{ target: "https://a.acme.com", maxParallel: 99 },
		{
			checkTarget: async () => ({ ok: true }),
			run: async (role) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
				return outcome(role.role);
			},
		},
	);
	assert.equal(peak, 4, "four roles, so the cap cannot exceed four");
});

test("the fan-in keeps each child's identity and order", async () => {
	const run = await runSwarm(
		{ target: "https://a.acme.com", roles: [{ role: "authz", task: "mirar", tools: ["read"] }, { role: "schema", task: "mirar", tools: ["read"] }] },
		{ checkTarget: async () => ({ ok: true }), run: async (role) => ({ ...outcome(role.role), durationMs: role.role === "authz" ? 20 : 1 }) },
	);
	assert.equal(run.aborted, false);
	assert.deepEqual(run.results.map((result) => result.role), ["authz", "schema"]);
	const [first] = run.results;
	assert.equal(first?.status === "ran" ? first.sessionId : "", "S-authz");
	assert.equal(first?.status === "ran" ? first.invocationToken : "", "tok-authz");
	assert.match(summarizeSwarm(run), /token presente/);
});

test("a duplicated role is redundancy, and it is refused", async () => {
	await assert.rejects(
		() => runSwarm({ target: "https://a.acme.com", roles: [{ role: "authz", task: "x", tools: ["read"] }, { role: "authz", task: "y", tools: ["read"] }] }, { checkTarget: async () => ({ ok: true }), run: async (role) => outcome(role.role) }),
		/duplicated role/,
	);
});

test("a role that asks for a shell never starts", async () => {
	await assert.rejects(
		() => runSwarm({ target: "https://a.acme.com", roles: [{ role: "bad", task: "x", tools: ["bash"] }] }, { checkTarget: async () => ({ ok: true }), run: async (role) => outcome(role.role) }),
		/never receive|not in the bounty allowlist/,
	);
});

test("the aggregate budget stops launching and says which roles never ran", async () => {
	const launched: string[] = [];
	const run = await runSwarm(
		{ target: "https://a.acme.com", maxParallel: 1, budgetToolCalls: 100 },
		{
			checkTarget: async () => ({ ok: true }),
			run: async (role) => {
				launched.push(role.role);
				return { ...outcome(role.role), toolCalls: 60 };
			},
		},
	);
	assert.equal(run.stoppedByBudget, true);
	assert.equal(launched.length, 2);
	assert.equal(run.results.filter((result) => result.status === "skipped").length, 2);
});

test("a child over its own budget is reported, not trusted", async () => {
	const run = await runSwarm(
		{ target: "https://a.acme.com", roles: [{ role: "authz", task: "x", tools: ["read"] }], perAgentBudget: 5 },
		{ checkTarget: async () => ({ ok: true }), run: async (role) => ({ ...outcome(role.role), toolCalls: 9 }) },
	);
	const [first] = run.results;
	assert.equal(first?.status === "ran" ? first.ok : true, false);
	assert.match(first?.status === "ran" ? (first.error ?? "") : "", /presupuesto/);
});

test("one child failing does not kill the swarm", async () => {
	const run = await runSwarm(
		{ target: "https://a.acme.com", roles: ["a", "b", "c"].map((name) => ({ role: name, task: "x", tools: ["read"] })) },
		{
			checkTarget: async () => ({ ok: true }),
			run: async (role) => {
				if (role.role === "b") throw new Error("spawn failed");
				return outcome(role.role);
			},
		},
	);
	assert.equal(run.results.filter((result) => result.status === "ran" && result.ok).length, 2);
	const failed = run.results.find((result) => result.role === "b");
	assert.equal(failed?.status === "ran" ? failed.error : "", "spawn failed");
});

test("the task carries the target and the shared snapshot", () => {
	const spec = { role: "js-analyzer", task: SWARM_ROLES["js-analyzer"]?.brief ?? "", tools: SWARM_ROLES["js-analyzer"]?.tools ?? [] };
	const task = swarmTaskFor(spec, { program: "acme", scopePath: "/w/acme/scope.yaml", target: "https://a.acme.com", snapshot: renderSnapshot([ARTIFACT]) });
	assert.match(task, /Target de esta corrida: https:\/\/a\.acme\.com/);
	assert.match(task, /endpoint · https:\/\/a\.acme\.com\/api/);
	assert.match(task, /bounty_blackboard claim/);
	assert.match(task, /\{"role":"js-analyzer"/);
});

test("an empty snapshot says so instead of looking empty by accident", () => {
	assert.match(renderSnapshot([]), /no tiene artefactos/);
});
