/**
 * Runs Pi against recorded copies of a repository and writes machine-readable attempt and experiment summaries.
 *
 *   bun e2e/run.ts --repo <path or git URL> --task "<task>" [--setups baseline,replace,code,read-code]
 *     [--model anthropic/claude-sonnet-4-6] [--reasoning high] [--runs 1]
 *     [--check "<shell command>"] [--budget-seconds 600] [--budget-dollars 2]
 *     [--documentation shipped,minimal] [--skills none,shorthand]
 *     [--extension <path> | --baseline-extension <path> --candidate-extension <path>]
 *
 * Paired extension runs use separate frozen snapshots, alternate execution order, and start from copies of the
 * same recorded fixture. A completion is verified only when Pi succeeds within budget and --check passes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import {
	aggregateRuns,
	copyFixture,
	fixtureIdentity,
	freezeExtension,
	gitStatus,
	processOutcome,
	runVerification,
	summarizeEvents,
	type FrozenExtension,
	type JsonEvent,
} from "./harness.ts";

import {
	conditionTools,
	extensionEntry,
	parseSetups,
	rotateConditions,
	type Documentation,
	type Setup,
} from "./conditions.ts";
import { saveChanges } from "./artifacts.ts";
import { sessionReport } from "./report.ts";

const { values: args } = parseArgs({
	options: {
		repo: { type: "string" },
		task: { type: "string" },
		setup: { type: "string", default: "code" },
		setups: { type: "string" },
		documentation: { type: "string", default: "shipped" },
		skills: { type: "string", default: "none" },
		"results-dir": { type: "string" },
		"budget-dollars": { type: "string" },
		"task-id": { type: "string" },
		category: { type: "string" },
		model: { type: "string", default: "anthropic/claude-sonnet-4-6" },
		reasoning: { type: "string", default: "high" },
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
const resultsRoot = path.resolve(args["results-dir"] ?? path.join(import.meta.dir, "results"));
const selectedSetups = parseSetups(args.setups ?? args.setup!);
const selectedDocumentation = args.documentation!.split(",") as Documentation[];
if (selectedDocumentation.some((item) => !["shipped", "minimal"].includes(item)))
	throw new Error("--documentation must be shipped and/or minimal");
const skills = args.skills!.split(",");
if (skills.some((item) => !["none", "shorthand"].includes(item)))
	throw new Error("--skills must be none and/or shorthand");
const budgetDollars = args["budget-dollars"] === undefined ? null : Number(args["budget-dollars"]);
if (budgetDollars !== null && (!Number.isFinite(budgetDollars) || budgetDollars <= 0))
	throw new Error("--budget-dollars must be positive");
type Condition = { id: string; setup: Setup; documentation: Documentation; skill: string; extension?: FrozenExtension };
const paired = Boolean(args["baseline-extension"] || args["candidate-extension"]);
if (paired && (!args["baseline-extension"] || !args["candidate-extension"])) {
	throw new Error("Paired mode requires both --baseline-extension and --candidate-extension");
}
if (paired && selectedSetups.every((setup) => setup === "baseline"))
	throw new Error("Paired extensions require a shorthand setup");

mkdirSync(resultsRoot, { recursive: true });
const workDir = await mkdtemp(path.join(tmpdir(), "pi-shorthand-e2e-"));
try {
	const source = await prepareSource(args.repo, workDir);
	const recordedFixture = path.join(workDir, "fixture");
	await copyFixture(source, recordedFixture);
	const startingFixture = await fixtureIdentity(recordedFixture);
	const extensions = await prepareExtensions(workDir);
	const conditions: Condition[] = selectedSetups.flatMap((setup): Condition[] =>
		setup === "baseline"
			? [{ id: "baseline", setup, documentation: "shipped", skill: "none" }]
			: extensions.flatMap((extension) =>
					selectedDocumentation.flatMap((docs) =>
						skills.map((skill) => ({
							id: `${setup}-${extension.label}-${docs}-${skill}`,
							setup,
							documentation: docs,
							skill,
							extension,
						})),
					),
				),
	);
	if (new Set(conditions.map((item) => item.id)).size !== conditions.length) throw new Error("Duplicate conditions");
	const summaries: Awaited<ReturnType<typeof runPi>>[] = [];
	let runOrder = 0;

	for (let run = 1; run <= Number(args.runs); run++) {
		for (const condition of rotateConditions(conditions, run)) {
			const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${condition.id}-${run}`;
			const copy = path.join(workDir, name);
			await copyFixture(recordedFixture, copy);
			const copiedFixture = await fixtureIdentity(copy);
			if (copiedFixture.fingerprint !== startingFixture.fingerprint)
				throw new Error("Fixture copy does not match recorded source");

			const summary = await runPi(copy, name, ++runOrder, run, condition, startingFixture, recordedFixture);
			summaries.push(summary);
			writeSummary(summary);
			await rm(copy, { recursive: true, force: true });
		}
	}

	const experiment = {
		kind: "experiment",
		model: args.model,
		reasoning: args.reasoning ?? null,
		conditions: conditions.map(({ id, setup, documentation, skill }) => ({ id, setup, documentation, skill })),
		task: args.task,
		taskId: args["task-id"] ?? null,
		category: args.category ?? null,
		fixture: startingFixture,
		runOrder: summaries.map(({ name, condition, runOrder: position }) => ({
			name,
			condition,
			runOrder: position,
		})),
		results: Object.fromEntries(
			[...new Set(summaries.map((summary) => summary.condition))].map((label) => [
				label,
				aggregateRuns(
					summaries
						.filter((summary) => summary.condition === label)
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
	if (selectedSetups.every((setup) => setup === "baseline")) return [];
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
	condition: Condition,
	startingFixture: Awaited<ReturnType<typeof fixtureIdentity>>,
	recordedFixture: string,
) {
	const { setup, extension, documentation, skill } = condition;
	const logFile = path.join(resultsRoot, `${name}.jsonl`);
	const stderrFile = path.join(resultsRoot, `${name}.stderr.log`);
	const entry = extension
		? await extensionEntry(extension.path, documentation, path.join(workDir, `${name}.ts`))
		: null;
	const setupArgs = entry ? ["-e", entry] : [];
	setupArgs.push("--tools", conditionTools(setup).join(","));
	if (skill === "shorthand" && extension) setupArgs.push("--skill", path.join(extension.path, "skills/shorthand"));
	const agentDir = path.join(workDir, `${name}-agent`);
	mkdirSync(agentDir, { mode: 0o700 });
	// Preserve authentication and model definitions, but not ambient prompts, skills or settings.
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi/agent");
	for (const file of ["auth.json", "models.json"]) {
		const from = path.join(originalAgentDir, file);
		if (await Bun.file(from).exists()) {
			await copyFile(from, path.join(agentDir, file));
			await chmod(path.join(agentDir, file), 0o600);
		}
	}
	const reasoningArgs = ["--thinking", args.reasoning ?? "high"];
	const command = [
		"pi",
		"--mode",
		"json",
		"--no-session",
		"-ne",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-themes",
		"--no-approve",
		"--offline",
		"--model",
		args.model!,
		...reasoningArgs,
		...setupArgs,
		"-p",
		args.task!,
	];
	const startedAt = performance.now();
	const pi = Bun.spawn(command, {
		cwd: copy,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SHORTHAND_HISTORY: "0" },
		detached: true,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let exceededBudget = false;
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	let exceededCost = false;
	const stop = () => {
		killGroup(pi.pid, "SIGTERM");
		forceTimer ??= setTimeout(() => killGroup(pi.pid, "SIGKILL"), 2_000);
	};
	const timer = setTimeout(() => {
		exceededBudget = true;
		stop();
	}, budgetSeconds * 1000);
	const observedPromise = observeEvents(pi.stdout, logFile, () => {
		exceededCost = true;
		stop();
	});
	const stderrPromise = new Response(pi.stderr).text();
	const [piExitCode, observed, stderr] = await Promise.all([pi.exited, observedPromise, stderrPromise]);
	clearTimeout(timer);
	if (forceTimer) clearTimeout(forceTimer);
	await Bun.write(stderrFile, stderr);
	const eventSummary = summarizeEvents(observed.events);
	await Bun.write(`${logFile}.timeline.jsonl`, observed.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
	const artifacts = await saveChanges(recordedFixture, copy, path.join(resultsRoot, `${name}.artifacts`));
	const verification = args.check
		? await runVerification(args.check, copy, budgetSeconds * 1000 - (performance.now() - startedAt))
		: null;
	const changes = await gitStatus(copy);
	const durationMs = performance.now() - startedAt;
	exceededBudget ||= durationMs > budgetSeconds * 1000 || verification?.timedOut === true;
	const verified = piExitCode === 0 && !exceededBudget && !exceededCost && verification?.passed === true;

	const summary = {
		kind: "run" as const,
		condition: condition.id,
		documentation,
		skill,
		task: args.task,
		taskId: args["task-id"] ?? null,
		category: args.category ?? null,
		budgetDollars,
		exceededCost,
		artifacts,
		toolNames: conditionTools(setup),
		report: path.join(resultsRoot, `${name}.md`),
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
		timeline: `${logFile}.timeline.jsonl`,
		stderrLog: stderrFile,
	};
	await Bun.write(summary.report, sessionReport(observed.events, summary));
	return summary;
}

async function observeEvents(stream: ReadableStream<Uint8Array>, logFile: string, onCostLimit: () => void) {
	const writer = Bun.file(logFile).writer();
	const decoder = new TextDecoder();
	let pending = "";
	let invalidLines = 0;
	let cost = 0;
	let costStopped = false;
	let modelMs = 0;
	let toolMs = 0;
	const observationStart = performance.now();
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
		const now = performance.now();
		event.observedMs = now - observationStart;
		events.push(event);
		if (event.type === "message_start" && event.message?.role === "assistant") modelStarts.push(now);
		if (event.type === "message_end" && event.message?.role === "assistant") {
			cost += event.message?.usage?.cost?.total ?? 0;
			if (budgetDollars !== null && cost > budgetDollars && !costStopped) {
				costStopped = true;
				onCostLimit();
			}
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
