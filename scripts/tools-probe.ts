/**
 * Live tool-list probe (S34). Loaded with the main-session launcher; on the first model turn it writes
 * the tools Pi actually enabled to GENTLE_BOUNTY_PROBE_FILE.
 *
 * Output path is always work/<program>/probe-tools.json. An earlier launcher version pointed the
 * output at this file and the probe overwrote its own source during a smoke run; the launcher now
 * refuses that path and asserts the separation.
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
