/**
 * Runs a Bun program against an isolated view of a git repository. The program's writes go to a
 * copy-on-write overlay; afterwards they're diffed, then applied to the repository or discarded.
 *
 * Usage: echo '<RunOptions as JSON>' | bun runner.ts   → prints a RunResult as JSON
 * SIGTERM aborts: the program is killed, the overlay is closed and nothing is applied.
 * Each step is logged to ~/.cache/pi-shorthand/runs.jsonl, so `tail -f` shows what a run is doing.
 *
 * If the program fails:
 * - rollback "all": nothing is applied;
 * - rollback "file": every file it finished writing is applied. Files it (or a subprocess) still
 *   had open for writing when it was killed may be half-written, so they're rolled back.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, constants, mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { $ } from "bun";
import { structuredPatch } from "diff";
import { openLinuxOverlay } from "./overlay-linux.ts";
import { openMacOverlay } from "./overlay-macos.ts";

export interface RunOptions {
	runId: string; // identifies this run's events in the log
	cwd: string;
	program: string;
	timeoutMs: number;
	rollback: "all" | "file";
	testApplyFailureAfter?: number;
	testApplyDelayMs?: number;
	testApplyDelayAfter?: number;
	testApplyFailureAfterBackup?: number;
	testBeforeCommitDelayMs?: number;
	testBeforeCommitMarker?: string;
	testCleanupFailure?: boolean;
	testWorkspaceCleanupFailure?: boolean;
}

export interface RunResult {
	exitCode: number | null; // null if it was killed
	timedOut: boolean;
	durationMs: number;
	output: string; // stdout and stderr
	warnings: string[]; // likely mistakes spotted in the program before it ran
	cleanupWarnings: string[]; // application/cleanup completed with a non-fatal infrastructure warning
	changes: FileChange[]; // everything the program changed
	applied: string[]; // the changed files that were applied
	conflicts: string[]; // destinations changed after the run's baseline was captured
	rolledBack: string[]; // rollback "file": changed files left half-written, so not applied
	stillRunning: string[]; // on timeout: commands the program was still running, e.g. "find / -name x (for 58s)"
	lastStep?: string; // on timeout: the last step the program logged, e.g. "$ find / -name x" or "grep (18 ms)"
	errorLine?: string; // on failure: the program's line the error came from, e.g. "line 3: throw new Error(…)"
	timeoutMs: number;
	rollback: RunOptions["rollback"];
}

export interface FileChange {
	path: string; // relative to the tool's working directory
	kind: "added" | "modified" | "deleted";
	patch: string;
}

/** A copy-on-write view of the repository. */
export interface Overlay {
	originalDir: string; // where the original files are while the overlay is open
	writableDir: string; // writing a file here puts it into the overlay
	executionDir: string; // repository root as seen by the program process
	gitExcludes: string[]; // extra patterns git should ignore inside the overlay
	wrap(command: string[], cwd: string): string[]; // makes a command run inside the overlay
	changes(): Promise<{ file: string; contents: Uint8Array | null }[]>; // may include files only read
	close(): Promise<void>;
}

/** A changed file, relative to the repository root, with its new contents (null if deleted). */
interface Change {
	file: string;
	before: Uint8Array | null;
	after: Uint8Array | null;
}

const PROGRAM_FILE = ".pi-shorthand-program.ts";
const PRELUDE = path.join(import.meta.dir, "prelude.ts");
// Our dependencies are in the nearest node_modules that has them: our own, or, when npm hoisted them
// (e.g. Pi's project installs), one further up. Like `npm run`, look in every one from here up.
const NODE_MODULES = ancestors(import.meta.dir).map((dir) => path.join(dir, "node_modules"));
const MAX_OUTPUT_CHARS = 1024 * 1024; // a safety cap; index.ts decides how much the model sees
const LOG_FILE = path.join(homedir(), ".cache", "pi-shorthand", "runs.jsonl");
let RUN_ID = ""; // set from RunOptions when the runner starts

/** Appends one event to the log, e.g. log("program exited", { exitCode: 0 }). */
function log(event: string, details: Record<string, unknown> = {}) {
	appendFileSync(LOG_FILE, `${JSON.stringify({ time: new Date().toISOString(), run: RUN_ID, event, ...details })}\n`);
}

