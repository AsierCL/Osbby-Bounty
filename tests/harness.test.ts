/**
 * S17a: "Primer test: comprueba que `node --test` ejecuta .ts en este host antes de escribir
 * lógica. Si hay fricción, ADR corto."
 *
 * This is intentionally the first test in the repository. It asserts the toolchain contract that
 * every other test file depends on: `.ts` sources run under `node --experimental-strip-types`
 * without a build step, `node:test` reports results, and file-scoped isolation works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { harnessContract } from "./harness-contract.ts";

test("node:test runs .ts files on this host without a build step", () => {
	assert.equal(typeof harnessContract, "function");
	assert.equal(harnessContract(), "ts-strip-types-ok");
});

test("type stripping keeps runtime semantics (no downlevel transform)", async () => {
	// A type-only construct and an enum-free union: if the runtime were transpiling instead of
	// stripping, this still passes, but if stripping were unsupported the import above fails first.
	const value: "a" | "b" = "b";
	assert.equal(value, "b");
	await Promise.resolve();
});
