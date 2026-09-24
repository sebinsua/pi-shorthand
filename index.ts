/**
 * The `code` tool: the model writes one Bun program that makes a multi-step change to the repository.
 * Its writes go to a copy-on-write overlay; if it succeeds, they're applied and the diff is returned.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type Theme, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	callLine,
	countLines,
	fileMetadataSummary,
	resultLines,
	timeoutBudgetMs,
	timingBreakdown,
	unstructuredResultText,
} from "./display.ts";
import type { FileChange, RunOptions, RunResult } from "./runner.ts";
import { type Diagnostics, completeDiagnostics, diagnosticLines } from "./diagnostics.ts";
import { modelDiff } from "./model-diff.ts";

class RunnerError extends Error {
	constructor(
		message: string,
		readonly diagnostics: Diagnostics,
	) {
		super(message);
	}
}

// Runs typically take well under a second. Longer transformations can request more time.
const DEFAULT_TIMEOUT_SECONDS = 2;

const DESCRIPTION = `Edit repository files with a TypeScript program run by Bun. Best for changes across many files, repeated edits and semantic TypeScript renames or moves; a small change to one file is quicker as a direct edit. Top-level await and ordinary Bun/Node APIs work. Use repository-relative paths. Set cwd to a checkout path when Pi's working directory is outside the repository, such as a child worktree in a bare worktree container. The program runs in an isolated workspace; changes apply on successful exit by default and the tool reports the diff. Run tests, type-checks and builds separately afterward with the shell tool.

Common operations:
- edit({ path, oldText, newText }) replaces exactly one literal occurrence; missing or ambiguous text is an error. Use text edits for known source, structural matching when it saves enumerating occurrences or preserves varying syntax.
- await Bun.file(path).text(); await Bun.write(path, text)
- sg.rewrite(pattern, replacement, files?) discovers and rewrites matching code; omit files for the working directory. $X captures one node; $$$X captures a sequence.
- sg.one(pattern, files?) selects exactly one match; sg.find returns an array. sg.rewrite also accepts a selected match or array without a file scope.
- A rewrite callback receives a match and returns text, a native node.replace(text) edit, or null to skip. Return native edits to apply them. Pass selected arrays together for independent edits; select again after changing their file.
- await refactor.rename({ file, symbol, to }) renames one resolved TypeScript symbol across the project without changing unrelated names.
- await refactor.renameFile({ from, to }) moves a TypeScript file and updates module paths that resolve to it.
- sg.move(declaration, { endOf: sg.file(path) }) moves a top-level declaration to another file and updates imports that follow it.

See the shorthand skill for renames, moves and call-site migrations. Read its advanced-refactors.md guide only to extract code, move syntax, use GritQL or edit other languages. The default timeout is two seconds; request more for longer programs. Time spent inside the helpers above does not count toward it, up to 60 extra seconds.`;

export default function (pi: ExtensionAPI) {
	// A failed run is an error, both for the model and for how Pi shows it. (execute() returns its details
	// rather than throwing, since a thrown error loses them.)
	pi.on("tool_result", async (event) => {
		const run = event.details as RunResult | undefined;
		if (
			event.toolName === "code" &&
			run &&
			(run.exitCode !== 0 || run.conflicts.length > 0 || run.rolledBack.length > 0)
		)
			return { isError: true };
	});

	pi.registerTool({
		name: "code",
		label: "Code",
		description: DESCRIPTION,
		promptSnippet:
			"Make multi-file, repetitive or rename/move changes with one Bun program; a small change to one file is quicker as a direct edit. Run verification separately afterward",

		parameters: Type.Object({
			title: Type.String({ description: "A few words describing the change, shown to the user" }),
			program: Type.String({ description: "TypeScript program run with Bun (top-level await allowed)" }),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the program; relative to Pi's working directory, or an absolute path. Defaults to Pi's working directory. Must be inside a git worktree.",
				}),
			),
			rollback: Type.Optional(
				StringEnum(["all", "file"] as const, {
					description:
						'On failure: "file" (default) rolls back failed or interrupted file edits and retains the others; "all" applies nothing',
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Seconds of program time before it is killed (default 2); time inside helpers is excluded",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// While it runs, show how long it's been going and the latest reported step.
			const startedAt = Date.now();
			let latest: string | undefined;
			const progress = setInterval(() => {
				const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { progress: latest ? `${elapsed} · ${latest}` : elapsed },
				});
			}, 500);

			let result: RunResult;
			try {
				result = await runWithBun(
					{
						cwd: path.resolve(ctx.cwd, params.cwd ?? "."),
						program: params.program,
						timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
						rollback: params.rollback ?? "file",
					},
					signal,
					(step) => (latest = step),
				);
			} catch (error) {
				if (!(error instanceof RunnerError)) throw error;
				return {
					isError: true,
					content: [{ type: "text" as const, text: [error.message, ...diagnosticLines(error.diagnostics)].join("\n") }],
					details: { infrastructureError: error.message, diagnostics: error.diagnostics },
				};
			} finally {
				clearInterval(progress);
			}
			return {
				content: [{ type: "text", text: textForModel(result, toolCallId) }],
				details: result,
			};
		},

		renderCall(args, theme) {
			return new Text(callLine(args, theme), 0, 0);
		},

		renderResult(result, options, theme) {
			return renderCodeResult(result, options, theme);
		},
	});
}

export function renderCodeResult(
	result: { content: readonly unknown[]; details?: unknown },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text {
	if (isPartial) {
		const progress = (result.details as { progress?: string } | undefined)?.progress;
		return new Text(theme.fg("muted", progress ? `running… ${progress}` : "running…"), 0, 0);
	}
	if (result.details && typeof result.details === "object" && "infrastructureError" in result.details) {
		const failure = result.details as { infrastructureError: string; diagnostics: Diagnostics };
		return new Text(
			[
				theme.fg("error", failure.infrastructureError),
				"",
				...diagnosticLines(failure.diagnostics).map((line) => theme.fg("muted", line)),
			].join("\n"),
			0,
			0,
		);
	}
	const run = result.details as RunResult | undefined;
	if (!run) return new Text(theme.fg("error", unstructuredResultText(result.content)), 0, 0);
	return new Text(resultLines(run, expanded, theme).join("\n"), 0, 0);
}

/**
 * Pi runs extensions in Node, so the work happens in a Bun process (runner.ts). On abort it's asked
 * to stop (it then puts the repository back and applies nothing). It has its own process group,
 * which is killed afterwards so no subprocess the program started is left behind.
 */
