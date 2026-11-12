/**
 * S43: the confirmation answer source, and the two-key gate on the test stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfirm } from "../src/pi/confirm.ts";

test("the live UI callback wins when it exists", async () => {
	const resolution = resolveConfirm({ env: {}, uiConfirm: async () => true });
	assert.equal(resolution.source, "ui");
	assert.equal(await resolution.confirm("¿dale?"), true);
});

test("no UI and no stub means no", async () => {
	const resolution = resolveConfirm({ env: {}, uiConfirm: undefined });
	assert.equal(resolution.source, "none");
	assert.equal(await resolution.confirm("¿dale?"), false);
});

test("the stub needs both environment variables and a lab scope", async () => {
	const onlyMode = resolveConfirm({ env: { GENTLE_BOUNTY_CONFIRM_TEST: "yes" } as NodeJS.ProcessEnv });
	assert.equal(onlyMode.source, "none");
	const onlyAllow = resolveConfirm({ env: { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1" } as NodeJS.ProcessEnv });
	assert.equal(onlyAllow.source, "none");
	const both = resolveConfirm({
		env: { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1", GENTLE_BOUNTY_CONFIRM_TEST: "yes" } as NodeJS.ProcessEnv,
		uiConfirm: async () => false,
		lab: true,
	});
	assert.equal(both.source, "stub-yes");
	assert.equal(await both.confirm("¿dale?"), true);
});

test("the stub can answer no too", async () => {
	const resolution = resolveConfirm({
		env: { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1", GENTLE_BOUNTY_CONFIRM_TEST: "no" } as NodeJS.ProcessEnv,
		lab: true,
	});
	assert.equal(resolution.source, "stub-no");
	assert.equal(await resolution.confirm("¿dale?"), false);
});

test("an unknown stub value falls back to the UI rule", async () => {
	const resolution = resolveConfirm({
		env: { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1", GENTLE_BOUNTY_CONFIRM_TEST: "maybe" } as NodeJS.ProcessEnv,
	});
	assert.equal(resolution.source, "none");
});

test("S47: the stub is refused outside a lab scope, and says so", async () => {
	const env = { GENTLE_BOUNTY_ALLOW_CONFIRM_STUB: "1", GENTLE_BOUNTY_CONFIRM_TEST: "yes" } as NodeJS.ProcessEnv;
	for (const lab of [false, undefined]) {
		const resolution = resolveConfirm({ env, lab, uiConfirm: async () => false });
		assert.equal(resolution.stubRequested, true);
		assert.equal(resolution.source, "ui", "an explicit UI callback must win over a refused stub");
		assert.equal(await resolution.confirm("¿dale?"), false, "the refused stub must never answer yes");
	}
	const noUi = resolveConfirm({ env, lab: false });
	assert.equal(noUi.source, "none");
	assert.equal(await noUi.confirm("¿dale?"), false);
});
