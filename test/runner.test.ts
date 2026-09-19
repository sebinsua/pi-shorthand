/**
 * Runs real programs through runner.ts against small throwaway git repositories.
 * Needs the platform's overlay: AgentFS on macOS (or AGENTFS_BIN), bubblewrap on Linux.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { runWithBun } from "../index.ts";
import { openLinuxOverlay } from "../overlay-linux.ts";
import type { RunOptions, RunResult } from "../runner.ts";

setDefaultTimeout(30_000);

const RUNNER = path.join(import.meta.dir, "..", "runner.ts");
const hasOverlay =
	process.platform === "darwin"
		? Boolean(process.env.AGENTFS_BIN ?? Bun.which("agentfs"))
		: Boolean(Bun.which("bwrap"));

const repos: string[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
	for (const repo of repos.splice(0)) await rm(path.dirname(repo), { recursive: true, force: true });
	for (const root of temporaryRoots.splice(0)) {
		await chmod(path.join(root, "work/work"), 0o700).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

/** A new git repository with these files committed. */
async function makeRepo(files: Record<string, string>): Promise<string> {
	const repo = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "pi-shorthand-test-"))), "repo");
	await mkdir(repo);
	for (const [file, contents] of Object.entries(files)) await Bun.write(path.join(repo, file), contents);
	await $`git init -q && git add -A && git -c user.name=test -c user.email=test@test commit -qm init`.cwd(repo);
	repos.push(repo);
	return repo;
}

