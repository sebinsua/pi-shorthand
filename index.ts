/**
 * The `code` tool: the model writes one Bun program that makes a multi-step change to the repository.
 * Its writes go to a copy-on-write overlay; if it succeeds, they're applied and the diff is returned.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, keyHint, truncateHead, truncateTail } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { FileChange, RunOptions, RunResult } from "./runner.ts";

// Diffs up to this many lines are shown in full; longer ones are collapsed to a file list.
const MAX_INLINE_DIFF_LINES = 150;

// Runs typically take well under a second. Programs that run tests or builds pass a longer timeout.
const DEFAULT_TIMEOUT_SECONDS = 2;

const DESCRIPTION = `Make a repository change with one TypeScript program, run by Bun as a transaction: its writes are applied only if it exits successfully, and you get the diff. Put the checks that prove the change worked (type-check, targeted tests, no leftover matches) in the same program, and throw if they fail. Work out what to change inside the program (e.g. with grep) rather than copying lists from earlier output.

Use it when a change takes several deterministic steps (reads, searches, multi-file edits, structural rewrites, checks) and you already know what to do with each intermediate result. If seeing an intermediate result could change your plan, look first with a normal tool call.

The program runs in the working directory, and sees the repository at its usual path. Top-level await works, and so do ordinary Bun and Node APIs. These globals are synchronous, and see the files git sees (not node_modules or ignored files):
- glob(pattern, dir?) → string[]
- grep(stringOrRegExp, paths?) → {file, line, text}[]. A string matches literally.
- sg.find(pattern, files?) → {file, line, text, vars}[]. ast-grep pattern: $X is one node, $$$X is zero or more. files is a directory, glob or list (JS/TS).
- sg.rewrite(pattern, templateOrFunction, files?) → number rewritten. A template can use $X and $$$X.
- grit(gritqlPattern, paths?, {lang?, dryRun?}) → {file, matches}[], e.g. grit("\`a($x)\` => \`b($x)\`", "src")
Bun's shell $ needs await: await $\`bun test src/foo.test.ts\`. You can also run the ast-grep, grit and git CLIs with it. For pattern syntax, see the code-patterns skill.

Throw or exit non-zero to fail. rollback decides what a failure undoes:
- "all" (default): nothing is applied; you get the error and the candidate diff.
- "file": every file the program finished writing is applied; files left half-written (e.g. by a timeout) are rolled back and listed.
The default timeout is 2 seconds; pass a longer timeout when the program runs tests or builds. Only files git sees (tracked, or untracked and not ignored) are diffed and applied; writes to .git are blocked. Print what you need to know (counts, assertions), not whole files.`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "code",
		label: "Code",
		description: DESCRIPTION,
		promptSnippet:
			"Make a change with one Bun program, run as a transaction: its edits are kept only if it exits 0, so put your checks inside it",
		promptGuidelines: [
			"Use code when several related reads, searches, edits or checks can be done without looking at intermediate results: put that logic in one program rather than many read/edit/bash calls.",
			"Don't use code to explore when you need to see results before deciding what to do.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "A few words describing the change, shown to the user" }),
			program: Type.String({ description: "TypeScript program run with Bun (top-level await allowed)" }),
			rollback: Type.Optional(
				StringEnum(["all", "file"] as const, {
					description:
						'On failure: "all" (default) applies nothing; "file" applies finished files and rolls back half-written ones',
				}),
			),
			timeout: Type.Optional(Type.Number({ description: "Seconds before the program is killed (default 2)" })),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runWithBun(
				{
					cwd: ctx.cwd,
					program: params.program,
					timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
					rollback: params.rollback ?? "all",
				},
				signal,
			);
			return {
				content: [{ type: "text", text: textForModel(result, toolCallId) }],
				details: result,
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("code ")) + theme.fg("muted", args.title ?? ""), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const run = result.details as RunResult | undefined;
			if (isPartial || !run) return new Text(theme.fg("muted", "running…"), 0, 0);
			const ok = run.exitCode === 0;

			const lines = [theme.fg(ok ? "success" : "error", summaryLine(run))];
			if (run.rolledBack.length > 0) {
				lines.push(theme.fg("warning", `rolled back (half-written): ${run.rolledBack.join(", ")}`));
			}
			for (const warning of run.warnings) lines.push(theme.fg("warning", `warning: ${warning}`));
			for (const command of run.stillRunning) lines.push(theme.fg("warning", `still running when killed: ${command}`));

			// Output: the tail on failure, all of it when expanded.
			if (expanded && run.output.trim()) {
				lines.push(theme.fg(ok ? "dim" : "error", run.output.trimEnd()));
			} else if (!ok && run.output.trim()) {
				lines.push(theme.fg("error", run.output.trim().split("\n").slice(-8).join("\n")));
			}

			const diffLines = run.changes.flatMap((change) => change.patch.split("\n"));
			if (expanded || diffLines.length <= MAX_INLINE_DIFF_LINES) {
				for (const line of diffLines) lines.push(theme.fg(diffLineColor(line), line));
			} else {
				for (const change of run.changes) lines.push(theme.fg("muted", fileLine(change)));
				lines.push(theme.fg("dim", `${diffLines.length}-line diff (${keyHint("app.tools.expand", "to expand")})`));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

/**
 * Pi runs extensions in Node, so the work happens in a Bun process (runner.ts). On abort it's asked
 * to stop (it then puts the repository back and applies nothing). It has its own process group,
 * which is killed afterwards so no subprocess the program started is left behind.
 */
