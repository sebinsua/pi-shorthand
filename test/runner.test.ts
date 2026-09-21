/**
 * Runs real programs through runner.ts against small throwaway git repositories.
 * Needs the platform's overlay: AgentFS on macOS (or AGENTFS_BIN), bubblewrap on Linux.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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

function startRunner(
	repo: string,
	program: string,
	options: Partial<RunOptions> = {},
	environment: Record<string, string> = {},
) {
	const input: RunOptions = { runId: randomUUID(), cwd: repo, program, timeoutMs: 5000, rollback: "all", ...options };
	return Bun.spawn(["bun", RUNNER], {
		stdin: new Response(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment },
	});
}

type TestHooks = NonNullable<RunOptions["testHooks"]>;
type ApplicationTestHooks = NonNullable<TestHooks["apply"]>;

function withTestHooks(testHooks: TestHooks): Partial<RunOptions> {
	return { testHooks };
}

function withApplicationTestHooks(apply: ApplicationTestHooks): Partial<RunOptions> {
	return withTestHooks({ apply });
}

async function waitUntil(
	description: string,
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	do {
		if (await predicate()) return;
		await Bun.sleep(20);
	} while (performance.now() < deadline);
	throw new Error(`Timed out waiting for ${description}`);
}

async function waitForFile(file: string): Promise<void> {
	await waitUntil(`${JSON.stringify(file)} to exist`, () => Bun.file(file).exists());
}

async function runnerOutcome(runner: ReturnType<typeof startRunner>) {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(runner.stdout).text(),
		new Response(runner.stderr).text(),
		runner.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function run(
	repo: string,
	program: string,
	options: Partial<RunOptions> = {},
	environment: Record<string, string> = {},
): Promise<RunResult> {
	const runner = startRunner(repo, program, options, environment);
	const { stdout, stderr, exitCode } = await runnerOutcome(runner);
	if (exitCode !== 0) throw new Error(`runner failed: ${stderr}`);
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

async function makeMetadataRepo(): Promise<string> {
	const repo = await makeRepo({
		"make-executable.sh": "#!/bin/sh\necho add\n",
		"remove-executable.sh": "#!/bin/sh\necho remove\n",
		"regular-to-link": "regular\n",
		"target-a": "a\n",
		"target-b": "b\n",
	});
	await chmod(path.join(repo, "make-executable.sh"), 0o644);
	await chmod(path.join(repo, "remove-executable.sh"), 0o755);
	await symlink("target-a", path.join(repo, "symlink-to-regular"));
	await symlink("target-a", path.join(repo, "retarget-link"));
	await symlink("target-a", path.join(repo, "delete-link"));
	await $`git add -A && git -c user.name=test -c user.email=test@test commit -qm metadata`.cwd(repo);
	return repo;
}

const METADATA_PROGRAM = `
	const fs = await import("node:fs/promises");
	await fs.chmod("make-executable.sh", 0o755);
	await fs.chmod("remove-executable.sh", 0o644);
	await fs.rm("regular-to-link");
	await fs.symlink("target-b", "regular-to-link");
	await fs.rm("symlink-to-regular");
	await Bun.write("symlink-to-regular", "now regular\\n");
	await fs.rm("retarget-link");
	await fs.symlink("target-b", "retarget-link");
	await fs.symlink("target-a", "added-link");
	await fs.rm("delete-link");
`;

describe.skipIf(!hasOverlay)("runner", () => {
	describe("transaction application", () => {
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
				testHooks: { workspaceCleanupFailure: true },
			});

			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("isolated workspace"));
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
		});

		test("a workspace cleanup failure does not replace the program failure", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, `throw new Error("program failed");`, {
				testHooks: { workspaceCleanupFailure: true },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("program failed");
			expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("isolated workspace"));
		});

		test("applies executable modes and every regular-file/symlink transition", async () => {
			const repo = await makeMetadataRepo();
			const result = await run(repo, METADATA_PROGRAM);

			expect((await lstat(path.join(repo, "make-executable.sh"))).mode & 0o777).toBe(0o755);
			expect((await lstat(path.join(repo, "remove-executable.sh"))).mode & 0o777).toBe(0o644);
			expect(await readlink(path.join(repo, "regular-to-link"))).toBe("target-b");
			expect((await lstat(path.join(repo, "symlink-to-regular"))).isFile()).toBe(true);
			expect(await Bun.file(path.join(repo, "symlink-to-regular")).text()).toBe("now regular\n");
			expect(await readlink(path.join(repo, "retarget-link"))).toBe("target-b");
			expect(await readlink(path.join(repo, "added-link"))).toBe("target-a");
			expect(await lstat(path.join(repo, "delete-link")).catch(() => null)).toBeNull();
			expect(result.changes.find((change) => change.path === "make-executable.sh")).toMatchObject({
				beforeType: "file",
				afterType: "file",
				beforeMode: 0o644,
				afterMode: 0o755,
			});
			expect(result.changes.find((change) => change.path === "regular-to-link")).toMatchObject({
				beforeType: "file",
				afterType: "symlink",
			});
			expect(result.changes.find((change) => change.path === "symlink-to-regular")).toMatchObject({
				beforeType: "symlink",
				afterType: "file",
			});
			expect(result.changes.find((change) => change.path === "retarget-link")?.patch).toContain("target-b");
		});

		test("rolls back executable modes and file/symlink transitions after an application failure", async () => {
			const repo = await makeMetadataRepo();
			const runner = startRunner(repo, METADATA_PROGRAM, withApplicationTestHooks({ failAfter: 7 }));
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Injected application failure after 7 change");
			expect((await lstat(path.join(repo, "make-executable.sh"))).mode & 0o777).toBe(0o644);
			expect((await lstat(path.join(repo, "remove-executable.sh"))).mode & 0o777).toBe(0o755);
			expect((await lstat(path.join(repo, "regular-to-link"))).isFile()).toBe(true);
			expect(await Bun.file(path.join(repo, "regular-to-link")).text()).toBe("regular\n");
			expect(await readlink(path.join(repo, "symlink-to-regular"))).toBe("target-a");
			expect(await readlink(path.join(repo, "retarget-link"))).toBe("target-a");
			expect(await readlink(path.join(repo, "delete-link"))).toBe("target-a");
			expect(await lstat(path.join(repo, "added-link")).catch(() => null)).toBeNull();
		});

		test("rejects an unsupported directory replacement explicitly", async () => {
			const repo = await makeRepo({ victim: "keep\n" });
			const runner = startRunner(
				repo,
				`const fs = await import("node:fs/promises"); await fs.rm("victim"); await fs.mkdir("victim");`,
			);
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Unsupported directory replacement");
			expect(await Bun.file(path.join(repo, "victim")).text()).toBe("keep\n");
		});
	});

	describe("workspace isolation and lifecycle", () => {
		test.skipIf(process.platform !== "linux")(
			"a failing Linux program cannot leave writes outside the repository",
			async () => {
				const repo = await makeRepo(FILES);
				const suffix = randomUUID();
				const homeVictim = path.join(homedir(), `.pi-shorthand-outside-${suffix}`);
				const hostTempVictim = path.join(tmpdir(), `pi-shorthand-outside-${suffix}`);
				const procVictim = `/proc/${process.pid}/root${homeVictim}`;
				try {
					const result = await run(
						repo,
						`let homeBlocked = false, hostTempBlocked = false, procBlocked = false;
				try { await Bun.write(${JSON.stringify(homeVictim)}, "host write"); } catch { homeBlocked = true; }
				try { await Bun.write(${JSON.stringify(hostTempVictim)}, "host temporary write"); } catch { hostTempBlocked = true; }
				try { await Bun.write(${JSON.stringify(procVictim)}, "proc root write"); } catch { procBlocked = true; }
				await Bun.write(process.env.TMPDIR! + "/private-write", "private temporary write");
				await Bun.write("src/a.ts", "repository write\\n");
				console.log({ homeBlocked, hostTempBlocked, procBlocked, tmpdir: process.env.TMPDIR });
				throw new Error("fail after writes");`,
					);

					expect(result.exitCode).not.toBe(0);
					expect(result.output).toContain("homeBlocked: true");
					expect(result.output).toContain("hostTempBlocked: true");
					expect(result.output).toContain("procBlocked: true");
					expect(result.output).toContain('tmpdir: "/dev/shm"');
					expect(await Bun.file(homeVictim).exists()).toBe(false);
					expect(await Bun.file(hostTempVictim).exists()).toBe(false);
					expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
				} finally {
					await rm(homeVictim, { force: true });
					await rm(hostTempVictim, { force: true });
				}
			},
		);

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

		test.skipIf(process.platform !== "darwin")(
			"an ignored state.json directory cannot collide with macOS recovery metadata",
			async () => {
				const repo = await makeRepo({
					".gitignore": "state.json/\n",
					"tracked.txt": "before\n",
				});
				await mkdir(path.join(repo, "state.json"));
				await Bun.write(path.join(repo, "state.json", "kept.txt"), "user data\n");

				const result = await run(repo, `await Bun.write("tracked.txt", "after\\n");`);

				expect(result.exitCode).toBe(0);
				expect(result.applied).toEqual(["tracked.txt"]);
				expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("after\n");
				expect(await Bun.file(path.join(repo, "state.json", "kept.txt")).text()).toBe("user data\n");
				expect((await lstat(repo)).isDirectory()).toBe(true);
			},
		);

		test.skipIf(process.platform !== "darwin")(
			"macOS recovery rejects paths outside owned temporary roots",
			async () => {
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
			},
		);

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

		test('rollback "file" keeps closed files on timeout and rolls back one still open', async () => {
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

		test('rollback "file" finds a timed-out detached child writer', async () => {
			const repo = await makeRepo(FILES);
			const childProgram = `
			const writer = Bun.file("src/b.ts").writer();
			for (let i = 0; ; i++) {
				writer.write(\`partial \${i}\\n\`);
				writer.flush();
				await Bun.sleep(5);
			}`;
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// closed\\n");
			Bun.spawn([process.execPath, "-e", ${JSON.stringify(childProgram)}], {
				cwd: process.cwd(), detached: true, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore"
			}).unref();
			await Bun.sleep(30_000);`,
				{ rollback: "file", timeoutMs: 1000 },
			);

			expect(result.timedOut).toBe(true);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
			expect(await gitStatus(repo)).toBe("M src/a.ts");
		});

		test('rollback "file" retains nothing when open-writer inspection fails', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// closed\\n");
			const writer = Bun.file("src/b.ts").writer();
			writer.write("// open\\n");
			writer.flush();
			await Bun.sleep(30_000);`,
				{ rollback: "file", timeoutMs: 300, testHooks: { writerInspectionFailure: true } },
			);

			expect(result.timedOut).toBe(true);
			expect(result.writerInspectionFailed).toBe(true);
			expect(result.applied).toEqual([]);
			expect(result.rolledBack).toEqual(["src/a.ts", "src/b.ts"]);
			expect(await gitStatus(repo)).toBe("");
		});

		test('rollback "file" applies nothing after an exception with an unclosed writer', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// finished\\n");
			const writer = Bun.file("src/b.ts").writer();
			writer.write("// partial\\n");
			writer.flush();
			throw new Error("failed with writer open");`,
				{ rollback: "file" },
			);

			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual([]);
			expect(result.rolledBack).toEqual(["src/a.ts", "src/b.ts"]);
			expect(await gitStatus(repo)).toBe("");
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

		test("a detached session cannot outlive completion, timeout, or cancellation", async () => {
			for (const outcome of ["completion", "timeout", "cancellation"] as const) {
				const repo = await makeRepo(FILES);
				const token = `pi-shorthand-detached-${randomUUID()}`;
				const program = `Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)", ${JSON.stringify(token)}], {
				detached: true, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore"
			}).unref();
			${outcome === "completion" ? "" : "await Bun.sleep(30_000);"}`;
				try {
					if (outcome === "cancellation") {
						const started = path.join(path.dirname(repo), "detached-program-started");
						const runner = startRunner(repo, program, {
							timeoutMs: 60_000,
							testHooks: { programStartMarker: started },
						});
						await waitForFile(started);
						expect(await Bun.file(started).exists()).toBe(true);
						await Bun.sleep(100);
						runner.kill("SIGTERM");
						await runnerOutcome(runner);
					} else {
						const result = await run(repo, program, { timeoutMs: outcome === "timeout" ? 300 : 5000 });
						expect(result.timedOut).toBe(outcome === "timeout");
					}
					await Bun.sleep(100);
					expect((await $`pgrep -f ${token}`.nothrow().text()).trim()).toBe("");
				} finally {
					await $`pkill -9 -f ${token}`.nothrow().quiet();
				}
			}
		});

		test.skipIf(process.platform !== "darwin")(
			"macOS process cleanup does not terminate another active transaction",
			async () => {
				const firstRepo = await makeRepo(FILES);
				const secondRepo = await makeRepo(FILES);
				const firstToken = `pi-shorthand-isolated-first-${randomUUID()}`;
				const secondToken = `pi-shorthand-isolated-second-${randomUUID()}`;
				const firstProgram = `
				Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)", ${JSON.stringify(firstToken)}], {
					detached: true, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore"
				}).unref();
				await Bun.sleep(30_000);`;
				const secondProgram = firstProgram.replaceAll(firstToken, secondToken);
				const firstStarted = path.join(path.dirname(firstRepo), "first-isolated-run-started");
				const secondStarted = path.join(path.dirname(secondRepo), "second-isolated-run-started");
				const first = startRunner(firstRepo, firstProgram, {
					timeoutMs: 60_000,
					testHooks: { programStartMarker: firstStarted },
				});
				const second = startRunner(secondRepo, secondProgram, {
					timeoutMs: 60_000,
					testHooks: { programStartMarker: secondStarted },
				});
				try {
					await waitUntil(
						"both isolated runs to start",
						async () => (await Bun.file(firstStarted).exists()) && (await Bun.file(secondStarted).exists()),
						4_000,
					);
					await waitUntil("both detached subprocesses to start", async () => {
						const [firstPids, secondPids] = await Promise.all([
							$`pgrep -f ${firstToken}`.nothrow().text(),
							$`pgrep -f ${secondToken}`.nothrow().text(),
						]);
						return Boolean(firstPids.trim() && secondPids.trim());
					});
					expect((await $`pgrep -f ${firstToken}`.nothrow().text()).trim()).not.toBe("");
					expect((await $`pgrep -f ${secondToken}`.nothrow().text()).trim()).not.toBe("");

					first.kill("SIGTERM");
					await runnerOutcome(first);
					expect((await $`pgrep -f ${firstToken}`.nothrow().text()).trim()).toBe("");
					expect((await $`pgrep -f ${secondToken}`.nothrow().text()).trim()).not.toBe("");

					second.kill("SIGTERM");
					await runnerOutcome(second);
					expect((await $`pgrep -f ${secondToken}`.nothrow().text()).trim()).toBe("");
				} finally {
					first.kill("SIGKILL");
					second.kill("SIGKILL");
					await $`pkill -9 -f ${firstToken}`.nothrow().quiet();
					await $`pkill -9 -f ${secondToken}`.nothrow().quiet();
				}
			},
		);

		test("an abort applies nothing and puts the repository back", async () => {
			const repo = await makeRepo(FILES);
			const runner = startRunner(repo, `await Bun.write("src/a.ts", "half way");\nawait Bun.sleep(30_000);`, {
				timeoutMs: 60_000,
			});
			await Bun.sleep(1500);
			runner.kill("SIGTERM");
			const { stdout } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);

			expect(result.applied).toEqual([]);
			expect(await gitStatus(repo)).toBe("");
		});

		test("changes git makes to .git aren't applied", async () => {
			const repo = await makeRepo(FILES);
			const head = (await $`git rev-parse HEAD`.cwd(repo).text()).trim();
			await run(repo, "await $`git commit --allow-empty -qm sneaky`.nothrow();");

			expect((await $`git rev-parse HEAD`.cwd(repo).text()).trim()).toBe(head);
		});

		test("a linked worktree cannot mutate its external Git metadata", async () => {
			for (const shouldFail of [false, true]) {
				const main = await makeRepo(FILES);
				const linkedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "pi-shorthand-linked-")));
				const linked = path.join(linkedRoot, "repo");
				await $`git worktree add -q -b ${`issue-1-${randomUUID()}`} ${linked}`.cwd(main);
				repos.push(linked);

				const gitDir = (await $`git rev-parse --absolute-git-dir`.cwd(linked).text()).trim();
				const indexBefore = await Bun.file(path.join(gitDir, "index")).bytes();
				const headBefore = (await $`git rev-parse HEAD`.cwd(linked).text()).trim();
				const probeRef = `refs/heads/shorthand-probe-${randomUUID()}`;
				const result = await run(
					linked,
					`await Bun.write("src/a.ts", "program edit\\n");
				const add = await $\`git add src/a.ts\`.nothrow().quiet();
				const ref = await $\`git update-ref ${probeRef} HEAD\`.nothrow().quiet();
				console.log({ add: add.exitCode, ref: ref.exitCode });
				${shouldFail ? 'throw new Error("fail after Git writes");' : ""}`,
				);

				expect(result.output).not.toContain("add: 0");
				expect(result.output).not.toContain("ref: 0");
				expect(await Bun.file(path.join(gitDir, "index")).bytes()).toEqual(indexBefore);
				expect((await $`git rev-parse HEAD`.cwd(linked).text()).trim()).toBe(headBefore);
				expect((await $`git show-ref --verify --quiet ${probeRef}`.cwd(linked).nothrow()).exitCode).not.toBe(0);
				expect(await Bun.file(path.join(linked, "src/a.ts")).text()).toBe(
					shouldFail ? FILES["src/a.ts"] : "program edit\n",
				);
			}
		});
	});

	describe("transaction commit and rollback", () => {
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
				withApplicationTestHooks({ failAfter: 3 }),
			);
			const { stdout, stderr, exitCode } = await runnerOutcome(runner);

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
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");`,
				withApplicationTestHooks({ failAfterBackup: 1 }),
			);
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Injected application failure after backing up change 1");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect(await gitStatus(repo)).toBe("");
		});

		test("backup cleanup failure reports applied changes with a warning", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");`,
				withApplicationTestHooks({ cleanupFailure: true }),
			);

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
				withApplicationTestHooks({ beforeCommitDelayMs: 500, beforeCommitMarker: preparedMarker }),
			);
			await waitForFile(preparedMarker);
			expect(await Bun.file(preparedMarker).exists()).toBe(true);
			runner.kill("SIGTERM");
			const { stdout, exitCode } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);

			expect(exitCode).toBe(0);
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
					testHooks: {
						apply: {
							beforeCommitDelayMs: 500,
							beforeCommitMarker: preparedMarker,
							cleanupFailure: true,
						},
					},
				},
				abort.signal,
			);
			await waitForFile(preparedMarker);
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
					testHooks: { apply: { delayMs: 500 } },
				},
				abort.signal,
			);
			await waitUntil(
				"src/a.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/a.ts"))) === "program a\n",
			);
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
				withApplicationTestHooks({ delayMs: 500 }),
			);
			await waitUntil(
				"src/a.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/a.ts"))) === "program a\n",
			);
			await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
			const { stdout, exitCode } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);

			expect(exitCode).toBe(0);
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
				withApplicationTestHooks({ delayMs: 500, delayAfter: 2 }),
			);
			await waitUntil(
				"src/api.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/api.ts"))) === "program api\n",
			);
			await Bun.write(path.join(repo, "src/api.ts"), "external api\n");
			await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
			const { stderr, exitCode } = await runnerOutcome(runner);

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
					testHooks: { apply: { delayMs: 500, delayAfter: 2 } },
				},
				abort.signal,
			).then(
				(result) => result,
				(error: Error) => error,
			);
			await waitUntil(
				"src/api.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/api.ts"))) === "program api\n",
			);
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
				withApplicationTestHooks({ delayMs: 500 }),
			);
			await waitUntil(
				"src/a.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/a.ts"))) === "program a\n",
			);
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
			const { stderr, exitCode } = await runnerOutcome(runner);

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

		test.skipIf(process.platform !== "darwin")(
			"macOS change discovery preserves newline, tab, and Unicode filenames",
			async () => {
				const modified = "src/line\nbreak.ts";
				const deleted = "src/tab\tname.ts";
				const added = "src/雪-added.ts";
				const repo = await makeRepo({ ...FILES, [modified]: "before\n", [deleted]: "delete me\n" });

				const result = await run(
					repo,
					`await Bun.write(${JSON.stringify(modified)}, "after\\n");
				await Bun.file(${JSON.stringify(deleted)}).delete();
				await Bun.write(${JSON.stringify(added)}, "added\\n");`,
				);

				expect(result.exitCode).toBe(0);
				const expected: Array<{ path: string; kind: "added" | "deleted" | "modified" }> = [
					{ path: modified, kind: "modified" as const },
					{ path: deleted, kind: "deleted" as const },
					{ path: added, kind: "added" as const },
				].toSorted((a, b) => a.path.localeCompare(b.path));
				expect(result.changes.map(({ path: filePath, kind }) => ({ path: filePath, kind }))).toEqual(expected);
				expect(result.applied).toEqual(expected.map(({ path: filePath }) => filePath));
				expect(await Bun.file(path.join(repo, modified)).text()).toBe("after\n");
				expect(await Bun.file(path.join(repo, deleted)).exists()).toBe(false);
				expect(await Bun.file(path.join(repo, added)).text()).toBe("added\n");
			},
		);

		test("removing an ignore rule applies newly visible files and tracked ignored files", async () => {
			const repo = await makeRepo({ ".gitignore": "*.tmp\n" });
			await Bun.write(path.join(repo, "tracked.tmp"), "before\n");
			await $`git add -f tracked.tmp && git -c user.name=test -c user.email=test@test commit -qm tracked-ignored`.cwd(
				repo,
			);

			const result = await run(
				repo,
				`await Bun.write(".gitignore", "");
			await Bun.write("tracked.tmp", "after\\n");
			await Bun.write("new.tmp", "new\\n");`,
			);

			expect(result.applied).toEqual([".gitignore", "new.tmp", "tracked.tmp"]);
			expect(await Bun.file(path.join(repo, "new.tmp")).text()).toBe("new\n");
			expect(await Bun.file(path.join(repo, "tracked.tmp")).text()).toBe("after\n");
		});

		test("adding an ignore rule omits a file created by the same transaction", async () => {
			const repo = await makeRepo({ ".gitignore": "" });

			const result = await run(
				repo,
				`await Bun.write(".gitignore", "new.txt\\n");
			await Bun.write("new.txt", "ignored\\n");`,
			);

			expect(result.applied).toEqual([".gitignore"]);
			expect(result.changes.map((change) => change.path)).toEqual([".gitignore"]);
			expect(await Bun.file(path.join(repo, "new.txt")).exists()).toBe(false);
		});
	});

	describe("concurrency and conflict handling", () => {
		test("a run keeps reading its starting snapshot after an external edit", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "program-started");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			const original = await Bun.file("src/a.ts").text();
			await Bun.write("src/generated.ts", original);`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, "src/a.ts"), "external edit\n");

			const { stdout, stderr, exitCode } = await runnerOutcome(runner);
			expect(exitCode, stderr).toBe(0);
			const result: RunResult = JSON.parse(stdout);

			expect(result.applied).toEqual(["src/generated.ts"]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external edit\n");
			expect(await Bun.file(path.join(repo, "src/generated.ts")).text()).toBe(FILES["src/a.ts"]);
		});

		test("an external edit to a destination prevents every change from applying", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "conflict-program-started");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "program edit\\n");
			await Bun.write("src/generated.ts", "should not apply\\n");`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, "src/a.ts"), "external edit\n");

			const { stdout, stderr, exitCode } = await runnerOutcome(runner);
			expect(exitCode, stderr).toBe(0);
			const result: RunResult = JSON.parse(stdout);

			expect(result.conflicts).toEqual(["src/a.ts"]);
			expect(result.applied).toEqual([]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external edit\n");
			expect(await Bun.file(path.join(repo, "src/generated.ts")).exists()).toBe(false);
		});

		test("an external edit to another file survives while the candidate applies", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "different-file-program-started");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "program edit\\n");`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, "src/b.ts"), "external edit\n");

			const { stdout, exitCode } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);
			expect(exitCode).toBe(0);
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
				const runner = startRunner(
					repo,
					`await Bun.sleep(500);
				await Bun.write("src/a.ts", "program edit\\n");
				throw new Error("fail after writing");`,
					{ testHooks: { programStartMarker: ready } },
				);
				await waitForFile(ready);
				expect(await Bun.file(ready).exists()).toBe(true);
				await Bun.write(path.join(repo, externalFile), `external ${suffix}\n`);

				const { stdout, exitCode } = await runnerOutcome(runner);
				const result: RunResult = JSON.parse(stdout);
				expect(exitCode).toBe(0);
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
					`await Bun.write("src/a.ts", "program edit\\n");
				await Bun.sleep(30_000);`,
					{ timeoutMs: 60_000, testHooks: { programStartMarker: ready } },
				);
				await waitForFile(ready);
				expect(await Bun.file(ready).exists()).toBe(true);
				await Bun.write(path.join(repo, externalFile), `external ${suffix}\n`);
				runner.kill("SIGTERM");

				const { stdout, exitCode } = await runnerOutcome(runner);
				const result: RunResult = JSON.parse(stdout);
				expect(exitCode).toBe(0);
				expect(result.applied).toEqual([]);
				expect(await Bun.file(path.join(repo, externalFile)).text()).toBe(`external ${suffix}\n`);
			}
		});

		test("a parent replaced by a symlink cannot redirect application", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "parent-program-started");
			const outside = path.join(path.dirname(repo), "outside");
			await mkdir(outside);
			await Bun.write(path.join(outside, "a.ts"), "outside\n");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "program edit\\n");`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await rename(path.join(repo, "src"), path.join(repo, "src-original"));
			await symlink(outside, path.join(repo, "src"));

			const { stdout, stderr, exitCode } = await runnerOutcome(runner);
			expect(exitCode, stderr).toBe(0);
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
			const secondReady = path.join(path.dirname(repo), "second-run-ready");
			const first = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "first\\n");`,
				{ testHooks: { programStartMarker: firstReady } },
			);
			await waitForFile(firstReady);
			expect(await Bun.file(firstReady).exists()).toBe(true);

			const second = startRunner(
				repo,
				`const prior = await Bun.file("src/a.ts").text();
			await Bun.write("src/a.ts", prior + "second\\n");`,
				{ testHooks: { programStartMarker: secondReady } },
			);
			await Bun.sleep(100);
			expect(await Bun.file(secondReady).exists()).toBe(false);

			const [firstOutcome, secondOutcome] = await Promise.all([runnerOutcome(first), runnerOutcome(second)]);
			expect(firstOutcome.exitCode).toBe(0);
			expect(secondOutcome.exitCode).toBe(0);
			expect((JSON.parse(firstOutcome.stdout) as RunResult).conflicts).toEqual([]);
			expect((JSON.parse(secondOutcome.stdout) as RunResult).conflicts).toEqual([]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("first\nsecond\n");
		});

		test("a run cancelled while waiting for the lock never starts", async () => {
			const repo = await makeRepo(FILES);
			const firstReady = path.join(path.dirname(repo), "lock-holder-ready");
			const secondStarted = path.join(path.dirname(repo), "cancelled-run-started");
			const first = startRunner(repo, `await Bun.sleep(500);`, { testHooks: { programStartMarker: firstReady } });
			await waitForFile(firstReady);
			expect(await Bun.file(firstReady).exists()).toBe(true);

			const second = startRunner(repo, ``, { testHooks: { programStartMarker: secondStarted } });
			await Bun.sleep(100);
			second.kill("SIGTERM");
			expect(await second.exited).not.toBe(0);
			expect(await Bun.file(secondStarted).exists()).toBe(false);

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
			await waitForFile(cwdFile);
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
	});

	describe("diagnostics", () => {
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
			expect(result.lastStep).toMatch(/^grep \(\d+ ms\)$/);
		});

		test("a timeout still returns normally when history is disabled", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`grep("oldApi", "src");\nwhile (true) {}`,
				{ timeoutMs: 300 },
				{
					PI_SHORTHAND_HISTORY: "0",
				},
			);

			expect(result.timedOut).toBe(true);
			expect(result.lastStep).toBeUndefined();
		});

		test("warns about $ commands that aren't awaited", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, "$`touch src/never.ts`;");

			expect(result.warnings).toEqual(["line 1: $`touch src/never.ts` isn't awaited, so the command may not have run"]);
		});
	});
});

describe.skipIf(!hasOverlay)("automatic formatting", () => {
	for (const timeout of [false, true])
		test(`retains the pre-format candidate after formatter ${timeout ? "timeout" : "failure"} with partial writes`, async () => {
			const repo = await makeRepo({
				"a.ts": "before\n",
				"untouched.ts": "unchanged\n",
				"remove.ts": "remove me\n",
				".gitignore": "node_modules/\n",
				"package.json": '{"scripts":{"format":"oxfmt"}}',
			});
			await Bun.write(
				path.join(repo, "node_modules/.bin/oxfmt"),
				`#!${process.execPath}
import { openSync, writeSync, unlinkSync } from "node:fs";
const fd = openSync("a.ts", "w"); writeSync(fd, "truncated");
await Bun.write("new.ts", "damaged");
await Bun.write("formatter-only.ts", "extra");
await Bun.write(".gitignore", "node_modules/\\na.ts\\nnew.ts\\n");
unlinkSync("untouched.ts");
${timeout ? "await Bun.sleep(30_000);" : "process.exit(2);"}
`,
			);
			await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
			const result = await run(
				repo,
				`
				await Bun.write("a.ts", "completed edit\\n");
				await Bun.write("new.ts", "completed addition\\n");
				await Bun.file("remove.ts").delete();
			`,
			);
			expect(result.exitCode).toBe(0);
			expect(result.warnings.join("\n")).toContain(timeout ? "formatting timed out" : "formatting failed");
			expect(result.applied).toEqual(["a.ts", "new.ts", "remove.ts"]);
			expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("completed edit\n");
			expect(await Bun.file(path.join(repo, "new.ts")).text()).toBe("completed addition\n");
			expect(await Bun.file(path.join(repo, "untouched.ts")).text()).toBe("unchanged\n");
			expect(await Bun.file(path.join(repo, ".gitignore")).text()).toBe("node_modules/\n");
			expect(await Bun.file(path.join(repo, "remove.ts")).exists()).toBe(false);
			expect(await Bun.file(path.join(repo, "formatter-only.ts")).exists()).toBe(false);
			expect(result.changes.find((change) => change.path === "a.ts")?.patch).toContain("+completed edit");
		});

	test("formats before diffing, includes additional formatter writes and preserves edits on formatter failure", async () => {
		const repo = await makeRepo({
			"a.ts": "before\n",
			"untouched.ts": "unchanged\n",
			".gitignore": "node_modules/\n",
			"package.json": '{"scripts":{"format":"oxfmt"}}',
		});
		await Bun.write(
			path.join(repo, "node_modules/.bin/oxfmt"),
			`#!${process.execPath}\nfor (const file of process.argv.slice(2)) await Bun.write(file, "formatted\\n"); await Bun.write("extra.ts", "extra\\n");`,
		);
		await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
		const result = await run(repo, 'await Bun.write("a.ts", "candidate\\n");');
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Formatted 1 file(s) with oxfmt");
		expect(result.applied).toEqual(["a.ts", "extra.ts"]);
		expect(result.changes.find((change) => change.path === "a.ts")?.patch).toContain("+formatted");
		expect(await Bun.file(path.join(repo, "untouched.ts")).text()).toBe("unchanged\n");
		await Bun.write(path.join(repo, "node_modules/.bin/oxfmt"), "#!/bin/sh\necho format-error >&2\nexit 1\n");
		const failure = await run(repo, 'await Bun.write("a.ts", "retained\\n");');
		expect(failure.exitCode).toBe(0);
		expect(failure.warnings.join("\n")).toContain("format-error");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("retained\n");
	});

	test("skips formatting failed programs and when disabled", async () => {
		const repo = await makeRepo({
			"a.ts": "before\n",
			".gitignore": "node_modules/\n",
			"package.json": '{"scripts":{"format":"oxfmt"}}',
		});
		await Bun.write(path.join(repo, "node_modules/.bin/oxfmt"), "#!/bin/sh\necho should-not-run >&2\nexit 1\n");
		await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
		const failed = await run(repo, 'await Bun.write("a.ts", "candidate"); throw Error("edit failed");');
		expect(failed.exitCode).toBe(1);
		expect(failed.warnings.join("\n")).not.toContain("should-not-run");
		const disabled = await run(repo, 'await Bun.write("a.ts", "candidate");', {}, { PI_SHORTHAND_FORMAT: "0" });
		expect(disabled.warnings.join("\n")).not.toContain("should-not-run");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("candidate");
	});
});

describe.skipIf(!hasOverlay)("prelude", () => {
	test("glob and grep throw with Git diagnostics while grep no-match remains empty", async () => {
		const repo = await makeRepo({ ...FILES, ".gitignore": "fake/\n" });
		const result = await run(
			repo,
			`const fs = await import("node:fs/promises");
			await fs.mkdir("fake");
			await Bun.write("fake/git", "#!/bin/sh\\necho git exploded >&2\\nexit 2\\n");
			await fs.chmod("fake/git", 0o755);
			process.env.PATH = process.cwd() + "/fake:" + process.env.PATH;
			for (const [name, call] of [["glob", () => glob("**/*")], ["grep", () => grep("oldApi")]]) {
				try { call(); } catch (error) { console.log(name + ": " + error.message); }
			}`,
		);

		expect(result.output).toContain("glob: git ls-files failed (exit 2): git exploded");
		expect(result.output).toContain("grep: git grep failed (exit 2): git exploded");

		const noMatch = await run(repo, `console.log(JSON.stringify(grep("definitely absent")));`);
		expect(noMatch.output.trim()).toBe("[]");
	});

	test("grep rejects malformed Git output", async () => {
		const repo = await makeRepo({ ...FILES, ".gitignore": "fake/\n" });
		const result = await run(
			repo,
			`const fs = await import("node:fs/promises");
			await fs.mkdir("fake");
			await Bun.write("fake/git", "#!/bin/sh\\nprintf 'broken\\n'\\n");
			await fs.chmod("fake/git", 0o755);
			process.env.PATH = process.cwd() + "/fake:" + process.env.PATH;
			grep("anything");`,
		);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('git grep returned malformed output: "broken\\n"');
	});

	test("grep preserves newline, tab, and Unicode filenames", async () => {
		const files = {
			"src/line\nbreak.ts": "needle newline\n",
			"src/tab\tname.ts": "needle tab\n",
			"src/雪.ts": "needle Unicode\n",
		};
		const repo = await makeRepo(files);
		const result = Bun.spawnSync(
			[
				"bun",
				"--preload",
				path.join(import.meta.dir, "../prelude.ts"),
				"-e",
				`console.log(JSON.stringify(grep("needle")));`,
			],
			{ cwd: repo, env: { ...process.env, PI_SHORTHAND_LOG: "" } },
		);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual([
			{ file: "src/line\nbreak.ts", line: 1, text: "needle newline" },
			{ file: "src/tab\tname.ts", line: 1, text: "needle tab" },
			{ file: "src/雪.ts", line: 1, text: "needle Unicode" },
		]);
	});

	test("grit rejects partial output on failure and malformed successful JSONL", async () => {
		for (const malformed of [false, true]) {
			const repo = await makeRepo({ ...FILES, ".gitignore": "fake/\n" });
			const body = malformed
				? "printf 'not-json\\n'"
				: 'printf \'%s\\n\' \'{"original":{"sourceFile":"src/a.ts","ranges":[{}]}}\'; echo grit exploded >&2; exit 2';
			const result = await run(
				repo,
				`const fs = await import("node:fs/promises");
				await fs.mkdir("fake");
				await Bun.write("fake/grit", ${JSON.stringify("#!/bin/sh\n")} + ${JSON.stringify(body)} + "\\n");
				await fs.chmod("fake/grit", 0o755);
				process.env.PATH = process.cwd() + "/fake:" + process.env.PATH;
				grit("pattern", "src");`,
			);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(
				malformed ? "grit returned malformed JSONL" : "grit failed (exit 2): grit exploded",
			);
		}
	});

	test("sg validates every scope before any file is edited", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`
			for (const helper of ["find", "one", "rewrite"]) {
				try {
					const files = ["src/a.ts", { file: "src/b.ts" }];
					if (helper === "rewrite") sg.rewrite("oldApi($A)", "newApi($A)", files);
					else sg[helper]("oldApi($A)", files);
				} catch (error) { console.log(error.message); }
			}`,
		);
		for (const helper of ["find", "one", "rewrite"])
			expect(result.output).toContain(`sg.${helper}: files must be paths, sg.file() targets, or an array of either`);
		expect(result.exitCode).toBe(0);
		expect(result.changes).toEqual([]);
	});

	test("sg accepts file targets, deduplicates mixed scopes and reads fresh source", async () => {
		const repo = await makeRepo({ "a.ts": "oldApi(1);\n", "b.ts": "oldApi(2);\n" });
		const result = await run(
			repo,
			`
			const a = sg.file("a.ts");
			console.log(sg.one("oldApi($A)", a).A);
			console.log(sg.find("oldApi($A)", [a, "a.ts", sg.file("b.ts")]).length);
			console.log(sg.rewrite("oldApi($A)", "newApi($A)", [a, "a.ts", sg.file("b.ts")]));
			console.log(sg.one("newApi($A)", a).A);
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(["1", "2", "2", "1"]);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("newApi(1);\n");
		expect(await Bun.file(path.join(repo, "b.ts")).text()).toBe("newApi(2);\n");
	});

	test("sg file targets explicitly select ignored files without changing apply eligibility", async () => {
		const repo = await makeRepo({ ".gitignore": "ignored.ts\n", "a.ts": "oldApi(1);\n", "ignored.ts": "oldApi(2);\n" });
		const result = await run(
			repo,
			`
			const target = sg.file("ignored.ts");
			console.log(sg.find("oldApi($A)", ".").length);
			console.log(sg.one("oldApi($A)", target).A);
			console.log(sg.rewrite("oldApi($A)", "newApi($A)", target));
			console.log(await Bun.file("ignored.ts").text());
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(["1", "2", "1", "newApi(2);"]);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(path.join(repo, "ignored.ts")).text()).toBe("oldApi(2);\n");
	});

	test("sg rejects missing or escaped targets before rewriting any file", async () => {
		const repo = await makeRepo({ "a.ts": "oldApi(1);\n" });
		const result = await run(
			repo,
			`
			const missing = sg.file("new.ts");
			try { sg.rewrite("oldApi($A)", "newApi($A)", ["a.ts", missing]); }
			catch (error) { console.log(error.message); }
			const escaped = sg.file("a.ts");
			escaped.file = "../escape.ts";
			try { sg.find("oldApi($A)", escaped); }
			catch (error) { console.log(error.message); }
			console.log(await Bun.file("new.ts").exists());
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('sg.rewrite: file target does not exist or is not a file: "new.ts"');
		expect(result.output).toContain("path is outside the repository");
		expect(result.output.trim()).toEndWith("false");
		expect(result.changes).toEqual([]);
	});

	test("grit resolves scopes from a subdirectory without doubling the directory", async () => {
		const repo = await makeRepo({
			"src/a.ts": "oldApi(1);\n",
			"src/b.ts": "oldApi(2);\n",
			"src/src/a.ts": "oldApi(99);\n",
			"outside.ts": "oldApi(3);\n",
		});
		const result = await run(
			repo,
			`
			process.chdir("src");
			grit("\`oldApi($x)\` => \`explicit($x)\`", "a.ts");
			grit("\`oldApi($x)\` => \`globbed($x)\`", "*.ts");
			grit("\`explicit($x)\` => \`targeted($x)\`", sg.file("a.ts"));
			grit("\`globbed($x)\` => \`directory($x)\`", ".");
		`,
			{ timeoutMs: 15_000 },
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toContain("targeted(1)");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toContain("directory(2)");
		expect(await Bun.file(path.join(repo, "src/src/a.ts")).text()).toBe("oldApi(99);\n");
		expect(await Bun.file(path.join(repo, "outside.ts")).text()).toBe("oldApi(3);\n");
	});

	test("grit expands globs, accepts file targets and never falls back to all files on an empty scope", async () => {
		const repo = await makeRepo({ "a.ts": "oldApi(1);\n", "b.ts": "oldApi(2);\n", "other.js": "oldApi(3);\n" });
		const result = await run(
			repo,
			`
			grit("\`oldApi($x)\` => \`newApi($x)\`", "*.ts");
			grit("\`newApi($x)\` => \`done($x)\`", sg.file("a.ts"));
			console.log(JSON.stringify(grit("\`oldApi($x)\` => \`wrong($x)\`", "missing-*.ts")));
		`,
			{ timeoutMs: 15_000 },
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain("warning: grit found no files");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toContain("done(1)");
		expect(await Bun.file(path.join(repo, "b.ts")).text()).toContain("newApi(2)");
		expect(await Bun.file(path.join(repo, "other.js")).text()).toBe("oldApi(3);\n");
	});

	test("sg suggests an executable contextual pattern for a standalone class method", async () => {
		const source = "class C { format(x: number): string { return String(x); } }\n";
		const repo = await makeRepo({ "src/a.ts": source });
		const failure = await run(repo, 'sg.one("format($$$PARAMS): string { $$$BODY }", "src/a.ts");');
		expect(failure.exitCode).toBe(1);
		expect(failure.output).toContain("sg.one:");
		const suggestion = failure.output.match(/Replace only the pattern argument with (\{[^\n]+\})\./)?.[1];
		expect(suggestion).toBeDefined();
		const pattern = JSON.parse(suggestion!);
		const correction = await run(
			repo,
			`sg.rewrite(${JSON.stringify(pattern)}, m => m.text.replace("String(x)", "String(x + 1)"), "src/a.ts");`,
		);
		expect(correction.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(source.replace("String(x)", "String(x + 1)"));
	});

	test("sg leaves unrelated invalid patterns as errors without suggesting a class-method match", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			'try { sg.rewrite("a(); b();", "c();", "src/a.ts"); } catch (error) { console.log(error.message); }',
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("sg.rewrite:");
		expect(result.output).toContain("Patterns must parse as one syntax node");
		expect(result.output).not.toContain("This class-method pattern");
		expect(result.applied).toEqual([]);
	});

	test("sg.rewrite fills an empty $$$ with nothing, not the literal text", async () => {
		const repo = await makeRepo({ "src/x.ts": "foo();\nfoo(1, 2);\n" });
		await run(repo, `sg.rewrite("foo($$$ARGS)", "bar($$$ARGS)", "src");`);

		expect(await Bun.file(path.join(repo, "src/x.ts")).text()).toBe("bar();\nbar(1, 2);\n");
	});

	test("sg.rewrite rejects overlapping nested edits", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(foo(1));\n" });
		const result = await run(repo, `sg.rewrite("foo($A)", "bar($A)", "src/a.ts");`);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('sg.rewrite produced overlapping edits in "src/a.ts"');
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("foo(foo(1));\n");
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

	test("glob and sg normalize scopes and exclude explicitly named ignored files", async () => {
		const repo = await makeRepo({
			".gitignore": "src/ignored.ts\n",
			"src/a.ts": "oldApi(1);\n",
			"src/a.html": "<p>hello</p>\n",
			"src/ignored.ts": "oldApi(2);\n",
		});
		const result = await run(
			repo,
			`const absolute = process.cwd() + "/src";
			console.log(JSON.stringify([
				glob("*.ts", "./src"),
				glob("*.ts", absolute),
				sg.find("<p>$A</p>", "./src").map((match) => match.file),
				sg.find("<p>$A</p>", absolute).map((match) => match.file),
				sg.find("oldApi($A)", "src/a.ts").map((match) => match.file),
				sg.find("oldApi($A)", "src/ignored.ts").length,
			]));`,
		);

		expect(JSON.parse(result.output.trim().split("\n").at(-1)!)).toEqual([
			["src/a.ts"],
			["src/a.ts"],
			["src/a.html"],
			["src/a.html"],
			["src/a.ts"],
			0,
		]);
	});

	test("sg warns when the files it's given contain no JS/TS files", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `sg.find("oldApi($A)", ["docs"]);`);

		expect(result.output).toContain('warning: sg.find found no supported files in ["docs"]');
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

	test("glob includes a tracked dangling symlink", async () => {
		const repo = await makeRepo(FILES);
		await symlink("missing-target", path.join(repo, "src/dangling.ts"));
		await $`git add src/dangling.ts && git -c user.name=test -c user.email=test@test commit -qm symlink`.cwd(repo);

		const result = await run(repo, `console.log(JSON.stringify(glob("src/*.ts")));`);

		expect(JSON.parse(result.output)).toContain("src/dangling.ts");
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
