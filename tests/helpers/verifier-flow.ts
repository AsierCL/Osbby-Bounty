/**
 * D1 helper: simulates the verifier session honestly — it runs its own bounty_run (so the chain has an
 * execution with the verifier's session id) and then applies the verdict through the code path.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidenceStore } from "../../src/core/evidence.ts";
import { createSession, type ProgramSession } from "../../src/pi/session.ts";

export async function verifyFinding(input: {
	root: string;
	program: string;
	findingId: string;
	endpoint: string;
	target: string;
	/** The scope file the verifier session loads. */
	scopePath: string;
}): Promise<{ applied: Awaited<ReturnType<ProgramSession["applyVerifierVerdict"]>>; verifierSessionId: string; seq: number }> {
	const deps = {
		dns: async () => ({ cname: [] }),
		readFile: (path: string) => readFile(path, "utf8"),
		runTool: async () => ({ exitCode: 0, stdout: "HTTP 200\n{\"owner\":\"bob\"}", stderr: "" }),
		confirm: async () => true,
	};
	const verifier = createSession({ root: input.root, program: input.program, sessionId: "verifier-session" }, deps);
	await verifier.scope({ file: input.scopePath, confirm: async () => true });
	await verifier.run({ tool: "curl", args: ["-sS", input.target], target: input.target });

	const records = await createEvidenceStore(join(input.root, "work", input.program, "evidence"), { now: () => Date.now() }).read();
	const mine = records.filter((record) => record.kind === "execution" && (record.payload as { sessionId?: string }).sessionId === "verifier-session");
	const seq = mine[mine.length - 1]?.seq ?? 0;

	const applied = await verifier.applyVerifierVerdict({
		findingId: input.findingId,
		verdict: "REPRODUCIDO",
		seqs: [seq],
		reason: "reproducido dos veces",
		verifierSessionId: "verifier-session",
	});
	return { applied, verifierSessionId: "verifier-session", seq };
}
