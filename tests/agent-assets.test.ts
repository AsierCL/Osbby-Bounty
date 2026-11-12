/**
 * S41: the allowlist an agent asset declares must be a subset of what the runner permits, and must
 * never contain a shell, fetch or write capability. This is the deterministic half of the subagent
 * verification; the live half is docs/evidence/subagent-tools.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ALLOWED_CHILD_TOOLS, validateTools } from "../src/pi/runner.ts";

const AGENTS_DIR = new URL("../assets/agents/", import.meta.url).pathname;
const FORBIDDEN = /bash|shell|exec|terminal|fetch|http|web|curl|wget|write|edit|\*/i;

async function agentAssets(): Promise<{ name: string; tools: string[] }[]> {
	const files = (await readdir(AGENTS_DIR)).filter((file) => file.endsWith(".md"));
	const agents: { name: string; tools: string[] }[] = [];
	for (const file of files) {
		const text = await readFile(join(AGENTS_DIR, file), "utf8");
		const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? file;
		const tools = (/^tools:\s*(.+)$/m.exec(text)?.[1] ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
		agents.push({ name, tools });
	}
	return agents;
}

test("every agent asset declares a non-empty tool list", async () => {
	const agents = await agentAssets();
	assert.ok(agents.length >= 5, `esperaba al menos 5 agentes, encontré ${agents.length}`);
	for (const agent of agents) assert.ok(agent.tools.length > 0, `${agent.name} has no tools`);
});

test("no agent asset declares a shell, fetch, write or wildcard tool", async () => {
	for (const agent of await agentAssets()) {
		for (const tool of agent.tools) {
			assert.ok(!FORBIDDEN.test(tool), `${agent.name} declares ${tool}`);
		}
	}
});

test("every tool an asset declares survives the runner's validator", async () => {
	for (const agent of await agentAssets()) {
		assert.doesNotThrow(() => validateTools(agent.tools), `${agent.name} has a tool the runner rejects`);
	}
});

test("the bounty-verify agent can reproduce but cannot write", async () => {
	const agents = await agentAssets();
	const verify = agents.find((agent) => agent.name === "bounty-verify");
	assert.ok(verify, "bounty-verify asset is missing");
	assert.ok(verify?.tools.includes("bounty_run"), "the verifier needs bounty_run to reproduce");
	assert.ok(!verify?.tools.some((tool) => /write|edit/i.test(tool)));
	assert.ok((verify?.tools ?? []).every((tool) => (ALLOWED_CHILD_TOOLS as readonly string[]).includes(tool)));
});
