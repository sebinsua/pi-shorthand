/**
 * Program time for the timeout. Shorthand's helpers (edit, glob, grep, sg, grit, refactor) do work that scales
 * with the repository, such as parsing every file in scope or starting a language server, so time inside
 * them pauses the clock. The pause is capped: a helper that never returns still times out, at most
 * `allowanceMs` after the program's own timeout.
 */

/** The most helper time one run may exclude from its timeout. */
export const HELPER_ALLOWANCE_MS = 60_000;

export class ProgramClock {
	private readonly startedAt: number;
	private readonly running = new Set<number>();
	private pausedSince: number | undefined;
	private pausedMs = 0;

	constructor(
		private readonly allowanceMs = HELPER_ALLOWANCE_MS,
		private readonly now = () => performance.now(),
	) {
		this.startedAt = now();
	}

	helperStarted(id: number): void {
		if (this.running.size === 0) this.pausedSince = this.now();
		this.running.add(id);
	}

	helperFinished(id: number): void {
		if (!this.running.delete(id) || this.running.size > 0) return;
		this.pausedMs += this.now() - this.pausedSince!;
		this.pausedSince = undefined;
	}

	/** Helper time excluded so far; overlapping helpers count once. */
	excludedMs(): number {
		const current = this.pausedSince === undefined ? 0 : this.now() - this.pausedSince;
		return Math.min(this.allowanceMs, this.pausedMs + current);
	}

	/** Time that counts toward the timeout. */
	elapsedMs(): number {
		return this.now() - this.startedAt - this.excludedMs();
	}
}
