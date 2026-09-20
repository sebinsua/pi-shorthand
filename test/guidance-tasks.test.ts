import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { materializeTask } from "../e2e/tasks.ts";
import { guidanceTasks } from "../e2e/guidance-tasks.ts";

for (const task of guidanceTasks) {
	test(`guidance evaluator rejects initial ${task.id} and accepts reference`, async () => {
		const root = await mkdtemp(path.join(tmpdir(), "guidance-task-test-"));
		try {
			await materializeTask(task, root);
			await expect(task.verify(root)).rejects.toThrow();
			for (const [file, text] of Object.entries(task.solution)) await writeFile(path.join(root, file), text);
			const proc = Bun.spawn(["bun", path.resolve("e2e/guidance-tasks.ts"), task.id, root], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
