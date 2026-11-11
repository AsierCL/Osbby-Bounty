/**
 * Toolchain contract marker. Imported by `tests/harness.test.ts` to prove that a `.ts` module with
 * typed exports imports and runs under `node --experimental-strip-types` on this host.
 */
export function harnessContract(): "ts-strip-types-ok" {
	return "ts-strip-types-ok";
}