async function run(options: RunOptions, abort: AbortSignal): Promise<RunResult> {
	const startedAt = performance.now();
	const cwd = await fs.realpath(options.cwd);
	const repo = await findRepository(cwd);
	const releaseLock = await takeRepositoryLock(repo, abort);
	let tempDir: string | undefined;
	let result: RunResult | undefined;
	let primaryError: unknown;
	const runCleanupWarnings: string[] = [];

	try {
		tempDir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "pi-shorthand-"));
		log("started", { repo, cwd, timeoutMs: options.timeoutMs, rollback: options.rollback });
		const open = process.platform === "darwin" ? openMacOverlay : openLinuxOverlay;
		const overlay = await open(repo, tempDir);
		log("overlay opened");
		let program: ProgramRun;
		let changes: Change[];
		let executionError: unknown;
		try {
			program = await runProgram({ ...options, cwd }, abort, overlay, repo, tempDir);
			changes = await findChanges(overlay);
		} catch (error) {
			executionError = error;
			throw error;
		} finally {
			try {
				await closeOverlay(overlay, options.testWorkspaceCleanupFailure);
			} catch (error) {
				const warning = cleanupWarning("isolated workspace", error);
				if (executionError) attachCleanupWarning(executionError, warning);
				else runCleanupWarnings.push(warning);
			}
		}

		const shown = (file: string) => path.relative(cwd, path.join(repo, file));
		const { applied: requested, rolledBack } = whatToApply(changes, program, options.rollback, abort.aborted);
		let conflicts = await conflictingFiles(repo, requested);
		let applied: Change[] = [];
		let applicationWarnings: string[] = [];
		if (conflicts.length === 0) {
			({
				applied,
				conflicts,
				warnings: applicationWarnings,
			} = await applyChanges(
				repo,
				requested,
				abort,
				options.testApplyFailureAfter,
				options.testApplyDelayMs,
				options.testApplyDelayAfter,
				options.testApplyFailureAfterBackup,
				options.testBeforeCommitDelayMs,
				options.testCleanupFailure,
				options.testBeforeCommitMarker,
			));
		}
		log("finished", {
			changed: changes.map((change) => change.file),
			applied: applied.map((change) => change.file),
			conflicts,
		});

		result = {
			exitCode: program.exitCode,
			timedOut: program.timedOut,
			durationMs: Math.round(performance.now() - startedAt),
			output: program.output,
			warnings: [...lint(options.program), ...applicationWarnings, ...runCleanupWarnings],
			cleanupWarnings: [...applicationWarnings, ...runCleanupWarnings],
			changes: changes.map((change) => describe(shown(change.file), change)),
			applied: applied.map((change) => shown(change.file)),
			conflicts: conflicts.map(shown),
			rolledBack: rolledBack.map((change) => shown(change.file)),
			stillRunning: program.stillRunning,
			lastStep: program.timedOut ? await lastLoggedStep() : undefined,
			errorLine: program.exitCode !== 0 ? failingLine(options.program, program.output) : undefined,
			timeoutMs: options.timeoutMs,
			rollback: options.rollback,
		};
		return result;
	} catch (error) {
		primaryError = error;
		for (const warning of runCleanupWarnings) attachCleanupWarning(error, warning);
		throw error;
	} finally {
		const finalWarnings: string[] = [];
		try {
			if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		} catch (error) {
			finalWarnings.push(cleanupWarning("temporary workspace", error));
		}
		try {
			await releaseLock();
		} catch (error) {
			finalWarnings.push(cleanupWarning("repository lock", error));
		}
		if (result) {
			result.warnings.push(...finalWarnings);
			result.cleanupWarnings.push(...finalWarnings);
		} else if (primaryError) {
			for (const warning of finalWarnings) attachCleanupWarning(primaryError, warning);
		}
	}
}

async function closeOverlay(overlay: Overlay, injectFailure = false) {
	await overlay.close();
	if (injectFailure) throw new Error("Injected isolated-workspace cleanup failure.");
}

function cleanupWarning(resource: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const warning = `The run reached its reported outcome, but cleanup of its ${resource} failed: ${detail}`;
	log("cleanup warning", { warning });
	return warning;
}

