import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { RunResult } from "../src/runner/runner.ts";

const CLI = path.join(import.meta.dir, "../src/cli/shorthand.ts");
const hasOverlay =
	process.platform === "darwin"
		? Boolean(process.env.AGENTFS_BIN ?? Bun.which("agentfs"))
		: Boolean(Bun.which("bwrap"));

let temporaryRoot: string | undefined;
afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
});

async function makeRepo(): Promise<string> {
	temporaryRoot = await mkdtemp(path.join(tmpdir(), "shorthand-cli-"));
	await Bun.write(path.join(temporaryRoot, "target.txt"), "before\n");
	await $`git init -q && git add -A && git -c user.name=test -c user.email=test@test -c commit.gpgsign=false commit -qm init`.cwd(
		temporaryRoot,
	);
	return temporaryRoot;
}

function shorthand(args: string[], options: { stdin?: string; cwd?: string } = {}) {
	const result = Bun.spawnSync(["bun", CLI, ...args], {
		cwd: options.cwd,
		stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
	});
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("prints its version and help", () => {
	const { version } = require("../package.json") as { version: string };
	expect(shorthand(["--version"])).toMatchObject({ code: 0, stdout: `${version}\n` });
	expect(shorthand(["--help"]).stdout).toContain("Usage: shorthand [options] [program.ts]");
});

test("--skill prints the skill verbatim, from outside any repository", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "shorthand-skill-"));
	try {
		const result = shorthand(["--skill"], { cwd: directory });
		const skill = await Bun.file(path.join(import.meta.dir, "../skills/shorthand/SKILL.md")).text();
		expect(result.code).toBe(0);
		expect(result.stdout.startsWith(skill.trimEnd())).toBe(true);
		const guide = /\nAdvanced guide: (.+)\n$/.exec(result.stdout)?.[1];
		expect(guide && (await Bun.file(guide).exists())).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects bad arguments with usage and exit code 2", () => {
	for (const args of [["--rollback", "some"], ["--timeout", "0"], ["--nope"], ["a.ts", "b.ts"]]) {
		const result = shorthand(args, { stdin: "" });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("Usage: shorthand");
	}
});

test.skipIf(!hasOverlay)("applies a program from stdin and prints the model's text", async () => {
	const repo = await makeRepo();
	const result = shorthand([], {
		cwd: repo,
		stdin: 'edit({ path: "target.txt", oldText: "before", newText: "after" });',
	});
	expect(result.code).toBe(0);
	expect(result.stdout).toStartWith("✓ exit 0");
	expect(result.stdout).toContain("M target.txt +1 −1");
	expect(result.stdout).toContain("+after");
	expect(await Bun.file(path.join(repo, "target.txt")).text()).toBe("after\n");
});

test.skipIf(!hasOverlay)("a failed program exits 1 and applies nothing with --rollback all", async () => {
	const repo = await makeRepo();
	await Bun.write(
		path.join(repo, "program.ts"),
		'await Bun.write("target.txt", "changed\\n");\nthrow new Error("boom");\n',
	);
	const result = shorthand(["--cwd", repo, "--rollback", "all", path.join(repo, "program.ts")]);
	expect(result.code).toBe(1);
	expect(result.stdout).toStartWith("✕ exit 1");
	expect(result.stdout).toContain("boom");
	expect(await Bun.file(path.join(repo, "target.txt")).text()).toBe("before\n");
});

test.skipIf(!hasOverlay)("--json prints the full result", async () => {
	const repo = await makeRepo();
	const result = shorthand(["--json"], { cwd: repo, stdin: 'console.log("hello");' });
	expect(result.code).toBe(0);
	const run = JSON.parse(result.stdout) as RunResult;
	expect(run.exitCode).toBe(0);
	expect(run.output.trim()).toBe("hello");
	expect(run.changes).toEqual([]);
});

test("a directory outside a Git worktree is a runner error, exit code 2", async () => {
	temporaryRoot = await mkdtemp(path.join(tmpdir(), "shorthand-cli-"));
	const result = shorthand(["--cwd", temporaryRoot], { stdin: "" });
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).not.toBe("");
});