function startRunner(repo: string, program: string, options: Partial<RunOptions> = {}) {
	const input: RunOptions = { runId: "test", cwd: repo, program, timeoutMs: 5000, rollback: "all", ...options };
	return Bun.spawn(["bun", RUNNER], { stdin: new Response(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
}

async function run(repo: string, program: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
	const runner = startRunner(repo, program, options);
	const [stdout, stderr] = await Promise.all([new Response(runner.stdout).text(), new Response(runner.stderr).text()]);
	if ((await runner.exited) !== 0) throw new Error(`runner failed: ${stderr}`);
	return JSON.parse(stdout);
}

async function gitStatus(repo: string): Promise<string> {
	return (await $`git status --short`.cwd(repo).text()).trim();
}

async function textIfFile(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

test.skipIf(process.platform !== "linux")(
	"the Linux backend removes OverlayFS's mode-000 work directory as the invoking user",
	async () => {
		const repo = await makeRepo(FILES);
		const tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), "pi-shorthand-overlay-cleanup-")));
		temporaryRoots.push(tempRoot);
		const overlay = await openLinuxOverlay(repo, tempRoot);
		const mounted = Bun.spawn(overlay.wrap(["true"], repo), { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(mounted.stderr).text();
		expect(await mounted.exited, stderr).toBe(0);

		const internalWork = path.join(tempRoot, "work/work");
		expect((await lstat(internalWork)).mode & 0o777).toBe(0);
		await overlay.close();

		expect(await lstat(tempRoot).catch(() => null)).toBeNull();
	},
);

function macRecoveryFile(repo: string): string {
	const checkout = createHash("sha256").update(repo).digest("hex").slice(0, 16);
	return path.join(homedir(), ".cache", "pi-shorthand", "macos-mounts", `${checkout}.json`);
}

const FILES = {
	"src/api.ts": "export function oldApi(a: number) {\n\treturn a;\n}\n",
	"src/a.ts": 'import { oldApi } from "./api";\nexport const a = oldApi(1);\n',
	"src/b.ts": 'import { oldApi } from "./api";\nexport const b = oldApi(2);\n',
};

describe.skipIf(!hasOverlay)("runner", () => {
	test("applies a successful program's changes and reports them", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`sg.rewrite("oldApi($$$A)", "newApi($$$A)", "src");
			await Bun.write("src/new.ts", "export {};\\n");
			await Bun.file("src/b.ts").delete();`,
		);

		expect(result.exitCode).toBe(0);
		expect(result.changes.map((change) => `${change.kind} ${change.path}`)).toEqual([
			"modified src/a.ts",
			"deleted src/b.ts",
			"added src/new.ts",
		]);
		expect(result.applied).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);
		expect(await gitStatus(repo)).toBe("M src/a.ts\n D src/b.ts\n?? src/new.ts");
	});

	test("a workspace cleanup failure preserves the applied result and reports a warning", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `await Bun.write("src/a.ts", "updated\\n");`, {
			testWorkspaceCleanupFailure: true,
		});

		expect(result.applied).toEqual(["src/a.ts"]);
		expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("isolated workspace"));
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
	});

	test("a workspace cleanup failure does not replace the program failure", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `throw new Error("program failed");`, {
			testWorkspaceCleanupFailure: true,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("program failed");
		expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("isolated workspace"));
	});

	test("preserves a nested working directory inside the execution root", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `await Bun.write("a.ts", "nested cwd\\n");`, {
			cwd: path.join(repo, "src"),
		});

		expect(result.applied).toEqual(["a.ts"]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("nested cwd\n");
	});

	test.skipIf(process.platform !== "darwin")(
		"the macOS program cannot access the live checkout or runner state",
		async () => {
			const repo = await makeRepo(FILES);
			const liveFile = path.join(repo, "src/a.ts");
			const result = await run(
				repo,
				`let liveReadBlocked = false;
			try { await Bun.file(${JSON.stringify(liveFile)}).text(); } catch { liveReadBlocked = true; }
			if (!liveReadBlocked) throw new Error("live checkout was readable");
			const configIndex = Number(process.env.GIT_CONFIG_COUNT) - 1;
			const internal = require("node:path").dirname(process.env[\`GIT_CONFIG_VALUE_\${configIndex}\`]!);
			let internalWriteBlocked = false;
			try { await Bun.write(require("node:path").join(internal, "output"), "tampered"); } catch { internalWriteBlocked = true; }
			if (!internalWriteBlocked) throw new Error("runner state was writable");
			const recovery = require("node:path").join(require("node:os").homedir(), ".cache/pi-shorthand/macos-mounts/tampered");
			let recoveryWriteBlocked = false;
			try { await Bun.write(recovery, "tampered"); } catch { recoveryWriteBlocked = true; }
			if (!recoveryWriteBlocked) throw new Error("recovery state was writable");
			console.log(await Bun.file("src/a.ts").text());`,
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain(FILES["src/a.ts"]);
			expect(await Bun.file(liveFile).text()).toBe(FILES["src/a.ts"]);
		},
	);

	test.skipIf(process.platform !== "darwin")("macOS recovery rejects paths outside owned temporary roots", async () => {
		const repo = await makeRepo(FILES);
		const stateFile = macRecoveryFile(repo);
		const victim = path.join(path.dirname(repo), "recovery-victim");
		await mkdir(path.dirname(stateFile), { recursive: true });
		await Bun.write(victim, "keep me\n");
		await Bun.write(
			stateFile,
			JSON.stringify({ runnerPid: 999_999_999, tempDir: victim, mountContainer: victim, mount: victim }),
		);

		try {
			const runner = startRunner(repo, "");
			expect(await runner.exited).not.toBe(0);
			expect(await Bun.file(victim).text()).toBe("keep me\n");
		} finally {
			await rm(stateFile, { force: true });
		}
	});

	test.skipIf(process.platform !== "darwin")("macOS recovery does not signal a reused unrelated PID", async () => {
		const repo = await makeRepo(FILES);
		const stateFile = macRecoveryFile(repo);
		const temporaryRoot = await realpath(tmpdir());
		const staleTemp = await mkdtemp(path.join(temporaryRoot, "pi-shorthand-stale-"));
		const staleMountContainer = await mkdtemp(path.join(temporaryRoot, "pi-shorthand-workspace-stale-"));
		const staleMount = path.join(staleMountContainer, "repo");
		await mkdir(staleMount);
		const unrelated = Bun.spawn(["sleep", "30"]);
		await mkdir(path.dirname(stateFile), { recursive: true });
		await Bun.write(
			stateFile,
			JSON.stringify({
				runnerPid: 999_999_999,
				serverPid: unrelated.pid,
				tempDir: staleTemp,
				mountContainer: staleMountContainer,
				mount: staleMount,
			}),
		);

		try {
			const runner = startRunner(repo, "");
			expect(await runner.exited).not.toBe(0);
			expect(unrelated.killed).toBe(false);
		} finally {
			unrelated.kill();
			await unrelated.exited;
			await rm(stateFile, { force: true });
			await rm(staleTemp, { recursive: true, force: true });
			await rm(staleMountContainer, { recursive: true, force: true });
		}
	});

	test("applies nothing when the program fails, and reports the error", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`await Bun.write("src/a.ts", "broken");\nthrow new Error("expected 1 match, found 3");`,
		);

		expect(result.exitCode).toBe(1);
		expect(result.applied).toEqual([]);
		expect(result.changes.map((change) => change.path)).toEqual(["src/a.ts"]);
		expect(result.output).toContain("expected 1 match, found 3");
		expect(result.output).toContain("program.ts:2");
		expect(await gitStatus(repo)).toBe("");
	});

	test('rollback "file" keeps finished files and rolls back one left half-written', async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`await Bun.write("src/a.ts", "// finished\\n");
			const writer = Bun.file("src/b.ts").writer();
			for (let i = 0; ; i++) { writer.write(\`line \${i}\\n\`); writer.flush(); await Bun.sleep(5); }`,
			{ rollback: "file", timeoutMs: 1000 },
		);

		expect(result.timedOut).toBe(true);
		expect(result.applied).toEqual(["src/a.ts"]);
		expect(result.rolledBack).toEqual(["src/b.ts"]);
		expect(await gitStatus(repo)).toBe("M src/a.ts");
	});

	test("reports the commands still running when it times out, and kills them", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, "await $`sleep 31.5`;", { timeoutMs: 1000 });

		expect(result.timedOut).toBe(true);
		expect(result.stillRunning.some((command) => command.includes("sleep 31.5"))).toBe(true);
		expect((await $`pgrep -f "sleep 31.5"`.nothrow().text()).trim()).toBe("");
	});

	test("kills a process the program leaves running, without waiting for it", async () => {
		const repo = await makeRepo(FILES);
		const startedAt = performance.now();
		const result = await run(
			repo,
			`Bun.spawn(["sleep", "32.5"], { stdout: "inherit", stderr: "inherit" }).unref();\nconsole.log("left it running");`,
		);

		expect(result.exitCode).toBe(0);
		expect(performance.now() - startedAt).toBeLessThan(10_000);
		expect((await $`pgrep -f "sleep 32.5"`.nothrow().text()).trim()).toBe("");
	});

	test("an abort applies nothing and puts the repository back", async () => {
		const repo = await makeRepo(FILES);
		const runner = startRunner(repo, `await Bun.write("src/a.ts", "half way");\nawait Bun.sleep(30_000);`, {
			timeoutMs: 60_000,
		});
		await Bun.sleep(1500);
		runner.kill("SIGTERM");
		const result: RunResult = JSON.parse(await new Response(runner.stdout).text());

		expect(result.applied).toEqual([]);
		expect(await gitStatus(repo)).toBe("");
	});

	test("changes git makes to .git aren't applied", async () => {
		const repo = await makeRepo(FILES);
		const head = (await $`git rev-parse HEAD`.cwd(repo).text()).trim();
		await run(repo, "await $`git commit --allow-empty -qm sneaky`.nothrow();");

		expect((await $`git rev-parse HEAD`.cwd(repo).text()).trim()).toBe(head);
	});

	test("applies deleting a whole directory", async () => {
		const repo = await makeRepo({ ...FILES, "src/lib/x.ts": "export {};\n", "src/lib/y.ts": "export {};\n" });
		const result = await run(repo, "await $`rm -rf src/lib`;");

		expect(result.applied).toEqual(["src/lib/x.ts", "src/lib/y.ts"]);
		expect(await gitStatus(repo)).toBe("D src/lib/x.ts\n D src/lib/y.ts");
	});

	test("an application failure restores every earlier filesystem operation", async () => {
		const repo = await makeRepo(FILES);
		await chmod(path.join(repo, "src/a.ts"), 0o751);
		await symlink("a.ts", path.join(repo, "src/link.ts"));
		await $`git add -A && git -c user.name=test -c user.email=test@test commit -qm metadata`.cwd(repo);

		const runner = startRunner(
			repo,
			`await Bun.write("src/a.ts", "program a\\n");
			await Bun.file("src/b.ts").delete();
			await Bun.write("src/new.ts", "new\\n");`,
			{ testApplyFailureAfter: 3 },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(runner.stdout).text(),
			new Response(runner.stderr).text(),
			runner.exited,
		]);

		expect(exitCode, stdout).not.toBe(0);
		expect(stderr).toContain("Injected application failure after 3 change");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		expect((await lstat(path.join(repo, "src/a.ts"))).mode & 0o777).toBe(0o751);
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(FILES["src/b.ts"]);
		expect(await Bun.file(path.join(repo, "src/new.ts")).exists()).toBe(false);
		expect(await readlink(path.join(repo, "src/link.ts"))).toBe("a.ts");
		expect(await gitStatus(repo)).toBe("");
	});

	test("a failure between backup and install restores the original", async () => {
		const repo = await makeRepo(FILES);
		const runner = startRunner(repo, `await Bun.write("src/a.ts", "program a\\n");`, {
			testApplyFailureAfterBackup: 1,
		});
		const [stderr, exitCode] = await Promise.all([new Response(runner.stderr).text(), runner.exited]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Injected application failure after backing up change 1");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		expect(await gitStatus(repo)).toBe("");
	});

	test("backup cleanup failure reports applied changes with a warning", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `await Bun.write("src/a.ts", "program a\\n");`, {
			testCleanupFailure: true,
		});

		expect(result.applied).toEqual(["src/a.ts"]);
		expect(result.warnings).toContainEqual(expect.stringContaining("backup cleanup failed"));
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
		for await (const backup of new Bun.Glob(".pi-shorthand-backup-*").scan({ cwd: path.join(repo, "src") })) {
			await rm(path.join(repo, "src", backup), { recursive: true, force: true });
		}
	});

	test("cancellation before the first commit operation applies nothing", async () => {
		const repo = await makeRepo(FILES);
		const preparedMarker = path.join(path.dirname(repo), "apply-prepared");
		const runner = startRunner(
			repo,
			`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
			{ testBeforeCommitDelayMs: 500, testBeforeCommitMarker: preparedMarker },
		);
		for (let attempt = 0; attempt < 200 && !(await Bun.file(preparedMarker).exists()); attempt++) await Bun.sleep(10);
		expect(await Bun.file(preparedMarker).exists()).toBe(true);
		runner.kill("SIGTERM");
		const result: RunResult = JSON.parse(await new Response(runner.stdout).text());

		expect(await runner.exited).toBe(0);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(FILES["src/b.ts"]);
	});

	test("pre-commit cancellation reports retained cleanup artifacts", async () => {
		const repo = await makeRepo(FILES);
		const preparedMarker = path.join(path.dirname(repo), "apply-prepared-with-cleanup-warning");
		const abort = new AbortController();
		const resultPromise = runWithBun(
			{
				runId: "test",
				cwd: repo,
				program: `await Bun.write("src/a.ts", "program a\\n");`,
				timeoutMs: 5000,
				rollback: "all",
				testBeforeCommitDelayMs: 500,
				testBeforeCommitMarker: preparedMarker,
				testCleanupFailure: true,
			},
			abort.signal,
		);
		for (let attempt = 0; attempt < 200 && !(await Bun.file(preparedMarker).exists()); attempt++) await Bun.sleep(10);
		expect(await Bun.file(preparedMarker).exists()).toBe(true);
		abort.abort();
		const result = await resultPromise;

		expect(result.applied).toEqual([]);
		expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("backup cleanup failed"));
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		for (const entry of await readdir(path.join(repo, "src"))) {
			if (entry.startsWith(".pi-shorthand-backup-")) {
				await rm(path.join(repo, "src", entry), { recursive: true, force: true });
			}
		}
	});

	test("cancellation waits for a commit that has already started", async () => {
		const repo = await makeRepo(FILES);
		const abort = new AbortController();
		const resultPromise = runWithBun(
			{
				runId: "test",
				cwd: repo,
				program: `await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
				timeoutMs: 5000,
				rollback: "all",
				testApplyDelayMs: 500,
			},
			abort.signal,
		);
		for (
			let attempt = 0;
			attempt < 200 && (await textIfFile(path.join(repo, "src/a.ts"))) !== "program a\n";
			attempt++
		) {
			await Bun.sleep(10);
		}
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
		abort.abort();
		const result = await resultPromise;

		expect(result.applied).toEqual(["src/a.ts", "src/b.ts"]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("program b\n");
	});

	test("a late conflict rolls back files already committed", async () => {
		const repo = await makeRepo(FILES);
		const runner = startRunner(
			repo,
			`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
			{ testApplyDelayMs: 500 },
		);
		for (
			let attempt = 0;
			attempt < 200 && (await textIfFile(path.join(repo, "src/a.ts"))) !== "program a\n";
			attempt++
		) {
			await Bun.sleep(10);
		}
		await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
		const result: RunResult = JSON.parse(await new Response(runner.stdout).text());

		expect(await runner.exited).toBe(0);
		expect(result.conflicts).toEqual(["src/b.ts"]);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
	});

	test("rollback continues restoring safe files after one destination changed", async () => {
		const repo = await makeRepo(FILES);
		const runner = startRunner(
			repo,
			`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/api.ts", "program api\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
			{ testApplyDelayMs: 500, testApplyDelayAfter: 2 },
		);
		for (
			let attempt = 0;
			attempt < 200 && (await textIfFile(path.join(repo, "src/api.ts"))) !== "program api\n";
			attempt++
		) {
			await Bun.sleep(10);
		}
		await Bun.write(path.join(repo, "src/api.ts"), "external api\n");
		await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
		const [stderr, exitCode] = await Promise.all([new Response(runner.stderr).text(), runner.exited]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Rollback did not complete");
		expect(stderr).toContain("src/api.ts");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		expect(await Bun.file(path.join(repo, "src/api.ts")).text()).toBe("external api\n");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
		for await (const backup of new Bun.Glob(".pi-shorthand-backup-*").scan({ cwd: path.join(repo, "src") })) {
			await rm(path.join(repo, "src", backup), { recursive: true, force: true });
		}
	});

	test("cancellation preserves a concrete incomplete-rollback failure", async () => {
		const repo = await makeRepo(FILES);
		const abort = new AbortController();
		const outcomePromise = runWithBun(
			{
				runId: "test",
				cwd: repo,
				program: `await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/api.ts", "program api\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
				timeoutMs: 5000,
				rollback: "all",
				testApplyDelayMs: 500,
				testApplyDelayAfter: 2,
			},
			abort.signal,
		).then(
			(result) => result,
			(error: Error) => error,
		);
		for (
			let attempt = 0;
			attempt < 200 && (await textIfFile(path.join(repo, "src/api.ts"))) !== "program api\n";
			attempt++
		) {
			await Bun.sleep(10);
		}
		await Bun.write(path.join(repo, "src/api.ts"), "external api\n");
		await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
		abort.abort();
		const outcome = await outcomePromise;

		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain("Rollback did not complete");
		expect((outcome as Error).message).toContain("src/api.ts");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
		expect(await Bun.file(path.join(repo, "src/api.ts")).text()).toBe("external api\n");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
		for (const entry of await readdir(path.join(repo, "src"))) {
			if (entry.startsWith(".pi-shorthand-backup-")) {
				await rm(path.join(repo, "src", entry), { recursive: true, force: true });
			}
		}
	});

	test("rollback retains an installed file when its backup disappeared", async () => {
		const repo = await makeRepo(FILES);
		const runner = startRunner(
			repo,
			`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
			{ testApplyDelayMs: 500 },
		);
		for (
			let attempt = 0;
			attempt < 200 && (await textIfFile(path.join(repo, "src/a.ts"))) !== "program a\n";
			attempt++
		) {
			await Bun.sleep(10);
		}
		const backupDirs = (await readdir(path.join(repo, "src"))).filter((entry) =>
			entry.startsWith(".pi-shorthand-backup-"),
		);
		let populatedBackup: string | undefined;
		for (const entry of backupDirs) {
			if (await Bun.file(path.join(repo, "src", entry, "original")).exists()) populatedBackup = entry;
		}
		expect(populatedBackup).toBeDefined();
		await rm(path.join(repo, "src", populatedBackup!, "original"), { force: true });
		await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
		const [stderr, exitCode] = await Promise.all([new Response(runner.stderr).text(), runner.exited]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("its backup changed");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
		for (const entry of backupDirs) await rm(path.join(repo, "src", entry), { recursive: true, force: true });
	});

	test("does not clobber a file at the old predictable commit temporary path", async () => {
		const repo = await makeRepo(FILES);
		const collision = path.join(repo, "src/a.ts.pi-shorthand.tmp");
		await Bun.write(collision, "unrelated\n");

		await run(repo, `await Bun.write("src/a.ts", "updated\\n");`);

		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
		expect(await Bun.file(collision).text()).toBe("unrelated\n");
	});

	test("does not follow a symlink at the old predictable commit temporary path", async () => {
		const repo = await makeRepo(FILES);
		const victim = path.join(repo, "victim");
		const collision = path.join(repo, "src/a.ts.pi-shorthand.tmp");
		await Bun.write(victim, "untouched\n");
		await symlink("../victim", collision);

		await run(repo, `await Bun.write("src/a.ts", "updated\\n");`);

		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
		expect(await Bun.file(victim).text()).toBe("untouched\n");
		expect(await readlink(collision)).toBe("../victim");
	});

	test.skipIf(process.platform !== "linux")("staging an untouched untracked file does not delete it", async () => {
		const repo = await makeRepo(FILES);
		const untracked = path.join(repo, "notes.txt");
		await Bun.write(untracked, "keep me\n");

		const result = await run(repo, "await $`git add notes.txt`;");

		expect(result.changes).toEqual([]);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(untracked).text()).toBe("keep me\n");
	});

	test.skipIf(process.platform !== "linux")(
		"newly ignoring an untouched untracked file does not delete it",
		async () => {
			const repo = await makeRepo({ ...FILES, ".gitignore": "" });
			const untracked = path.join(repo, "notes.tmp");
			await Bun.write(untracked, "keep me\n");

			const result = await run(repo, `await Bun.write(".gitignore", "*.tmp\\n");`);

			expect(result.applied).toEqual([".gitignore"]);
			expect(result.changes.map((change) => change.path)).toEqual([".gitignore"]);
			expect(await Bun.file(untracked).text()).toBe("keep me\n");
		},
	);

	test.skipIf(process.platform !== "linux")(
		"deleting an untracked file with a newline in its name still applies",
		async () => {
			const repo = await makeRepo(FILES);
			const file = "odd\nname.txt";
			await Bun.write(path.join(repo, file), "delete me\n");

			const result = await run(repo, `await Bun.file(${JSON.stringify(file)}).delete();`);

			expect(result.changes.map((change) => `${change.kind} ${change.path}`)).toEqual([`deleted ${file}`]);
			expect(result.applied).toEqual([file]);
			expect(await Bun.file(path.join(repo, file)).exists()).toBe(false);
		},
	);

	test("a run keeps reading its starting snapshot after an external edit", async () => {
		const repo = await makeRepo(FILES);
		const ready = path.join(path.dirname(repo), "program-started");
		const edited = path.join(path.dirname(repo), "external-edit-finished");
		const runner = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(ready)}, "ready");
			while (!(await Bun.file(${JSON.stringify(edited)}).exists())) await Bun.sleep(10);
			const original = await Bun.file("src/a.ts").text();
			await Bun.write("src/generated.ts", original);`,
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(ready).exists()).toBe(true);
		await Bun.write(path.join(repo, "src/a.ts"), "external edit\n");
		await Bun.write(edited, "edited");

		const [stdout, stderr] = await Promise.all([
			new Response(runner.stdout).text(),
			new Response(runner.stderr).text(),
		]);
		expect(await runner.exited, stderr).toBe(0);
		const result: RunResult = JSON.parse(stdout);

		expect(result.applied).toEqual(["src/generated.ts"]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external edit\n");
		expect(await Bun.file(path.join(repo, "src/generated.ts")).text()).toBe(FILES["src/a.ts"]);
	});

	test("an external edit to a destination prevents every change from applying", async () => {
		const repo = await makeRepo(FILES);
		const ready = path.join(path.dirname(repo), "conflict-program-started");
		const edited = path.join(path.dirname(repo), "conflict-edit-finished");
		const runner = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(ready)}, "ready");
			while (!(await Bun.file(${JSON.stringify(edited)}).exists())) await Bun.sleep(10);
			await Bun.write("src/a.ts", "program edit\\n");
			await Bun.write("src/generated.ts", "should not apply\\n");`,
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(ready).exists()).toBe(true);
		await Bun.write(path.join(repo, "src/a.ts"), "external edit\n");
		await Bun.write(edited, "edited");

		const [stdout, stderr] = await Promise.all([
			new Response(runner.stdout).text(),
			new Response(runner.stderr).text(),
		]);
		expect(await runner.exited, stderr).toBe(0);
		const result: RunResult = JSON.parse(stdout);

		expect(result.conflicts).toEqual(["src/a.ts"]);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external edit\n");
		expect(await Bun.file(path.join(repo, "src/generated.ts")).exists()).toBe(false);
	});

	test("an external edit to another file survives while the candidate applies", async () => {
		const repo = await makeRepo(FILES);
		const ready = path.join(path.dirname(repo), "different-file-program-started");
		const edited = path.join(path.dirname(repo), "different-file-edit-finished");
		const runner = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(ready)}, "ready");
			while (!(await Bun.file(${JSON.stringify(edited)}).exists())) await Bun.sleep(10);
			await Bun.write("src/a.ts", "program edit\\n");`,
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(ready).exists()).toBe(true);
		await Bun.write(path.join(repo, "src/b.ts"), "external edit\n");
		await Bun.write(edited, "edited");

		const result: RunResult = JSON.parse(await new Response(runner.stdout).text());
		expect(await runner.exited).toBe(0);
		expect(result.conflicts).toEqual([]);
		expect(result.applied).toEqual(["src/a.ts"]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program edit\n");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external edit\n");
	});

	test("external edits survive a failing run on the same or another file", async () => {
		for (const externalFile of ["src/a.ts", "src/b.ts"]) {
			const repo = await makeRepo(FILES);
			const suffix = path.basename(externalFile);
			const ready = path.join(path.dirname(repo), `failed-program-started-${suffix}`);
			const edited = path.join(path.dirname(repo), `failed-edit-finished-${suffix}`);
			const runner = startRunner(
				repo,
				`await Bun.write(${JSON.stringify(ready)}, "ready");
				while (!(await Bun.file(${JSON.stringify(edited)}).exists())) await Bun.sleep(10);
				await Bun.write("src/a.ts", "program edit\\n");
				throw new Error("fail after writing");`,
			);
			for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, externalFile), `external ${suffix}\n`);
			await Bun.write(edited, "edited");

			const result: RunResult = JSON.parse(await new Response(runner.stdout).text());
			expect(await runner.exited).toBe(0);
			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual([]);
			expect(await Bun.file(path.join(repo, externalFile)).text()).toBe(`external ${suffix}\n`);
		}
	});

	test("external edits survive a cancelled run on the same or another file", async () => {
		for (const externalFile of ["src/a.ts", "src/b.ts"]) {
			const repo = await makeRepo(FILES);
			const suffix = path.basename(externalFile);
			const ready = path.join(path.dirname(repo), `cancelled-program-started-${suffix}`);
			const runner = startRunner(
				repo,
				`await Bun.write(${JSON.stringify(ready)}, "ready");
				await Bun.write("src/a.ts", "program edit\\n");
				await Bun.sleep(30_000);`,
				{ timeoutMs: 60_000 },
			);
			for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, externalFile), `external ${suffix}\n`);
			runner.kill("SIGTERM");

			const result: RunResult = JSON.parse(await new Response(runner.stdout).text());
			expect(await runner.exited).toBe(0);
			expect(result.applied).toEqual([]);
			expect(await Bun.file(path.join(repo, externalFile)).text()).toBe(`external ${suffix}\n`);
		}
	});

	test("a parent replaced by a symlink cannot redirect application", async () => {
		const repo = await makeRepo(FILES);
		const ready = path.join(path.dirname(repo), "parent-program-started");
		const edited = path.join(path.dirname(repo), "parent-edit-finished");
		const outside = path.join(path.dirname(repo), "outside");
		await mkdir(outside);
		await Bun.write(path.join(outside, "a.ts"), "outside\n");
		const runner = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(ready)}, "ready");
			while (!(await Bun.file(${JSON.stringify(edited)}).exists())) await Bun.sleep(10);
			await Bun.write("src/a.ts", "program edit\\n");`,
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(ready).exists()).toBe(true);
		await rename(path.join(repo, "src"), path.join(repo, "src-original"));
		await symlink(outside, path.join(repo, "src"));
		await Bun.write(edited, "edited");

		const [stdout, stderr] = await Promise.all([
			new Response(runner.stdout).text(),
			new Response(runner.stderr).text(),
		]);
		expect(await runner.exited, stderr).toBe(0);
		const result: RunResult = JSON.parse(stdout);

		expect(result.conflicts).toEqual(["src/a.ts"]);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(path.join(outside, "a.ts")).text()).toBe("outside\n");
	});

	test("two runs on the same repository both apply", async () => {
		const repo = await makeRepo(FILES);
		const [first, second] = await Promise.all([
			run(repo, `await Bun.sleep(300);\nawait Bun.write("src/one.ts", "export {};\\n");`),
			run(repo, `await Bun.write("src/two.ts", "export {};\\n");`),
		]);

		expect(first.applied).toEqual(["src/one.ts"]);
		expect(second.applied).toEqual(["src/two.ts"]);
		expect(await gitStatus(repo)).toBe("?? src/one.ts\n?? src/two.ts");
	});

	test("two runs changing the same file execute against successive baselines", async () => {
		const repo = await makeRepo(FILES);
		const firstReady = path.join(path.dirname(repo), "first-run-ready");
		const releaseFirst = path.join(path.dirname(repo), "release-first-run");
		const secondReady = path.join(path.dirname(repo), "second-run-ready");
		const first = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(firstReady)}, "ready");
			while (!(await Bun.file(${JSON.stringify(releaseFirst)}).exists())) await Bun.sleep(10);
			await Bun.write("src/a.ts", "first\\n");`,
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(firstReady).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(firstReady).exists()).toBe(true);

		const second = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(secondReady)}, "ready");
			const prior = await Bun.file("src/a.ts").text();
			await Bun.write("src/a.ts", prior + "second\\n");`,
		);
		await Bun.sleep(100);
		expect(await Bun.file(secondReady).exists()).toBe(false);
		await Bun.write(releaseFirst, "release");

		const [firstOut, secondOut] = await Promise.all([
			new Response(first.stdout).text(),
			new Response(second.stdout).text(),
		]);
		expect(await first.exited).toBe(0);
		expect(await second.exited).toBe(0);
		expect((JSON.parse(firstOut) as RunResult).conflicts).toEqual([]);
		expect((JSON.parse(secondOut) as RunResult).conflicts).toEqual([]);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("first\nsecond\n");
	});

	test("a run cancelled while waiting for the lock never starts", async () => {
		const repo = await makeRepo(FILES);
		const firstReady = path.join(path.dirname(repo), "lock-holder-ready");
		const releaseFirst = path.join(path.dirname(repo), "release-lock-holder");
		const secondStarted = path.join(path.dirname(repo), "cancelled-run-started");
		const first = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(firstReady)}, "ready");
			while (!(await Bun.file(${JSON.stringify(releaseFirst)}).exists())) await Bun.sleep(10);`,
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(firstReady).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(firstReady).exists()).toBe(true);

		const second = startRunner(repo, `await Bun.write(${JSON.stringify(secondStarted)}, "started");`);
		await Bun.sleep(100);
		second.kill("SIGTERM");
		expect(await second.exited).not.toBe(0);
		expect(await Bun.file(secondStarted).exists()).toBe(false);

		await Bun.write(releaseFirst, "release");
		expect(await first.exited).toBe(0);
		expect(await Bun.file(secondStarted).exists()).toBe(false);
	});

	test.skipIf(process.platform !== "darwin")("a crashed isolated run leaves the checkout usable", async () => {
		const repo = await makeRepo(FILES);
		const cwdFile = path.join(path.dirname(repo), "isolated-cwd");
		const runner = startRunner(
			repo,
			`await Bun.write(${JSON.stringify(cwdFile)}, process.cwd());\nawait Bun.write("src/a.ts", "half way");\nawait Bun.sleep(30_000);`,
			{
				timeoutMs: 60_000,
			},
		);
		for (let attempt = 0; attempt < 100 && !(await Bun.file(cwdFile).exists()); attempt++) await Bun.sleep(20);
		expect(await Bun.file(cwdFile).exists()).toBe(true);
		const isolatedCwd = await Bun.file(cwdFile).text();
		runner.kill("SIGKILL");
		await runner.exited;
		expect(await gitStatus(repo)).toBe("");

		const result = await run(repo, "");
		expect(result.exitCode).toBe(0);
		expect(await gitStatus(repo)).toBe("");
		expect(await Bun.file(isolatedCwd).exists()).toBe(false);
	});

	test("reports the program line an error came from, even a long one", async () => {
		const repo = await makeRepo(FILES);
		const long = `if (true) throw new Error("${"x".repeat(150)}");`;
		const result = await run(repo, `const a = 1;\nconst b = 2;\n${long}`);

		expect(result.errorLine?.startsWith("line 3: if (true) throw new Error(")).toBe(true);
	});

	test("reports the last step a program logged before timing out in its own code", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `grep("oldApi", "src");\nwhile (true) {}`, { timeoutMs: 1000 });

		expect(result.timedOut).toBe(true);
		expect(result.stillRunning).toEqual([]);
		expect(result.lastStep).toMatch(/^grep\("oldApi","src"\) \(\d+ ms\)$/);
	});

	test("warns about $ commands that aren't awaited", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, "$`touch src/never.ts`;");

		expect(result.warnings).toEqual(["line 1: $`touch src/never.ts` isn't awaited, so the command may not have run"]);
	});
});

describe.skipIf(!hasOverlay)("prelude", () => {
	test("sg.rewrite fills an empty $$$ with nothing, not the literal text", async () => {
		const repo = await makeRepo({ "src/x.ts": "foo();\nfoo(1, 2);\n" });
		await run(repo, `sg.rewrite("foo($$$ARGS)", "bar($$$ARGS)", "src");`);

		expect(await Bun.file(path.join(repo, "src/x.ts")).text()).toBe("bar();\nbar(1, 2);\n");
	});

	test("sg accepts a list of directories, and null to leave a match alone", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`console.log(sg.rewrite("oldApi($A)", (m) => (m.vars.A === "1" ? null : \`newApi(\${m.vars.A})\`), ["."]));`,
		);

		expect(result.output.trim()).toBe("1");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toContain("oldApi(1)");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toContain("newApi(2)");
	});

	test("sg has ast-grep's own API, and programs can import @ast-grep/napi", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`import { parse, Lang } from "@ast-grep/napi";
			const source = await Bun.file("src/a.ts").text();
			console.log(sg.parse(sg.Lang.TypeScript, source).root().findAll("oldApi($A)").length);
			console.log(parse(Lang.TypeScript, source).root().findAll("oldApi($A)").length);`,
		);

		expect(result.output.trim()).toBe("1\n1");
	});

	test("a replacement function can read captures from the match itself, and return false to skip", async () => {
		const repo = await makeRepo(FILES);
		await run(repo, `sg.rewrite("oldApi($A)", (m) => m.A === "1" && \`newApi(\${m.A})\`, "src");`);

		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toContain("newApi(1)");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toContain("oldApi(2)");
	});

	test("glob takes the directory as a string or as { cwd }", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `console.log(JSON.stringify([glob("a.ts", "src"), glob("a.ts", { cwd: "src" })]));`);

		expect(JSON.parse(result.output)).toEqual([["src/a.ts"], ["src/a.ts"]]);
	});

	test("sg warns when the files it's given contain no JS/TS files", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `sg.find("oldApi($A)", ["docs"]);`);

		expect(result.output).toContain('warning: sg.find found no JS/TS files in ["docs"]');
	});

	test("sg.rewrite warns when it matches nothing", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `sg.rewrite("doesNotExist($$$A)", "x", "src");`);

		expect(result.output).toContain('warning: sg.rewrite matched nothing for "doesNotExist($$$A)"');
	});

	test("glob and grep only see files git sees", async () => {
		const repo = await makeRepo({ ...FILES, ".gitignore": "node_modules/\n", "node_modules/dep/index.ts": "oldApi\n" });
		const result = await run(
			repo,
			`console.log(JSON.stringify([glob("**/*.ts"), grep("oldApi").map((m) => m.file)]));`,
		);

		expect(JSON.parse(result.output)).toEqual([
			["src/a.ts", "src/api.ts", "src/b.ts"],
			["src/a.ts", "src/a.ts", "src/api.ts", "src/b.ts", "src/b.ts"],
		]);
	});

	test("glob and sg skip a tracked file the program has deleted", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`await Bun.file("src/b.ts").delete();\nconsole.log(JSON.stringify([glob("src/*.ts"), sg.find("oldApi($A)", "src").length]));`,
		);

		expect(JSON.parse(result.output)).toEqual([["src/a.ts", "src/api.ts"], 1]);
	});

	test("grep's regular expressions support \\d and similar", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, String.raw`console.log(grep(/oldApi\(\d/).length);`);

		expect(result.output.trim()).toBe("2");
	});

	test("the user's global gitignore still applies inside programs", async () => {
		const repo = await makeRepo(FILES);
		const config = path.join(path.dirname(repo), "config");
		await Bun.write(path.join(config, "git", "ignore"), "*.local\n");
		const program = `await Bun.write("notes.local", "x");\nconsole.log(JSON.stringify((await $\`git status --short\`.text()).trim()));`;
		const runner = Bun.spawn(["bun", RUNNER], {
			stdin: new Response(JSON.stringify({ runId: "test", cwd: repo, program, timeoutMs: 5000, rollback: "all" })),
			stdout: "pipe",
			env: { ...process.env, XDG_CONFIG_HOME: config },
		});
		const result: RunResult = JSON.parse(await new Response(runner.stdout).text());

		expect(result.output.trim()).toBe('""');
	});
});