function attachCleanupWarning(error: unknown, warning: string) {
	if (!(error instanceof Error)) return;
	const annotated = error as Error & { cleanupWarnings?: string[] };
	annotated.cleanupWarnings = [...(annotated.cleanupWarnings ?? []), warning];
}

/** Serializes shorthand baselines and commits for one repository, including across runner processes. */
async function takeRepositoryLock(repo: string, abort: AbortSignal): Promise<() => Promise<void>> {
	const lock = await repositoryLockPath(repo);
	const ownerFile = path.join(lock, "owner.json");
	for (let attempt = 0; attempt < 3000; attempt++) {
		abort.throwIfAborted();
		try {
			await fs.mkdir(lock);
			try {
				await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid }));
			} catch (error) {
				await fs.rmdir(lock).catch(() => {});
				throw error;
			}
			return async () => {
				await fs.rm(ownerFile, { force: true });
				await fs.rmdir(lock);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = await Bun.file(ownerFile)
			.json()
			.catch(() => null);
		if (typeof owner?.pid === "number" && !processAlive(owner.pid)) {
			await fs.rm(ownerFile, { force: true });
			await fs.rmdir(lock).catch(() => {});
			continue;
		}
		if (!owner && (await olderThan(lock, 1000))) {
			await fs.rmdir(lock).catch(() => {});
			continue;
		}
		await Bun.sleep(20);
	}
	throw new Error("Another shorthand run on this repository did not finish within a minute.");
}

/** A per-checkout lock in stable user-writable storage (the macOS overlay moves the checkout). */
async function repositoryLockPath(repo: string): Promise<string> {
	const lockRoot = path.join(homedir(), ".cache", "pi-shorthand", "locks");
	await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
	const stats = await fs.lstat(lockRoot);
	if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid && stats.uid !== process.getuid())) {
		throw new Error(`Unsafe shorthand lock directory: ${lockRoot}`);
	}
	if ((stats.mode & 0o077) !== 0) await fs.chmod(lockRoot, 0o700);
	const checkout = createHash("sha256").update(repo).digest("hex").slice(0, 16);
	return path.join(lockRoot, checkout);
}