export function runWithBun(
	options: RunOptions,
	signal?: AbortSignal,
	onProgress?: (step: string) => void,
): Promise<RunResult> {
	const startedAt = performance.now();
	let firstEventAt: number | undefined;
	let diagnostics: Diagnostics = { spans: [], counters: {} };
	const finishDiagnostics = () => {
		const now = performance.now();
		return completeDiagnostics(diagnostics, now - startedAt, (firstEventAt ?? now) - startedAt);
	};
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const runner = spawn("bun", [path.join(import.meta.dirname, "runner.ts")], {
			detached: true,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		const stop = () => runner.kill("SIGTERM");
		signal?.addEventListener("abort", stop);

		let stdout = "";
		let stderr = "";
		runner.stdout.setEncoding("utf8"); // so a multi-byte character split across chunks decodes intact
		runner.stderr.setEncoding("utf8");
		runner.stdout.on("data", (chunk) => (stdout += chunk));
		runner.stderr.on("data", (chunk) => (stderr += chunk));
		let progressBuffer = "";
		const progress = runner.stdio[3] as Readable;
		progress.setEncoding("utf8");
		progress.on("data", (chunk) => {
			progressBuffer += chunk;
			const lines = progressBuffer.split("\n");
			progressBuffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line) as { step?: unknown; diagnostics?: Diagnostics };
					firstEventAt ??= performance.now();
					if (event.diagnostics) {
						diagnostics = event.diagnostics;
						const active = diagnostics.spans.findLast((span) => span.durationMs === undefined);
						if (active) onProgress?.(active.name);
					}
					if (typeof event.step === "string") onProgress?.(event.step);
				} catch {
					// Progress is advisory; malformed events do not affect the run.
				}
			}
		});
		runner.on("error", (error) => {
			signal?.removeEventListener("abort", stop);
			reject(new RunnerError(error.message, finishDiagnostics()));
		});
		runner.on("close", (code) => {
			signal?.removeEventListener("abort", stop);
			try {
				process.kill(-runner.pid!, "SIGKILL"); // anything the program left running
			} catch {
				// nothing left
			}
			if (code === 0) {
				let result: RunResult;
				try {
					result = JSON.parse(stdout);
				} catch {
					reject(new RunnerError("Runner returned invalid JSON", finishDiagnostics()));
					return;
				}
				diagnostics = result.diagnostics ?? diagnostics;
				result.diagnostics = finishDiagnostics();
				if (!signal?.aborted || result.applied.length > 0 || result.cleanupWarnings.length > 0) resolve(result);
				else reject(new Error("Aborted"));
			} else
				reject(
					new RunnerError(
						stderr.trim() || (signal?.aborted ? "Aborted" : `runner exited with ${code}`),
						finishDiagnostics(),
					),
				);
		});

		runner.stdin.end(JSON.stringify(options));
	});
}

