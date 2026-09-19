/**
 * How a code call looks in Pi. (The model gets a separate plain-text version: see textForModel.)
 *
 * A verdict line first, whose colour carries the outcome. Lines indented under it belong to it: what
 * went wrong, or what to watch out for. A blank line starts a new section. The sections come in the
 * order that matters for the outcome: on success the diff (the point of the tool), then the output;
 * on failure the output, then what would have changed; for an exploration, just the output.
 */

import { keyHint, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import type { FileChange, RunResult } from "./runner.ts";

const OUTPUT_PREVIEW_LINES = 5; // like Pi's bash tool
const INLINE_DIFF_LINES = 40; // a longer diff collapses to a list of its files…
const LISTED_FILES = 8; // …showing this many, then "and N more files"
const EXPANDED_DIFF_LINES = 2000; // even expanded, a diff of hundreds of files stops here

export function callLine(args: { title?: string; timeout?: number; rollback?: string }, theme: Theme): string {
	const settings = [args.rollback === "file" && "rollback per file", args.timeout && `timeout ${args.timeout}s`];
	const suffix = settings.filter(Boolean).join(", ");
	return `${theme.fg("toolTitle", theme.bold("code"))} ${args.title ?? ""}${suffix ? theme.fg("muted", ` (${suffix})`) : ""}`;
}

/** Lines that belong to the verdict line above them. */
function indent(line: string): string {
	return `  ${line}`;
}

export function resultLines(run: RunResult, expanded: boolean, theme: Theme): string[] {
	const applied = run.changes.filter((change) => run.applied.includes(change.path));
	const notApplied = run.changes.filter(
		(change) => !run.applied.includes(change.path) && !run.rolledBack.includes(change.path),
	);
	const outputLinesAll = run.output.split("\n");
	const printedWarnings = outputLinesAll.filter((line) => line.startsWith("warning: ")).map((line) => line.slice(9));
	const output = outputLinesAll
		.filter((line) => !line.startsWith("warning: "))
		.join("\n")
		.trim();

	// The verdict, and what belongs to it.
	const lines = [verdict(run, applied, theme)];
	const error = run.exitCode !== 0 && !run.timedOut ? errorMessage(run.output) : undefined;
	if (error) lines.push(indent(theme.fg("error", error)));
	if (error && run.errorLine) lines.push(indent(theme.fg("muted", shorten(run.errorLine, 88))));
	for (const file of run.conflicts) lines.push(indent(theme.fg("error", `changed while running: ${file}`)));
	// A command still running is what it was stuck on; otherwise the last step it logged is a clue.
	for (const command of run.stillRunning) lines.push(indent(theme.fg("warning", `stuck on $ ${command}`)));
	if (run.timedOut && run.stillRunning.length === 0 && run.lastStep) {
		lines.push(indent(theme.fg("warning", `last step: ${run.lastStep}`)));
	}
	for (const file of run.rolledBack) {
		lines.push(indent(theme.fg("warning", `rolled back ${file}: half-written when the program was killed`)));
	}
	for (const warning of [...run.warnings, ...printedWarnings]) lines.push(indent(theme.fg("warning", `⚠ ${warning}`)));

	// The sections, each after a blank line.
	const sections: string[][] = [];
	if (applied.length > 0) sections.push(diffLines(applied, expanded, theme));
	if (output && (expanded || !error)) sections.push(outputLines(output, expanded, run.changes.length > 0, theme));
	if (notApplied.length > 0) sections.push(notAppliedLines(notApplied, expanded, theme));
	for (const section of sections) lines.push("", ...section);
	return lines;
}

/** e.g. "✓ Applied 3 files · +6 −6 · 0.6s" or "✕ Failed · rolled back all changes · exit 1 · 0.2s" */
function verdict(run: RunResult, applied: FileChange[], theme: Theme): string {
	const muted = (text: string) => theme.fg("muted", text);
	const took = muted(` · ${(run.durationMs / 1000).toFixed(1)}s`);
	const failure = run.timedOut ? `Timed out after ${run.timeoutMs / 1000}s` : "Failed";
	const exit = run.timedOut ? "" : muted(` · exit ${run.exitCode}`);

	if (run.conflicts.length > 0) {
		const program = run.timedOut
			? ` · timed out after ${run.timeoutMs / 1000}s`
			: run.exitCode
				? ` · exit ${run.exitCode}`
				: "";
		const application = applied.length === 0 ? "nothing applied" : `${fileCount(applied)} applied`;
		return theme.fg("error", `✕ Conflict · ${application}${program}`) + took;
	}
	if (run.exitCode === 0 && run.changes.length === 0) return theme.fg("success", "✓ No changes") + took;
	if (run.exitCode === 0) {
		return theme.fg("success", `✓ Applied ${fileCount(applied)}`) + ` · ${stats(applied, theme)}` + took;
	}
	if (applied.length > 0) {
		const rolledBack = run.rolledBack.length > 0 ? `, rolled back ${run.rolledBack.length}` : "";
		const kept = theme.fg("warning", `⚠ ${failure} · kept ${fileCount(applied)}${rolledBack}`);
		return kept + ` · ${stats(applied, theme)}` + exit + took;
	}
	const undone =
		run.changes.length === 0 ? "no changes" : run.rollback === "all" ? "rolled back all changes" : "nothing to keep";
	return theme.fg("error", `✕ ${failure} · ${undone}`) + exit + took;
}

/** The error Bun printed, e.g. "expected 1 match, found 3" (or "TypeError: …"). */
function errorMessage(output: string): string | undefined {
	const line = output.split("\n").findLast((candidate) => /^(error|\w*Error): /.test(candidate));
	return line?.replace(/^error: /, "");
}

/** The last few lines, like Pi's bash tool; all of it when expanded. Labelled when not alone. */
function outputLines(output: string, expanded: boolean, labelled: boolean, theme: Theme): string[] {
	const lines = output.split("\n").map((line) => theme.fg("toolOutput", line));
	const label = labelled ? [theme.fg("muted", "Program output")] : [];
	if (expanded || lines.length <= OUTPUT_PREVIEW_LINES) return [...label, ...lines];

	const earlier = lines.length - OUTPUT_PREVIEW_LINES;
	const hint =
		theme.fg("muted", `… ${earlier} earlier lines (`) +
		keyHint("app.tools.expand", "to expand") +
		theme.fg("muted", ")");
	return [...label, hint, ...lines.slice(-OUTPUT_PREVIEW_LINES)];
}

/** Each file's diff under its name, in Pi's own diff style. A long diff collapses to a list of files. */
function diffLines(changes: FileChange[], expanded: boolean, theme: Theme): string[] {
	const files = changes.map((change) => [fileLine(change, theme), ...renderDiff(toPiDiff(change.patch)).split("\n")]);
	const total = files.reduce((sum, file) => sum + file.length, 0);
	if (!expanded && total > INLINE_DIFF_LINES) {
		return [...fileList(changes, theme), theme.fg("muted", `(${keyHint("app.tools.expand", "to see the diff")})`)];
	}

	const lines = files.flatMap((file, index) => (index === 0 ? file : ["", ...file]));
	if (lines.length <= EXPANDED_DIFF_LINES) return lines;
	const more = lines.length - EXPANDED_DIFF_LINES;
	return [...lines.slice(0, EXPANDED_DIFF_LINES), theme.fg("muted", `… ${more} more lines of diff`)];
}

function notAppliedLines(changes: FileChange[], expanded: boolean, theme: Theme): string[] {
	const heading = theme.fg("muted", `Would have changed ${fileCount(changes)} · `) + stats(changes, theme);
	if (expanded) return [heading, "", ...diffLines(changes, true, theme)];
	return [heading + theme.fg("muted", ` (${keyHint("app.tools.expand", "to see the diff")})`)];
}

/** The first few files, then how many more. */
function fileList(changes: FileChange[], theme: Theme): string[] {
	const listed = changes.slice(0, LISTED_FILES).map((change) => fileLine(change, theme));
	const more = changes.length - LISTED_FILES;
	return more > 0 ? [...listed, theme.fg("muted", `… and ${more} more files`)] : listed;
}

/** e.g. "src/a.ts +3 −1", or "src/new.ts (new) +12 −0" */
function fileLine(change: FileChange, theme: Theme): string {
	const kind = change.kind === "modified" ? "" : theme.fg("muted", change.kind === "added" ? " (new)" : " (deleted)");
	return `${theme.fg("accent", change.path)}${kind} ${stats([change], theme)}`;
}

/** "+6 −2", in the diff colours. */
function stats(changes: FileChange[], theme: Theme): string {
	const counts = changes.map((change) => countLines(change.patch));
	const additions = counts.reduce((sum, count) => sum + count.additions, 0);
	const deletions = counts.reduce((sum, count) => sum + count.deletions, 0);
	return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `−${deletions}`)}`;
}

/** Cut to fit on one line, since a wrapped line loses its indentation. The full text is in the output. */
function shorten(text: string, length: number): string {
	return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function fileCount(changes: FileChange[]): string {
	return changes.length === 1 ? "1 file" : `${changes.length} files`;
}

/**
 * Converts a git-style patch to the format Pi's renderDiff reads: "+12 added", "-12 removed",
 * " 12 context", and "     ..." between hunks. Removed and context lines use old line numbers.
 */
function toPiDiff(patch: string): string {
	if (patch.includes("\nBinary file changed")) return " binary file changed";
	const lastLines = [...patch.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gm)].flatMap((hunk) => [
		Number(hunk[1]) + Number(hunk[2]),
		Number(hunk[3]) + Number(hunk[4]),
	]);
	const width = String(Math.max(1, ...lastLines)).length;
	const number = (n: number | string) => String(n).padStart(width, " ");

	const out: string[] = [];
	let inHunks = false; // skips the headers before the first hunk
	let oldLine = 0;
	let newLine = 0;
	for (const line of patch.split("\n")) {
		const hunk = line.match(/^@@ -(\d+),\d+ \+(\d+),\d+ @@/);
		if (hunk) {
			if (inHunks) out.push(` ${number("")} ...`);
			inHunks = true;
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
		} else if (!inHunks) {
			continue;
		} else if (line.startsWith("+")) {
			out.push(`+${number(newLine++)} ${line.slice(1)}`);
		} else if (line.startsWith("-")) {
			out.push(`-${number(oldLine++)} ${line.slice(1)}`);
		} else if (line.startsWith(" ")) {
			out.push(` ${number(oldLine++)} ${line.slice(1)}`);
			newLine++;
		}
	}
	return out.join("\n");
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
