/**
 * Where the answer to a destructive confirmation comes from (S43).
 *
 * Production order: the live Pi UI callback, else "no". There is a test affordance gated by TWO
 * environment variables, because an auto-approve switch in a safety tool is exactly the kind of thing
 * that ends up set in production by accident:
 *
 *   GENTLE_BOUNTY_ALLOW_CONFIRM_STUB=1  (explicit opt-in to the stub mechanism)
 *   GENTLE_BOUNTY_CONFIRM_TEST=yes|no   (the deterministic answer)
 *
 * The extension logs every stubbed answer loudly, and docs/DEUDA.md says never to set it against a
 * real program.
 */

export type ConfirmFn = (question: string) => Promise<boolean>;

export type ConfirmSource = "ui" | "stub-yes" | "stub-no" | "none";

export interface ConfirmResolution {
	confirm: ConfirmFn;
	source: ConfirmSource;
	/** True when the stub variables are present, even if the stub was refused. */
	stubRequested: boolean;
}

export function resolveConfirm(options: {
	env?: NodeJS.ProcessEnv;
	uiConfirm?: ConfirmFn;
	/** S47: the stub only answers inside a scope the operator declared as `lab: true`. */
	lab?: boolean;
}): ConfirmResolution {
	const env = options.env ?? process.env;
	const allowStub = env.GENTLE_BOUNTY_ALLOW_CONFIRM_STUB === "1";
	const mode = env.GENTLE_BOUNTY_CONFIRM_TEST;
	const stubRequested = allowStub && (mode === "yes" || mode === "no");
	if (stubRequested && options.lab !== true) {
		// The stub was asked for outside a lab: refuse loudly and fall through to the safe path.
		console.error("[gentle-bounty] stub de confirmación RECHAZADO: el scope no está marcado como lab: true");
	}
	if (stubRequested && options.lab === true) {
		return {
			stubRequested: true,
			source: mode === "yes" ? "stub-yes" : "stub-no",
			confirm: async (question: string) => {
				console.error(`[gentle-bounty] respuesta de confirmación provista por STUB (${mode}): ${question}`);
				return mode === "yes";
			},
		};
	}
	if (typeof options.uiConfirm === "function") return { confirm: options.uiConfirm, source: "ui", stubRequested };
	// No UI means no answer, and no answer means no.
	return { confirm: async () => false, source: "none", stubRequested };
}