function runWithBun(options: RunOptions, signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const runner = spawn("bun", [path.join(import.meta.dirname, "runner.ts")], { detached: true });
		const stop = () => runner.kill("SIGTERM");
		signal?.addEventListener("abort", stop);

		let stdout = "";
		let stderr = "";
		runner.stdout.setEncoding("utf8"); // so a multi-byte character split across chunks decodes intact
		runner.stderr.setEncoding("utf8");
		runner.stdout.on("data", (chunk) => (stdout += chunk));
		runner.stderr.on("data", (chunk) => (stderr += chunk));
		runner.on("error", reject);
		runner.on("close", (code) => {
			signal?.removeEventListener("abort", stop);
			try {
				process.kill(-runner.pid!, "SIGKILL"); // anything the program left running
			} catch {
				// nothing left
			}
			if (signal?.aborted) reject(new Error("Aborted"));
			else if (code === 0) resolve(JSON.parse(stdout));
			else reject(new Error(stderr.trim() || `runner exited with ${code}`));
		});

		runner.stdin.end(JSON.stringify(options));
	});
}

/** e.g. "✓ exit 0 · 326 ms · 6 files · +48 −17 · applied" */
function summaryLine(run: RunResult): string {
	const parts = [];
	parts.push(run.timedOut ? "timed out" : `exit ${run.exitCode}`);
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
	return `${run.exitCode === 0 ? "✓" : "✕"} ${parts.join(" · ")}`;
}

/** e.g. "  M src/a.ts +3 −1" */
function fileLine(change: FileChange): string {
	const letter = { added: "A", modified: "M", deleted: "D" }[change.kind];
	const { additions, deletions } = countLines(change.patch);
	return `  ${letter} ${change.path} +${additions} −${deletions}`;
}

/** Added and removed lines in a patch. Only lines after the first "@@" count, not the ---/+++ headers. */
function countLines(patch: string) {
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

function diffLineColor(line: string) {
	if (line.startsWith("diff ")) return "accent";
	if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "dim";
	if (line.startsWith("+")) return "toolDiffAdded";
	if (line.startsWith("-")) return "toolDiffRemoved";
	return "toolDiffContext";
}

function textForModel(run: RunResult, toolCallId: string): string {
	const lines = [summaryLine(run)];

	if (run.applied.length === 0 && run.changes.length > 0) {
		lines.push("The real workspace is unchanged. Below is the candidate diff.");
	}
	for (const change of run.changes) lines.push(fileLine(change));
	for (const warning of run.warnings) lines.push(`warning: ${warning}`);
	if (run.rolledBack.length > 0) {
		lines.push(`Rolled back, because they were half-written when the program was killed: ${run.rolledBack.join(", ")}`);
	}
	if (run.stillRunning.length > 0) {
		lines.push("Still running when it was killed:", ...run.stillRunning.map((command) => `  ${command}`));
	}

	const output = outputForModel(run, toolCallId);
	const diff = diffForModel(run, toolCallId);

	// On failure the error goes last, where it's easiest to find; on success, the diff does.
	if (run.exitCode === 0) lines.push(...output, ...diff);
	else lines.push(...diff, ...output);
	return lines.join("\n");
}

/** The program's output, within Pi's usual limits for tool output. Says so if anything was cut. */
function outputForModel(run: RunResult, toolCallId: string): string[] {
	const output = run.output.trim();
	if (!output) return [];

	const truncated = truncateTail(output);
	if (!truncated.truncated) return ["", "output:", output];

	const fullOutputPath = path.join(tmpdir(), `pi-code-${toolCallId}.output`);
	writeFileSync(fullOutputPath, output);
	const notice = `[output truncated: the last ${truncated.outputLines} of ${truncated.totalLines} lines; full output: ${fullOutputPath}]`;
	return ["", "output:", notice, truncated.content];
}

function diffForModel(run: RunResult, toolCallId: string): string[] {
	const diff = run.changes.map((change) => change.patch).join("\n");
	if (!diff) return [];

	const truncated = truncateHead(diff);
	const lines = ["", truncated.content];
	if (truncated.truncated) {
		const fullDiffPath = path.join(tmpdir(), `pi-code-${toolCallId}.diff`);
		writeFileSync(fullDiffPath, diff);
		lines.push(
			`[diff truncated at ${truncated.outputLines} of ${truncated.totalLines} lines; full diff: ${fullDiffPath}]`,
		);
	}
	return lines;
}
