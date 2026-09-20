/**
 * Runs Pi against recorded copies of a repository and writes machine-readable attempt and experiment summaries.
 *
 *   bun e2e/run.ts --repo <path or git URL> --task "<task>" [--setup baseline|code|read-code]
 *     [--model anthropic/claude-sonnet-4-6] [--reasoning high] [--runs 1]
 *     [--check "<shell command>"] [--budget-seconds 600]
 *     [--extension <path> | --baseline-extension <path> --candidate-extension <path>]
 *
 * Paired extension runs use separate frozen snapshots, alternate execution order, and start from copies of the
 * same recorded fixture. A completion is verified only when Pi succeeds within budget and --check passes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import {
	aggregateRuns,
	copyFixture,
	fixtureIdentity,
	freezeExtension,
	gitStatus,
	pairedOrder,
	processOutcome,
	runVerification,
	summarizeEvents,
	type FrozenExtension,
	type JsonEvent,
} from "./harness.ts";

const { values: args } = parseArgs({
	options: {
		repo: { type: "string" },
		task: { type: "string" },
		setup: { type: "string", default: "code" },
		model: { type: "string", default: "anthropic/claude-sonnet-4-6" },
		reasoning: { type: "string" },
		runs: { type: "string", default: "1" },
		check: { type: "string" },
		"budget-seconds": { type: "string", default: "600" },
		extension: { type: "string" },
		"baseline-extension": { type: "string" },
		"candidate-extension": { type: "string" },
	},
});
if (!args.repo || !args.task) throw new Error("Usage: bun e2e/run.ts --repo <path or git URL> --task <task> …");
if (!Number.isInteger(Number(args.runs)) || Number(args.runs) < 1) throw new Error("--runs must be a positive integer");
const budgetSeconds = Number(args["budget-seconds"]);
if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error("--budget-seconds must be positive");

const extensionRoot = path.join(import.meta.dir, "..");
const resultsRoot = path.join(import.meta.dir, "results");
const setup = args.setup!;
if (!["baseline", "code", "read-code"].includes(setup)) throw new Error("--setup must be baseline, code or read-code");
const paired = Boolean(args["baseline-extension"] || args["candidate-extension"]);
if (paired && (!args["baseline-extension"] || !args["candidate-extension"])) {
	throw new Error("Paired mode requires both --baseline-extension and --candidate-extension");
}
if (paired && setup === "baseline") throw new Error("Paired extensions require --setup code or read-code");

mkdirSync(resultsRoot, { recursive: true });
const workDir = await mkdtemp(path.join(tmpdir(), "pi-shorthand-e2e-"));
try {
	const source = await prepareSource(args.repo, workDir);
	const recordedFixture = path.join(workDir, "fixture");
	await copyFixture(source, recordedFixture);
	const startingFixture = await fixtureIdentity(recordedFixture);
	const extensions = await prepareExtensions(workDir);
	const summaries: Awaited<ReturnType<typeof runPi>>[] = [];
	let runOrder = 0;

	for (let run = 1; run <= Number(args.runs); run++) {
		const labels = paired ? pairedOrder(run) : ([extensions[0]?.label ?? "baseline"] as const);
		for (const label of labels) {
			const extension = extensions.find((item) => item.label === label);
			const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${setup}-${label}-${run}`;
			const copy = path.join(workDir, name);
			await copyFixture(recordedFixture, copy);
			const copiedFixture = await fixtureIdentity(copy);
			if (copiedFixture.fingerprint !== startingFixture.fingerprint)
				throw new Error("Fixture copy does not match recorded source");

			const summary = await runPi(copy, name, ++runOrder, run, extension, startingFixture);
			summaries.push(summary);
			writeSummary(summary);
			await rm(copy, { recursive: true, force: true });
		}
	}

	const experiment = {
		kind: "experiment",
		model: args.model,
		reasoning: args.reasoning ?? null,
		setup,
		fixture: startingFixture,
		runOrder: summaries.map(({ name, extension, runOrder: position }) => ({
			name,
			revision: extension?.label ?? "baseline",
			runOrder: position,
		})),
		results: Object.fromEntries(
			[...new Set(summaries.map((summary) => summary.extension?.label ?? "baseline"))].map((label) => [
				label,
				aggregateRuns(
					summaries
						.filter((summary) => (summary.extension?.label ?? "baseline") === label)
						.map((summary) => ({ verified: summary.verified, seconds: summary.seconds, usage: summary.usage })),
					budgetSeconds,
				),
			]),
		),
	};
	writeSummary(experiment);
} finally {
	await rm(workDir, { recursive: true, force: true });
}

async function prepareExtensions(workDirectory: string): Promise<FrozenExtension[]> {
	if (setup === "baseline") return [];
	const extensionDirectory = path.join(workDirectory, "extensions");
	if (paired) {
		return Promise.all([
			freezeExtension(args["baseline-extension"]!, path.join(extensionDirectory, "baseline"), "baseline"),
			freezeExtension(args["candidate-extension"]!, path.join(extensionDirectory, "candidate"), "candidate"),
		]);
	}
	return [
		await freezeExtension(args.extension ?? extensionRoot, path.join(extensionDirectory, "candidate"), "candidate"),
	];
}

/** A local path retains its dirty/untracked state; a URL is cloned once and then treated as the recorded fixture. */
async function prepareSource(repo: string, into: string): Promise<string> {
	if (!/^(https?:|git@)/.test(repo)) return path.resolve(repo);
	const clone = path.join(into, "source");
	await $`git clone -q --depth 1 ${repo} ${clone}`;
	if (await Bun.file(path.join(clone, "package.json")).exists()) await $`bun install`.cwd(clone).quiet();
	return clone;
}