async function olderThan(file: string, milliseconds: number): Promise<boolean> {
	const stats = await fs.stat(file).catch(() => null);
	return Boolean(stats && Date.now() - stats.mtimeMs > milliseconds);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Changed destinations make the whole host-side application fail before its first write. */
async function conflictingFiles(repo: string, changes: Change[]): Promise<string[]> {
	const conflicts = [];
	for (const change of changes) {
		if (!(await destinationMatches(repo, change))) conflicts.push(change.file);
	}
	return conflicts;
}

/** Compares through a no-follow file descriptor and rechecks the path leading to it. */
async function destinationMatches(repo: string, change: Change): Promise<boolean> {
	const target = path.join(repo, change.file);
	if (!(await safeParentChain(repo, target))) return false;
	if (!change.before) {
		try {
			await fs.lstat(target);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return safeParentChain(repo, target);
		}
	}

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile()) return false;
		const contents = await handle.readFile();
		const after = await handle.stat();
		const unchangedWhileRead =
			before.dev === after.dev &&
			before.ino === after.ino &&
			before.mode === after.mode &&
			before.size === after.size &&
			before.mtimeMs === after.mtimeMs &&
			before.ctimeMs === after.ctimeMs;
		if (!unchangedWhileRead || !Buffer.from(change.before).equals(contents)) return false;
		if (!(await safeParentChain(repo, target))) return false;
		const leaf = await fs.lstat(target);
		return leaf.isFile() && leaf.dev === after.dev && leaf.ino === after.ino;
	} catch (error) {
		if (["ENOENT", "ELOOP", "EISDIR", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/** Every existing ancestor must remain a real directory inside the checkout, never a symlink. */
async function safeParentChain(repo: string, target: string): Promise<boolean> {
	const relative = path.relative(repo, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	let parent = path.dirname(target);
	while (parent !== repo) {
		const stats = await fs.lstat(parent).catch(() => null);
		if (!stats?.isDirectory() || stats.isSymbolicLink()) return false;
		parent = path.dirname(parent);
	}
	return true;
}

/** Nothing if aborted. Everything if the program succeeded. If it failed, nothing, unless rollback is "file". */
function whatToApply(changes: Change[], program: ProgramRun, rollback: RunOptions["rollback"], aborted: boolean) {
	if (aborted) return { applied: [], rolledBack: [] };
	if (program.exitCode === 0) return { applied: changes, rolledBack: [] };
	if (rollback === "all") return { applied: [], rolledBack: [] };

	const halfWritten = (change: Change) => program.openForWriting.includes(change.file);
	return { applied: changes.filter((change) => !halfWritten(change)), rolledBack: changes.filter(halfWritten) };
}

/** A `$` command that isn't awaited never runs: Bun's shell starts a command when it's awaited. */
const UNAWAITED_SHELL = {
	rule: {
		kind: "call_expression",
		has: { field: "function", regex: "^\\$$" },
		not: {
			inside: {
				any: [{ kind: "await_expression" }, { kind: "return_statement" }],
				stopBy: { kind: "statement_block" },
			},
		},
	},
};

/** Likely mistakes in the program, found without running it. */
function lint(program: string): string[] {
	const root = parse(Lang.TypeScript, program).root();
	return root.findAll(UNAWAITED_SHELL).map((node) => {
		const line = node.range().start.line + 1;
		return `line ${line}: ${node.text().split("\n")[0]} isn't awaited, so the command may not have run`;
	});
}

async function findRepository(cwd: string): Promise<string> {
	const result = await $`git rev-parse --show-toplevel`.cwd(cwd).nothrow().quiet();
	if (result.exitCode !== 0) throw new Error("The code tool only works inside a git repository.");
	return fs.realpath(result.text().trim());
}

// ── Running the program ───────────────────────────────────────────────────────────

interface ProgramRun {
	exitCode: number | null;
	timedOut: boolean;
	output: string;
	openForWriting: string[]; // on timeout: files it still had open for writing
	stillRunning: string[]; // on timeout: the commands it was still running
}

async function runProgram(
	options: RunOptions,
	abort: AbortSignal,
	overlay: Overlay,
	repo: string,
	tempDir: string,
): Promise<ProgramRun> {
	abort.throwIfAborted();
	// The program file goes into the working directory, so its relative imports resolve as usual.
	const programPath = path.join(options.cwd, PROGRAM_FILE);
	const programFile = path.join(overlay.writableDir, path.relative(repo, programPath));
	const executionCwd = path.join(overlay.executionDir, path.relative(repo, options.cwd));
	const executionProgramPath = path.join(executionCwd, PROGRAM_FILE);
	const executionPrelude = executionPath(PRELUDE, repo, overlay);
	await Bun.write(programFile, options.program);

	const excludesFile = path.join(tempDir, "exclude");
	await Bun.write(excludesFile, [PROGRAM_FILE, ...overlay.gitExcludes, await globalGitExcludes()].join("\n"));

	// Output goes to a file rather than a pipe, so a process the program leaves running can't hold it open.
	// detached: the program gets its own process group, so killing the group kills anything it started too.
	const outputFile = path.join(tempDir, "output");
	const output = await fs.open(outputFile, "w");
	const [command, ...args] = overlay.wrap(
		[process.execPath, "--preload", executionPrelude, executionProgramPath],
		executionCwd,
	);
	log("program started", { output: outputFile, timeoutMs: options.timeoutMs });
	const child = spawn(command, args, {
		cwd: executionCwd,
		detached: true,
		stdio: ["ignore", output.fd, output.fd],
		env: { ...process.env, ...programEnvironment(excludesFile, repo, overlay) },
	});
	const killAll = () => killGroup(child);
	abort.addEventListener("abort", killAll);
	if (abort.aborted) killAll();

	const { exitCode, timedOut, openForWriting, stillRunning } = await waitWithTimeout(
		child,
		options.timeoutMs,
		overlay.executionDir,
	);
	log("program exited", { exitCode, timedOut, aborted: abort.aborted, stillRunning });
	killAll(); // anything it left running
	abort.removeEventListener("abort", killAll);
	await output.close();
	await fs.rm(programFile, { force: true });

	// Keep the tail, where errors are. Show stack traces as "program.ts:3:11", and drop Bun's version footer.
	let text = await Bun.file(outputFile).text();
	if (text.length > MAX_OUTPUT_CHARS) {
		text = `[${text.length - MAX_OUTPUT_CHARS} earlier characters dropped]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
	}
	text = text.replaceAll(executionProgramPath, "program.ts").replace(/\nBun v[\d.]+ \([^)]*\)\n?$/, "\n");

	return { exitCode, timedOut, output: text, openForWriting, stillRunning };
}

/**
 * Waits for the program to exit, or kills it after timeoutMs. Before killing it, notes which files
 * it (or anything it started) still has open for writing, since they may be half-written, and which
 * commands it was still running, since one of them is probably why it timed out.
 */
async function waitWithTimeout(child: ChildProcess, timeoutMs: number, repo: string) {
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	let timer: Timer | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	const winner = await Promise.race([exited, timeout]);
	clearTimeout(timer);
	if (winner !== "timeout") return { exitCode: winner, timedOut: false, openForWriting: [], stillRunning: [] };

	const [openForWriting, stillRunning] = await Promise.all([
		filesOpenForWriting(repo, child.pid!),
		commandsRunning(child.pid!),
	]);
	killGroup(child);
	await exited;
	return { exitCode: null, timedOut: true, openForWriting, stillRunning };
}

/**
 * The commands running in a process group, with how long each has been running, e.g.
 * "find / -name x (running 58s)". Leaves out the program itself and bubblewrap, which wraps it.
 */
async function commandsRunning(processGroup: number): Promise<string[]> {
	const pids = (await $`pgrep -g ${processGroup}`.nothrow().quiet().text()).split("\n").filter(Boolean);
	if (pids.length === 0) return [];
	const output = await $`ps -o etime=,command= -p ${pids.join(",")}`.nothrow().quiet().text();

	const commands: string[] = [];
	for (const line of output.split("\n")) {
		const match = line.trim().match(/^(\S+)\s+(.+)$/);
		if (!match) continue;
		const [, elapsed, command] = match;
		if (command.includes(PROGRAM_FILE) || /^\S*bwrap /.test(command)) continue;
		commands.push(`${command.slice(0, 200)} (for ${seconds(elapsed)}s)`);
	}
	return commands;
}

/**
 * The line of the program an error came from, found from Bun's "at program.ts:3:11" rather than its
 * source excerpt, which leaves out long lines and then mislabels the ones around them.
 */
function failingLine(program: string, output: string): string | undefined {
	const location = output.match(/\bprogram\.ts:(\d+):\d+/);
	if (!location) return undefined;
	const text = program.split("\n")[Number(location[1]) - 1]?.trim();
	return text ? `line ${location[1]}: ${text}`.slice(0, 160) : undefined;
}

/** ps's elapsed time, "[[dd-]hh:]mm:ss", in seconds. */
function seconds(elapsed: string): number {
	const [days, clock] = elapsed.includes("-") ? elapsed.split("-") : ["0", elapsed];
	const parts = clock.split(":").map(Number);
	const [hours, minutes, secs] = [0, 0, ...parts].slice(-3);
	return Number(days) * 86400 + hours * 3600 + minutes * 60 + secs;
}

/** The last command or helper call this run's program logged, e.g. "$ find / -name x". */
async function lastLoggedStep(): Promise<string | undefined> {
	const lines = (await Bun.file(LOG_FILE).text()).trimEnd().split("\n").slice(-500);
	for (const line of lines.toReversed()) {
		const event = JSON.parse(line);
		if (event.run !== RUN_ID) continue;
		if (event.event === "command") return `$ ${event.command}`;
		if (event.event === "helper") return `${event.helper}(${event.args.slice(1, -1)}) (${event.ms} ms)`;
	}
	return undefined;
}

function killGroup(child: ChildProcess) {
	try {
		process.kill(-child.pid!, "SIGKILL");
	} catch {
		// already gone
	}
}

/**
 * Adds our git excludes on top of any GIT_CONFIG_* the user already set. core.excludesFile
 * replaces the user's global excludes file, so globalGitExcludes() copies that file's patterns in.
 */
function programEnvironment(excludesFile: string, repo: string, overlay: Overlay) {
	const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
	const nodeModules = NODE_MODULES.map((directory) => executionPath(directory, repo, overlay));
	return {
		PATH: [...nodeModules.map((dir) => path.join(dir, ".bin")), process.env.PATH].join(path.delimiter),
		NO_COLOR: "1",
		// So programs can import the extension's own packages, e.g. "@ast-grep/napi". A repository's own
		// node_modules still wins: NODE_PATH is only a fallback.
		NODE_PATH: [...nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
		PI_SHORTHAND_LOG: LOG_FILE, // the prelude logs each command and helper call here
		PI_SHORTHAND_RUN: RUN_ID,
		GIT_OPTIONAL_LOCKS: "0", // read-only git commands should not dirty copied or mounted metadata
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: "core.excludesFile",
		[`GIT_CONFIG_VALUE_${count}`]: excludesFile,
	};
}

/** Maps extension files into the isolated execution copy when the tool is editing its own checkout. */
function executionPath(file: string, repo: string, overlay: Overlay): string {
	const relative = path.relative(repo, file);
	return relative.startsWith("..") || path.isAbsolute(relative) ? file : path.join(overlay.executionDir, relative);
}

/** The patterns in the user's global git excludes file, if they have one. */
async function globalGitExcludes(): Promise<string> {
	const configured = (await $`git config --global --path --get core.excludesFile`.nothrow().quiet().text()).trim();
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
	const file = Bun.file(configured || path.join(xdgConfig, "git", "ignore"));
	return (await file.exists()) ? file.text() : "";
}

/** Files under dir that any process in a process group has open for writing, relative to dir. */
async function filesOpenForWriting(dir: string, processGroup: number): Promise<string[]> {
	// -F an: one field per line. "a" is the access mode (r, w, or u for read/write), "n" the file name.
	const output = await $`lsof -n -P -F an -g ${processGroup}`.nothrow().quiet().text();

	const files: string[] = [];
	let access = "";
	for (const line of output.split("\n")) {
		if (line.startsWith("a")) access = line.slice(1);
		if (line.startsWith(`n${dir}/`) && access !== "r") files.push(path.relative(dir, line.slice(1)));
	}
	return files;
}

// ── Finding, describing and applying changes ──────────────────────────────────────

/** Compares what the overlay reports with the originals. Only files git sees count. */
async function findChanges(overlay: Overlay): Promise<Change[]> {
	const candidates = (await overlay.changes()).filter(({ file }) => path.basename(file) !== PROGRAM_FILE);
	const ignored = await gitIgnored(
		overlay.originalDir,
		candidates.map(({ file }) => file),
	);

	const changes: Change[] = [];
	const seen = new Set<string>(); // an overlay may report a file twice, e.g. a deleted directory and the files in it
	for (const { file, contents: after } of candidates) {
		if (ignored.has(file) || seen.has(file)) continue;
		seen.add(file);
		const before = await readFile(path.join(overlay.originalDir, file));
		if (!before && !after) continue;
		if (before && after && Buffer.from(before).equals(after)) continue; // read, not changed
		changes.push({ file, before, after });
	}
	return changes.toSorted((a, b) => a.file.localeCompare(b.file));
}

async function gitIgnored(dir: string, files: string[]): Promise<Set<string>> {
	if (files.length === 0) return new Set();
	const input = new Response(`${files.join("\0")}\0`);
	const output = await $`git check-ignore -z --stdin < ${input}`.cwd(dir).nothrow().quiet().text();
	return new Set(output.split("\0").filter(Boolean));
}

interface PreparedChange {
	change: Change;
	target: string;
	staged?: string;
	backupDir?: string;
	backup?: string;
	backedUp: boolean;
	backupIdentity?: { dev: number; ino: number; mode: number };
	installed?: { dev: number; ino: number; mode: number };
}

/** Prepares every resource first, then rolls the complete commit back on any failure or conflict. */
async function applyChanges(
	repo: string,
	changes: Change[],
	abort: AbortSignal,
	failAfter?: number,
	delayAfterMs?: number,
	delayAfter = 1,
	failAfterBackup?: number,
	beforeCommitDelayMs?: number,
	failCleanup?: boolean,
	beforeCommitMarker?: string,
): Promise<{ applied: Change[]; conflicts: string[]; warnings: string[] }> {
	const prepared: PreparedChange[] = [];
	try {
		for (const change of changes) {
			const target = path.join(repo, change.file);
			if (!(await safeParentChain(repo, target))) {
				await cleanupPrepared(prepared);
				return { applied: [], conflicts: await conflictingFiles(repo, changes), warnings: [] };
			}
			const item: PreparedChange = { change, target, backedUp: false };
			prepared.push(item);

			if (change.after) {
				item.staged = path.join(path.dirname(target), `.pi-shorthand-${randomUUID()}.tmp`);
				const handle = await fs.open(item.staged, "wx");
				try {
					await handle.writeFile(change.after);
				} finally {
					await handle.close();
				}
				const original = change.before ? await fs.lstat(target).catch(() => null) : null;
				if (original) await fs.chmod(item.staged, original.mode);
			}
			if (change.before) {
				item.backupDir = await fs.mkdtemp(path.join(path.dirname(target), ".pi-shorthand-backup-"));
				item.backup = path.join(item.backupDir, "original");
			}
		}
	} catch (error) {
		await cleanupPrepared(prepared).catch(() => {});
		throw error;
	}
	if (beforeCommitMarker) await Bun.write(beforeCommitMarker, "ready");
	if (beforeCommitDelayMs) await Bun.sleep(beforeCommitDelayMs);

	const committed: PreparedChange[] = [];
	try {
		for (let index = 0; index < prepared.length; index++) {
			const item = prepared[index];
			if (!(await destinationMatches(repo, item.change))) {
				await rollbackApplied(repo, committed);
				const conflicts = await conflictingFiles(repo, changes);
				const warnings = await cleanupWarnings(prepared, failCleanup);
				return { applied: [], conflicts, warnings };
			}
			if (index === 0 && abort.aborted) {
				const warnings = await cleanupWarnings(prepared, failCleanup);
				return { applied: [], conflicts: [], warnings };
			}

			committed.push(item);
			if (item.backup) {
				const original = await fs.lstat(item.target);
				item.backupIdentity = { dev: original.dev, ino: original.ino, mode: original.mode };
				await fs.rename(item.target, item.backup);
				item.backedUp = true;
			}
			if (failAfterBackup === index + 1) {
				throw new Error(`Injected application failure after backing up change ${index + 1}.`);
			}
			if (item.staged) {
				const installed = await fs.lstat(item.staged);
				await fs.rename(item.staged, item.target);
				item.staged = undefined;
				item.installed = { dev: installed.dev, ino: installed.ino, mode: installed.mode };
			}

			if (failAfter === index + 1) throw new Error(`Injected application failure after ${index + 1} change(s).`);
			if (delayAfterMs && index + 1 === delayAfter) await Bun.sleep(delayAfterMs);
		}
	} catch (error) {
		try {
			await rollbackApplied(repo, committed);
		} catch (rollbackError) {
			await cleanupStaged(prepared).catch(() => {});
			const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			const combined = new Error(`Applying changes failed and ${detail}`, { cause: error });
			Object.assign(combined, { rollbackCause: rollbackError });
			throw combined;
		}
		await cleanupPrepared(prepared).catch(() => {});
		throw error;
	}

	const warnings = await cleanupWarnings(prepared, failCleanup);
	return { applied: changes, conflicts: [], warnings };
}

async function rollbackApplied(repo: string, items: PreparedChange[]) {
	const errors: Error[] = [];
	for (const item of items.toReversed()) {
		try {
			if (item.backedUp && item.backup) {
				const backup = await fs.lstat(item.backup).catch(() => null);
				const backupContentsStillOriginal =
					item.change.before &&
					(await destinationMatches(repo, {
						file: path.relative(repo, item.backup),
						before: item.change.before,
						after: null,
					}));
				if (
					!backup ||
					!item.backupIdentity ||
					backup.dev !== item.backupIdentity.dev ||
					backup.ino !== item.backupIdentity.ino ||
					backup.mode !== item.backupIdentity.mode ||
					!backupContentsStillOriginal
				) {
					throw new Error(
						`Could not safely roll back ${JSON.stringify(item.change.file)}: its backup changed ` +
							`(present=${Boolean(backup)}, identity=${Boolean(item.backupIdentity)}, ` +
							`device=${backup?.dev === item.backupIdentity?.dev}, inode=${backup?.ino === item.backupIdentity?.ino}, ` +
							`mode=${backup?.mode === item.backupIdentity?.mode}, contents=${Boolean(backupContentsStillOriginal)}).`,
					);
				}
			}
			if (item.installed) {
				const current = await fs.lstat(item.target).catch(() => null);
				const contentsStillOurs =
					item.change.after &&
					(await destinationMatches(repo, {
						...item.change,
						before: item.change.after,
					}));
				if (
					!current ||
					current.dev !== item.installed.dev ||
					current.ino !== item.installed.ino ||
					current.mode !== item.installed.mode ||
					!contentsStillOurs
				) {
					throw new Error(`Could not safely roll back ${JSON.stringify(item.change.file)}: its destination changed.`);
				}
				await fs.rm(item.target, { force: true });
				item.installed = undefined;
			}
			if (item.backedUp && item.backup) {
				if (await fs.lstat(item.target).catch(() => null)) {
					throw new Error(`Could not safely restore ${JSON.stringify(item.change.file)}: its destination reappeared.`);
				}
				await fs.rename(item.backup, item.target);
				item.backedUp = false;
			}
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (errors.length > 0) {
		const details = errors.map((error) => error.message).join("; ");
		const failure = new Error(`Rollback did not complete: ${details}`, { cause: errors[0] });
		Object.assign(failure, { rollbackErrors: errors });
		throw failure;
	}
}

async function cleanupPrepared(items: PreparedChange[]) {
	await cleanupStaged(items);
	for (const item of items) {
		if (item.backupDir) await fs.rm(item.backupDir, { recursive: true, force: true });
	}
}

async function cleanupStaged(items: PreparedChange[]) {
	for (const item of items) {
		if (item.staged) await fs.rm(item.staged, { force: true });
	}
}

async function cleanupWarnings(items: PreparedChange[], failCleanup = false): Promise<string[]> {
	try {
		if (failCleanup) throw new Error("Injected transaction backup cleanup failure.");
		await cleanupPrepared(items);
		return [];
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const warning = `Changes reached their reported state, but transaction backup cleanup failed: ${detail}`;
		log("cleanup warning", { warning });
		return [warning];
	}
}

/** A change as a git-style patch. */
function describe(file: string, { before, after }: Change): FileChange {
	const kind = !before ? "added" : !after ? "deleted" : "modified";
	const lines = [`diff --git a/${file} b/${file}`];
	if (kind !== "modified") lines.push(`${kind === "added" ? "new" : "deleted"} file`);

	const oldBytes = before ?? new Uint8Array();
	const newBytes = after ?? new Uint8Array();
	if (isBinary(oldBytes) || isBinary(newBytes)) {
		lines.push("Binary file changed");
		return { path: file, kind, patch: lines.join("\n") };
	}

	lines.push(kind === "added" ? "--- /dev/null" : `--- a/${file}`);
	lines.push(kind === "deleted" ? "+++ /dev/null" : `+++ b/${file}`);
	const oldText = new TextDecoder().decode(oldBytes);
	const newText = new TextDecoder().decode(newBytes);
	for (const hunk of structuredPatch(file, file, oldText, newText, "", "", { context: 3 }).hunks) {
		lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
	}
	return { path: file, kind, patch: lines.join("\n") };
}

function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

/** dir and each directory above it, up to the root. */
function ancestors(dir: string): string[] {
	const parent = path.dirname(dir);
	return parent === dir ? [dir] : [dir, ...ancestors(parent)];
}

/** A regular file's contents, or null if there's no regular file there. */
async function readFile(file: string): Promise<Uint8Array | null> {
	let stats;
	try {
		stats = await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!stats.isFile()) return null;
	try {
		return await Bun.file(file).bytes();
	} catch (error) {
		// A destination removed between lstat and read is still a conflict.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

if (import.meta.main) {
	mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	const abort = new AbortController();
	process.on("SIGTERM", () => abort.abort());
	const options: RunOptions = await Bun.stdin.json();
	RUN_ID = options.runId;
	try {
		console.log(JSON.stringify(await run(options, abort.signal)));
	} catch (error) {
		log("failed", { error: String(error) });
		throw error;
	}
}