/** e.g. "✓ exit 0 · 326 ms · 6 files · +48 −17 · applied" */
function summaryLine(run: RunResult): string {
	const parts = [];
	parts.push(run.timedOut ? "timed out" : `exit ${run.exitCode}`);
	if (run.conflicts.length > 0) parts.push("conflict");
	parts.push(`${run.durationMs} ms`);

	if (run.changes.length === 0) {
		parts.push("no changes");
	} else {
		const counts = run.changes.map((change) => countLines(change.patch));
		const additions = counts.reduce((sum, count) => sum + count.additions, 0);
		const deletions = counts.reduce((sum, count) => sum + count.deletions, 0);
		const files = run.changes.length === 1 ? "1 file" : `${run.changes.length} files`;
		parts.push(`${files} · +${additions} −${deletions}`);

		if (run.applied.length === run.changes.length) parts.push("applied");
		else if (run.applied.length === 0) parts.push("NOT applied");
		else parts.push(`${run.applied.length} of ${run.changes.length} applied`);
	}
	return `${run.exitCode === 0 && run.conflicts.length === 0 ? "✓" : "✕"} ${parts.join(" · ")}`;
}

/** e.g. "  M src/a.ts +3 −1" */
function fileLine(change: FileChange): string {
	const letter = { added: "A", modified: "M", deleted: "D" }[change.kind];
	const { additions, deletions } = countLines(change.patch);
	const metadata = fileMetadataSummary(change);
	return `  ${letter} ${change.path}${metadata ? ` (${metadata})` : ""} +${additions} −${deletions}`;
}

function textForModel(run: RunResult, toolCallId: string): string {
	const lines = [summaryLine(run)];
	const timing = timingBreakdown(run);
	if (timing) lines.push(`Timing: ${timing}`);

	if (run.applied.length === 0 && run.changes.length > 0) {
		lines.push("The real workspace is unchanged. Below is the candidate diff.");
	}
	if (run.conflicts.length > 0) lines.push(`Changed while the program ran: ${run.conflicts.join(", ")}`);
	for (const change of run.changes) lines.push(fileLine(change));
	for (const warning of run.warnings) lines.push(`warning: ${warning}`);
	if (run.rolledBack.length > 0) {
		const reason = run.writerInspectionFailed
			? "open writers could not be inspected at the timeout"
			: run.timedOut
				? "they were half-written when the program was killed"
				: "finished writes could not be identified after the program exited";
		lines.push(`Rolled back, because ${reason}: ${run.rolledBack.join(", ")}`);
	}
	if (run.stillRunning.length > 0) {
		lines.push("Still running when it was killed:", ...run.stillRunning.map((command) => `  ${command}`));
	} else if (run.lastStep) {
		lines.push(`Its last logged step before the timeout: ${run.lastStep}`);
	}

	const output = outputForModel(run, toolCallId);
	const diff = diffForModel(run, toolCallId);

	// On failure the error goes last, where it's easiest to find; on success, the diff does.
	if (run.exitCode === 0 && run.conflicts.length === 0) lines.push(...output, ...diff);
	else lines.push(...diff, ...output);
	if (run.diagnostics && ((run.diagnostics.wallMs ?? run.durationMs) >= timeoutBudgetMs(run) || run.exitCode !== 0))
		lines.push("", ...diagnosticLines(run.diagnostics));
	return lines.join("\n");
}

/** The program's output, within Pi's usual limits for tool output. Says so if anything was cut. */
function outputForModel(run: RunResult, toolCallId: string): string[] {
	const output = run.output.trim();
	if (!output) return [];

	const truncated = truncateTail(output);
	if (!truncated.truncated) return ["", "output:", output];

	const fullOutputPath = path.join(tmpdir(), `pi-shorthand-${toolCallId}.output`);
	writeFileSync(fullOutputPath, output);
	const notice = `[output truncated: the last ${truncated.outputLines} of ${truncated.totalLines} lines; full output: ${fullOutputPath}]`;
	return ["", "output:", notice, truncated.content];
}

function diffForModel(run: RunResult, toolCallId: string): string[] {
	const diff = run.changes.map((change) => change.patch).join("\n");
	if (!diff) return [];

	// A large diff is shown as one example of each distinct change, then cut to Pi's usual limits.
	const shown = modelDiff(run.changes);
	const truncated = truncateHead(shown.text);
	const lines = ["", truncated.content];
	if (shown.summarized || truncated.truncated) {
		const fullDiffPath = path.join(tmpdir(), `pi-shorthand-${toolCallId}.diff`);
		writeFileSync(fullDiffPath, diff);
		lines.push(
			truncated.truncated
				? `[diff truncated at ${truncated.outputLines} of ${truncated.totalLines} lines; full diff: ${fullDiffPath}]`
				: `[full diff: ${fullDiffPath}]`,
		);
	}
	return lines;
}
