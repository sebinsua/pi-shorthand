import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { tasks, taskById, materializeTask } from "./tasks.ts";
import { parseSetups } from "./conditions.ts";

const { values } = parseArgs({
	options: {
		execute: { type: "boolean", default: false },
		tasks: { type: "string" },
		setups: { type: "string", default: "baseline,replace,code" },
		documentation: { type: "string", default: "shipped" },
		skills: { type: "string", default: "none" },
		runs: { type: "string", default: "3" },
		model: { type: "string", default: "anthropic/claude-sonnet-4-6" },
		reasoning: { type: "string", default: "high" },
		"budget-seconds": { type: "string", default: "600" },
		"budget-dollars": { type: "string" },
		"results-dir": { type: "string" },
	},
});

const selected = values.tasks ? values.tasks.split(",").map(taskById) : tasks;
const setups = parseSetups(values.setups!);
if (!Number.isInteger(Number(values.runs)) || Number(values.runs) < 1)
	throw new Error("--runs must be positive integer");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
for (const task of selected)
	console.log(
		JSON.stringify({
			task: task.id,
			revision: task.revision,
			category: task.category,
			prompt: task.prompt,
			setups,
			documentation: values.documentation,
			skills: values.skills,
			repetitions: Number(values.runs),
			execute: values.execute,
		}),
	);

if (!values.execute) {
	console.log("Plan only. No model was called. Pass --execute to run paid model sessions.");
} else {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-suite-"));
	try {
		for (const task of selected) {
			const fixture = path.join(root, task.id);
			await materializeTask(task, fixture);
			const evaluator = path.join(import.meta.dir, "tasks.ts");
			const command = [
				"bun",
				path.join(import.meta.dir, "run.ts"),
				"--repo",
				fixture,
				"--task",
				task.prompt,
				"--task-id",
				task.id,
				"--category",
				task.category,
				"--check",
				`bun ${quote(evaluator)} ${quote(task.id)} "$PWD"`,
			];
			for (const key of [
				"setups",
				"documentation",
				"skills",
				"runs",
				"model",
				"reasoning",
				"budget-seconds",
				"budget-dollars",
				"results-dir",
			] as const) {
				if (values[key] !== undefined) command.push(`--${key}`, values[key]!);
			}
			const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
			if ((await child.exited) !== 0) throw new Error(`Runner failed for ${task.id}`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
