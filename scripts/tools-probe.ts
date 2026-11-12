/**
 * Live tool-list probe (S34). Loaded with the main-session launcher; on the first model turn it writes
 * the tools Pi actually enabled to GENTLE_BOUNTY_PROBE_FILE. The report inspects that file instead of
 * asking the model what tools it has.
 */
import { writeFileSync } from "node:fs";

interface ProbeApi {
	on(event: "before_agent_start", handler: (event: { systemPromptOptions?: { selectedTools?: string[] } }) => void): void;
}

export default function toolsProbe(pi: ProbeApi): void {
	pi.on("before_agent_start", (event) => {
		const file = process.env.GENTLE_BOUNTY_PROBE_FILE;
		if (!file) return;
		const tools = event.systemPromptOptions?.selectedTools ?? [];
		writeFileSync(file, JSON.stringify({ tools, at: new Date().toISOString(), env: { program: process.env.GENTLE_BOUNTY_PROGRAM ?? null } }, null, "\t"));
	});
}
