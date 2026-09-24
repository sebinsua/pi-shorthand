/** Plain-text facts about a run, shared by what the model reads and what Pi shows. */
import type { FileChange, RunResult, RunTimings } from "../runner/runner.ts";

/** A failed program, a conflict or a rollback. Callers report the run as an error. */
export function runFailed(run: RunResult): boolean {
	return run.exitCode !== 0 || run.conflicts.length > 0 || run.rolledBack.length > 0;
}

const TIMING_LABELS: Record<keyof RunTimings, string> = {
	resolveRepositoryMs: "repository",
	waitForLockMs: "lock wait",
	workspaceSetupMs: "workspace setup",
	programMs: "program",
	scanChangesMs: "change scan",
	formatMs: "formatter",
	workspaceCloseMs: "workspace cleanup",
	checkConflictsMs: "conflict check",
	applyMs: "apply",
	renderDiffMs: "diff",
	unattributedMs: "other",
};

/** Explain calls exceeding the configured program budget, even when no individual phase does. */
export function timingBreakdown(run: RunResult): string | undefined {
	if (!run.timings || (run.diagnostics?.wallMs ?? run.durationMs) < timeoutBudgetMs(run)) return undefined;
	const significant = Object.entries(run.timings)
		.map(([phase, milliseconds]) => ({
			label: TIMING_LABELS[phase as keyof RunTimings],
			milliseconds,
		}))
		.filter(({ milliseconds }) => milliseconds > 0)
		.toSorted((a, b) => b.milliseconds - a.milliseconds);
	if (significant.length === 0) return undefined;
	return significant.map(({ label, milliseconds }) => `${label} ${formatDuration(milliseconds)}`).join(" · ");
}

function formatDuration(milliseconds: number): string {
	return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

/** e.g. "2s" or "2s plus 60.0s in helpers": helper time does not count toward the timeout. */
export function timeoutText(run: RunResult): string {
	const helpers = run.helperMs ? ` plus ${formatDuration(run.helperMs)} in helpers` : "";
	return `${run.timeoutMs / 1000}s${helpers}`;
}

/** The longest a run can take before its timeout, including excluded helper time. */
export function timeoutBudgetMs(run: RunResult): number {
	return run.timeoutMs + (run.helperMs ?? 0);
}

export function fileMetadataSummary(change: FileChange): string {
	if (change.beforeType && change.afterType && change.beforeType !== change.afterType) {
		return `${change.beforeType} → ${change.afterType}`;
	}
	if (change.afterType === "symlink" && change.beforeType !== "symlink") return "symlink";
	if (change.beforeMode !== undefined && change.afterMode !== undefined && change.beforeMode !== change.afterMode) {
		return `${change.beforeMode.toString(8)} → ${change.afterMode.toString(8)}`;
	}
	return "";
}

/** Added and removed lines in a patch. Only lines after the first "@@" count, not the ---/+++ headers. */
export function countLines(patch: string) {
	let additions = 0;
	let deletions = 0;
	let inHunks = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) inHunks = true;
		else if (inHunks && line.startsWith("+")) additions++;
		else if (inHunks && line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}
