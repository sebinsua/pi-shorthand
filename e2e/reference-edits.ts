/** Local reference transformations only: no model, API credentials or agent session. */
import { parseArgs } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runWithBun } from "../index.ts";
import { allTasks, materializeTask } from "./tasks.ts";
import { runVerification } from "./harness.ts";
import { saveChanges } from "./artifacts.ts";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const { values } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" } } });
const output = path.resolve(values.out ?? path.join(import.meta.dir, "results", `references-${Date.now()}`));
const programs = path.join(import.meta.dir, "reference-programs");
const selected = values.only?.split(",");
const names = (await readdir(programs))
	.filter((name) => name.endsWith(".ts.txt") && (!selected || selected.includes(name.replace(/\.ts\.txt$/, ""))))
	.toSorted();
if (!names.length) throw new Error("No reference programs selected");
if (await Bun.file(path.join(output, "results.json")).exists()) throw new Error(`Results already exist: ${output}`);
await mkdir(output, { recursive: true });
const results = [];
for (const name of names) {
	const id = name.replace(/\.ts\.txt$/, "");
	const task = allTasks.find((item) => id.startsWith(item.id + "-"));
	if (!task) throw new Error(`No task for ${name}`);
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-reference-"));
	try {
		const before = path.join(root, "before");
		const workspace = path.join(root, "work");
		await materializeTask(task, before);
		await materializeTask(task, workspace);
		const program = await readFile(path.join(programs, name), "utf8");
		await writeFile(path.join(output, name), program);
		const run = await runWithBun({
			cwd: workspace,
			program,
			timeoutMs: 15_000,
			rollback: "all",
		});
		const artifacts = await saveChanges(before, workspace, path.join(output, `${id}.artifacts`));
		// Evaluate in a fresh process, outside the editing program, including the compiler check.
		const command = ["bun", path.join(import.meta.dir, "tasks.ts"), task.id, workspace].map(quote).join(" ");
		const verification = await runVerification(command, workspace, 30_000);
		const result = {
			id,
			task: task.id,
			characters: program.length,
			verified: run.exitCode === 0 && verification.passed,
			run,
			verification,
			artifacts,
		};
		results.push(result);
		await writeFile(
			path.join(output, "results.json"),
			JSON.stringify(
				{ kind: "Human-authored local references, not agent performance measurements", results },
				null,
				2,
			) + "\n",
		);
		console.log(
			`${id}: ${result.verified ? "PASS" : "FAIL"}, ${program.length} characters, ${run.durationMs}ms execution`,
		);
		if (!result.verified) console.log(run.output || verification.stderr || verification.stdout);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
if (results.some((result) => !result.verified)) process.exitCode = 1;