async function runPi(
	copy: string,
	name: string,
	runOrder: number,
	repetition: number,
	extension: FrozenExtension | undefined,
	startingFixture: Awaited<ReturnType<typeof fixtureIdentity>>,
) {
	const logFile = path.join(resultsRoot, `${name}.jsonl`);
	const stderrFile = path.join(resultsRoot, `${name}.stderr.log`);
	const setupArgs = extension ? ["-e", extension.path] : [];
	if (setup === "read-code") setupArgs.push("--tools", "read,code");
	const reasoningArgs = args.reasoning ? ["--thinking", args.reasoning] : [];
	const command = [
		"pi",
		"--mode",
		"json",
		"--no-session",
		"-ne",
		"--model",
		args.model!,
		...reasoningArgs,
		...setupArgs,
		"-p",
		args.task!,
	];
	const startedAt = performance.now();
	const pi = Bun.spawn(command, { cwd: copy, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let exceededBudget = false;
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	const timer = setTimeout(() => {
		exceededBudget = true;
		killGroup(pi.pid, "SIGTERM");
		forceTimer = setTimeout(() => killGroup(pi.pid, "SIGKILL"), 2_000);
	}, budgetSeconds * 1000);
	const observedPromise = observeEvents(pi.stdout, logFile);
	const stderrPromise = new Response(pi.stderr).text();
	const [piExitCode, observed, stderr] = await Promise.all([pi.exited, observedPromise, stderrPromise]);
	clearTimeout(timer);
	if (forceTimer) clearTimeout(forceTimer);
	await Bun.write(stderrFile, stderr);
	const eventSummary = summarizeEvents(observed.events);
	const verification = args.check
		? await runVerification(args.check, copy, budgetSeconds * 1000 - (performance.now() - startedAt))
		: null;
	const changes = await gitStatus(copy);
	const durationMs = performance.now() - startedAt;
	exceededBudget ||= durationMs > budgetSeconds * 1000 || verification?.timedOut === true;
	const verified = piExitCode === 0 && !exceededBudget && verification?.passed === true;

	return {
		kind: "run" as const,
		name,
		setup,
		model: args.model,
		reasoning: args.reasoning ?? null,
		repetition,
		runOrder,
		budgetSeconds,
		extension: extension ?? null,
		startingFixture,
		seconds: durationMs / 1000,
		timing: {
			endToEndMs: durationMs,
			modelMs: observed.modelMs,
			toolMs: observed.toolMs,
			verificationMs: verification?.durationMs ?? 0,
			unattributedMs: Math.max(0, durationMs - observed.modelMs - observed.toolMs - (verification?.durationMs ?? 0)),
		},
		pi: processOutcome(piExitCode, stderr, exceededBudget, observed.invalidLines),
		...eventSummary,
		verification,
		verified,
		changes,
		log: logFile,
		stderrLog: stderrFile,
	};
}

async function observeEvents(stream: ReadableStream<Uint8Array>, logFile: string) {
	const writer = Bun.file(logFile).writer();
	const decoder = new TextDecoder();
	let pending = "";
	let invalidLines = 0;
	let modelMs = 0;
	let toolMs = 0;
	const modelStarts: number[] = [];
	const toolStarts = new Map<string, number>();
	const events: JsonEvent[] = [];

	const consume = (line: string) => {
		if (!line) return;
		let event: JsonEvent;
		try {
			event = JSON.parse(line);
		} catch {
			invalidLines++;
			return;
		}
		events.push(event);
		const now = performance.now();
		if (event.type === "message_start" && event.message?.role === "assistant") modelStarts.push(now);
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const started = modelStarts.pop();
			if (started !== undefined) modelMs += now - started;
		}
		if (event.type === "tool_execution_start" && typeof event.toolCallId === "string")
			toolStarts.set(event.toolCallId, now);
		if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
			const started = toolStarts.get(event.toolCallId);
			if (started !== undefined) toolMs += now - started;
			toolStarts.delete(event.toolCallId);
		}
	};

	for await (const chunk of stream) {
		writer.write(chunk);
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) consume(line);
	}
	pending += decoder.decode();
	consume(pending);
	await writer.end();
	return { events, invalidLines, modelMs, toolMs };
}

function writeSummary(summary: unknown): void {
	const line = JSON.stringify(summary);
	console.log(line);
	appendFileSync(path.join(resultsRoot, "summary.jsonl"), `${line}\n`);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// It exited between the timer firing and the signal.
	}
}
