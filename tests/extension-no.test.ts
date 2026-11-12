/**
 * S43: answered no. See tests/helpers/extension-scenario.ts for why each answer is its own file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runScenario } from "./helpers/extension-scenario.ts";

test("answered no: the destructive command never runs and the pause is visible", async () => {
	const outcome = await runScenario(false);
	const destructive = outcome.questions.filter((question) => /destructiva/i.test(question));
	assert.equal(destructive.length, 1, "the human must be asked exactly once about the destructive action");
	assert.match(destructive[0] ?? "", /brute-force/);
	assert.equal(outcome.executed, false, "the binary ran even though the human said no");
	assert.match(outcome.result.content[0]?.text ?? "", /clase destructiva/);
	assert.match(outcome.status, /destructiva necesita tu OK explícito/);
});
