/**
 * Emergency stop (S37).
 *
 * "Stop" has to mean the processes are gone, not that a flag was flipped. This controller keeps the
 * children spawned for bounty_run, kills them on request, and records that it happened so the
 * evidence store can prove the run ended. It never touches the evidence it already wrote: that is
 * the point of the append-only chain.
 */

export interface StoppableChild {
	pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface StopResult {
	stopped: boolean;
	killed: number;
	at: string;
}

export interface StopController {
	/** Registers a child; returns a disposer to call when it exits. */
	register(child: StoppableChild): () => void;
	stop(reason: string): StopResult;
	isStopped(): boolean;
	reason(): string | null;
	live(): number;
}

export function createStopController(deps: { now?: () => number; kill?: (pid: number) => boolean } = {}): StopController {
	const now = deps.now ?? (() => Date.now());
	const children = new Set<StoppableChild>();
	let stopped = false;
	let stopReason: string | null = null;

	return {
		register(child) {
			children.add(child);
			return () => children.delete(child);
		},

		stop(reason) {
			const at = new Date(now()).toISOString();
			stopped = true;
			stopReason = reason;
			let killed = 0;
			for (const child of children) {
				try {
					if (child.kill("SIGKILL")) killed += 1;
				} catch {
					// A child that already exited is not a failure to stop.
				}
			}
			children.clear();
			return { stopped: true, killed, at };
		},

		isStopped: () => stopped,
		reason: () => stopReason,
		live: () => children.size,
	};
}
