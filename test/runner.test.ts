/**
 * Runs real programs through runner.ts against small throwaway git repositories.
 * Needs the platform's overlay: AgentFS on macOS (or AGENTFS_BIN), bubblewrap on Linux.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { RunOptions, RunResult } from "../runner.ts";

setDefaultTimeout(30_000);

const RUNNER = path.join(import.meta.dir, "..", "runner.ts");
const hasOverlay =
	process.platform === "darwin"
		? Boolean(process.env.AGENTFS_BIN ?? Bun.which("agentfs"))
		: Boolean(Bun.which("bwrap"));

const repos: string[] = [];
afterEach(async () => {
	for (const repo of repos.splice(0)) await rm(path.dirname(repo), { recursive: true, force: true });
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

	test.skipIf(process.platform !== "linux")(
		"a run keeps reading its starting snapshot after an external edit",
		async () => {
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
		},
	);

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

	test.skipIf(process.platform !== "darwin")("repairs a run that crashed part-way", async () => {
		const repo = await makeRepo(FILES);
		const runner = startRunner(repo, `await Bun.write("src/a.ts", "half way");\nawait Bun.sleep(30_000);`, {
			timeoutMs: 60_000,
		});
		await Bun.sleep(1500);
		runner.kill("SIGKILL");
		await runner.exited;
		expect(await Bun.file(`${repo}.pi-shared/state.json`).exists()).toBe(true);

		const result = await run(repo, "");
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(`${repo}.pi-shared/state.json`).exists()).toBe(false);
		expect(await gitStatus(repo)).toBe("");
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
