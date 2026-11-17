/**
 * S103: `--extend-budget <programa> --calls N [--hours H]` — raise the policy and clear the seal.
 *
 * The limits live in `.bounty/config.json` (operator-owned); this command edits them and then restarts
 * the counters through the same path as `--restart-limits`, so the chain records the change. The agent
 * still cannot raise its own budget: it is a CLI action.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { restartLimits } from "./restart-limits.ts";

export async function extendBudget(options: { root: string; program: string; calls?: number; hours?: number; now?: () => number }) {
	const path = join(options.root, ".bounty", "config.json");
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		config = {};
	}
	const budget = { ...((config.budget as Record<string, unknown> | undefined) ?? {}) };
	if (options.calls !== undefined) budget.max_tool_calls = options.calls;
	if (options.hours !== undefined) budget.max_duration_hours = options.hours;
	config.budget = budget;
	await writeFile(path, `${JSON.stringify(config, null, 1)}\n`, "utf8");
	return { budget, restart: await restartLimits(options.root, options.program, options.now) };
}

const [root, ...rest] = process.argv.slice(2);
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	const flag = (name: string): string | undefined => {
		const index = rest.indexOf(name);
		return index >= 0 ? rest[index + 1] : undefined;
	};
	const program = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : undefined;
	const calls = flag("--calls");
	const hours = flag("--hours");
	if (root === undefined || program === undefined || (calls === undefined && hours === undefined)) {
		console.error("usage: extend-budget.ts <root> <programa> --calls N [--hours H]");
		process.exit(2);
	}
	const result = await extendBudget({
		root,
		program,
		...(calls === undefined ? {} : { calls: Number(calls) }),
		...(hours === undefined ? {} : { hours: Number(hours) }),
	});
	console.log(`${program}: límites ahora ${JSON.stringify(result.budget)}; ${result.restart.reset ? "contadores reiniciados y sello limpio" : "no había estado, nada que reiniciar"}.`);
}
