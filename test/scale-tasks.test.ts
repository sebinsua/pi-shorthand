import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { applySolution, materializeTask, taskById } from "../e2e/tasks.ts";
import { scaleTasks } from "../e2e/tasks/scale.ts";

const temporary: string[] = [];
async function fixture(id: string) {
	const root = await mkdtemp(path.join(tmpdir(), "scale-task-test-"));
	temporary.push(root);
	await materializeTask(taskById(id), root);
	return root;
}
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const edit = async (root: string, file: string, change: (text: string) => string) =>
	writeFile(path.join(root, file), change(await readFile(path.join(root, file), "utf8")));

test("every scale task has a brief and an unchanged starting fixture reports only missed sites", async () => {
	for (const task of scaleTasks) {
		expect(task.brief).toBeString();
		const root = await fixture(task.id);
		const drift = await task.drift!(root);
		expect(drift.missed.length).toBe(drift.sites);
		expect({ overmatched: drift.overmatched, unrelated: drift.unrelated }).toEqual({ overmatched: [], unrelated: [] });
	}
});

test("a textual rename over-matches decoys that a scoped rename leaves alone", async () => {
	const task = taskById("rename-symbol-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	for (const file of Object.keys(task.files))
		await edit(root, file, (text) => text.replaceAll("formatAmount", "formatPrice"));
	const drift = await task.drift!(root);
	expect(drift.missed).toEqual([]);
	expect(drift.overmatched.length).toBe(drift.decoys);
	expect(drift.unrelated).toContain("src/legacy/format.ts");
});

test("a partial migration reports the files it missed", async () => {
	const task = taskById("logger-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	const skipped = "src/features/g1/feature1.ts";
	await writeFile(path.join(root, skipped), task.files[skipped]!);
	const drift = await task.drift!(root);
	expect(drift.missed).toEqual([expect.stringContaining(skipped)]);
	await expect(task.verify(root)).rejects.toThrow();
});

test("drift ignores reformatting but reports unrelated edits and scratch files", async () => {
	const task = taskById("options-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	for (const file of Object.keys(task.solution))
		await edit(root, file, (text) => text.replaceAll('"', "'").replaceAll("\n", "\n\n"));
	expect(await task.drift!(root)).toMatchObject({ missed: [], overmatched: [], unrelated: [] });
	await edit(root, "src/lib/cache.ts", (text) => text.replace("ttl }", "ttl: ttl * 2 }"));
	await writeFile(path.join(root, "migrate.ts"), "// scratch\n");
	expect((await task.drift!(root)).unrelated).toEqual(["migrate.ts", "src/lib/cache.ts"]);
});

test("a module move that leaves the old file behind is incomplete", async () => {
	const task = taskById("move-module-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	await writeFile(path.join(root, "src/utils/date.ts"), 'export * from "../shared/time/date";\n');
	const drift = await task.drift!(root);
	expect(drift.missed).toEqual(["src/utils/date.ts removed"]);
});

test("the evaluator prints drift before failing", async () => {
	const root = await fixture("rename-symbol-10");
	const child = Bun.spawn(["bun", path.resolve("e2e/tasks.ts"), "rename-symbol-10", root], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	expect(exit).not.toBe(0);
	const line = stdout.split("\n").find((item) => item.startsWith("DRIFT "));
	expect(JSON.parse(line!.slice("DRIFT ".length)).missed.length).toBeGreaterThan(0);
});

test("a migrated logger call counts however its arguments are written", async () => {
	const task = taskById("logger-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	await edit(root, "src/features/g1/feature1.ts", (text) =>
		text.replace("{ error: err }", "err === undefined ? undefined : { error: err }"),
	);
	await edit(root, "src/features/g2/feature2.ts", (text) =>
		text.replace('logger.log(level, "m301")', 'logger[level]("m301")'),
	);
	expect(await task.drift!(root)).toMatchObject({ missed: [], overmatched: [], unrelated: [] });
	await task.verify(root);
});
