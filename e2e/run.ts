/**
 * Runs Pi with a real model on a task, on a fresh copy of a repository, and summarises what it did.
 *
 *   bun e2e/run.ts --repo <path or git URL> --task "<task>" [--setup baseline|code|read-code]
 *                  [--model anthropic/claude-sonnet-4-6] [--runs 1] [--check "<shell command>"]
 *
 * Setups: "baseline" is Pi's built-in tools only; "code" adds this extension; "read-code" leaves only
 * `read` and `code`. --check runs in the copy afterwards; exit code 0 counts as correct.
 *
 * Each run's Pi event log streams to e2e/results/<time>-<setup>-<n>.jsonl, so `tail -f` shows it live.
 * The summaries are printed and appended to e2e/results/summary.jsonl.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const { values: args } = parseArgs({
	options: {
		repo: { type: "string" },
		task: { type: "string" },
		setup: { type: "string", default: "code" },
		model: { type: "string", default: "anthropic/claude-sonnet-4-6" },
		runs: { type: "string", default: "1" },
		check: { type: "string" },
	},
});
if (!args.repo || !args.task) throw new Error("Usage: bun e2e/run.ts --repo <path or git URL> --task <task> …");

const EXTENSION = path.join(import.meta.dir, "..");
const RESULTS = path.join(import.meta.dir, "results");
const SETUPS: Record<string, string[]> = {
	baseline: [],
	code: ["-e", EXTENSION],
	"read-code": ["-e", EXTENSION, "--tools", "read,code"],
};
const setupArgs = SETUPS[args.setup!];
if (!setupArgs) throw new Error(`--setup must be one of: ${Object.keys(SETUPS).join(", ")}`);

mkdirSync(RESULTS, { recursive: true });
const workDir = await mkdtemp(path.join(tmpdir(), "pi-shorthand-e2e-"));
const source = await prepareSource(args.repo, workDir);

for (let n = 1; n <= Number(args.runs); n++) {
	const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.setup}-${n}`;
	const copy = path.join(workDir, name);
	const clone = process.platform === "darwin" ? "-cR" : "-R"; // -c: a copy-on-write clone on APFS
	await $`cp ${clone} ${source} ${copy}`.quiet();

	const summary = await runPi(copy, name);
	console.log(JSON.stringify(summary));
	appendFileSync(path.join(RESULTS, "summary.jsonl"), `${JSON.stringify(summary)}\n`);
	await rm(copy, { recursive: true, force: true });
}
await rm(workDir, { recursive: true, force: true });

/** A local path is used as it is; a git URL is cloned once, with its dependencies installed. */
async function prepareSource(repo: string, into: string): Promise<string> {
	if (!/^(https?:|git@)/.test(repo)) return path.resolve(repo);
	const clone = path.join(into, "source");
	await $`git clone -q --depth 1 ${repo} ${clone}`;
	if (await Bun.file(path.join(clone, "package.json")).exists()) await $`bun install`.cwd(clone).quiet();
	return clone;
}

async function runPi(copy: string, name: string) {
	const logFile = path.join(RESULTS, `${name}.jsonl`);
	await Bun.write(logFile, "");
	const startedAt = performance.now();
	const pi = Bun.spawn(
		["pi", "--mode", "json", "--no-session", "-ne", "--model", args.model!, ...setupArgs, "-p", args.task!],
		{ cwd: copy, stdin: "ignore", stdout: Bun.file(logFile), stderr: "ignore" },
	);
	await pi.exited;
	const seconds = Math.round((performance.now() - startedAt) / 1000);

	const events = (await Bun.file(logFile).text())
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});

	const tools: Record<string, number> = {};
	for (const event of events) {
		if (event.type === "tool_execution_start") tools[event.toolName] = (tools[event.toolName] ?? 0) + 1;
	}
	const failedCodeCalls = events.filter(
		(event) =>
			event.type === "tool_execution_end" &&
			event.toolName === "code" &&
			(event.result?.content?.[0]?.text ?? "").startsWith("✕"),
	).length;
	const tokens = { input: 0, output: 0 };
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const usage = event.message.usage ?? {};
		tokens.input += (usage.input ?? 0) + (usage.cacheRead ?? 0);
		tokens.output += usage.output ?? 0;
	}

	const check = args.check ? (await $`sh -c ${args.check}`.cwd(copy).nothrow().quiet()).exitCode === 0 : undefined;
	const changed = (await $`git diff --shortstat`.cwd(copy).nothrow().text()).trim();

	return {
		name,
		setup: args.setup,
		model: args.model,
		seconds,
		turns: events.filter((event) => event.type === "turn_start").length,
		tools,
		failedCodeCalls,
		tokens,
		check,
		changed,
		log: logFile,
	};
}
