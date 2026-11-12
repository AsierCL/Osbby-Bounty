/**
 * S43: answered yes. See tests/helpers/extension-scenario.ts for why each answer is its own file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runScenario } from "./helpers/extension-scenario.ts";

test("answered yes: the destructive command runs", async () => {
	const outcome = await runScenario(true);
	assert.equal(outcome.questions.filter((question) => /destructiva/i.test(question)).length, 1);
	assert.equal(outcome.executed, true, "the binary did not run even though the human said yes");
	assert.match(outcome.result.content[0]?.text ?? "", /hydra/);
});
