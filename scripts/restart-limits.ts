/**
 * S102: `--restart-limits <programa>` — the operator's clean way to restart the clock and the counters.
 *
 * It resets the *usage* (tool calls, tokens, start time, the seal), never the policy: the limits still
 * come from `.bounty/config.json`, so raising them stays a separate, explicit edit. The reset is
 * appended to the evidence chain as a `budget-reset` event with the previous usage, so the accounting
 * change is not silent.
 *
 * Usage: node --experimental-strip-types scripts/restart-limits.ts <root> <programa>|--all
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { createStatusStore } from "../src/core/status.ts";

export interface RestartResult {
	program: string;
	previous: { toolCalls: number; tokens: number; startedAt: string; limitHit: string | null } | null;
	reset: boolean;
}

export async function restartLimits(root: string, program: string, now: () => number = () => Date.now()): Promise<RestartResult> {
	const workDir = join(root, "work", program);
	let state: { budget?: RestartResult["previous"] };
	try {
		state = JSON.parse(await readFile(join(workDir, "state.json"), "utf8"));
	} catch {
		return { program, previous: null, reset: false };
	}
	const previous = state.budget ?? null;
	const status = createStatusStore({ workDir, program, now });
	const current = await status.read();
	current.budget = { toolCalls: 0, tokens: 0, startedAt: new Date(now()).toISOString(), limitHit: null };
	await status.write(current);
	const evidence = createEvidenceStore(join(workDir, "evidence"), { now });
	await evidence.append({
		kind: "budget-reset",
		payload: { at: new Date(now()).toISOString(), previous, by: "operator", via: "--restart-limits" },
	});
	return { program, previous, reset: true };
}

const [root, target] = process.argv.slice(2);
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain && (root === undefined || target === undefined)) {
	console.error("usage: restart-limits.ts <root> <programa>|--all");
	process.exit(2);
}
const programs = isMain ? (target === "--all" ? await readdir(join(root, "work")).catch(() => [] as string[]) : [target ?? ""]) : [];
for (const program of programs) {
	const result = await restartLimits(root, program);
	if (!result.reset) {
		console.log(`${program}: no existe work/${program}/state.json, no toco nada.`);
		continue;
	}
	const previous = result.previous;
	console.log(
		`${program}: presupuesto reiniciado. Antes: ${previous?.toolCalls ?? 0} llamadas, ${previous?.tokens ?? 0} tokens, arranque ${previous?.startedAt ?? "—"}, sello ${previous?.limitHit ?? "ninguno"}. Ahora: 0 / 0 / arranque nuevo. Los límites siguen saliendo de .bounty/config.json.`,
	);
}
