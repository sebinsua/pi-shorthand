/**
 * Runs a Bun program against a git repository at its real path. The program's writes go to a
 * copy-on-write overlay; afterwards they're diffed, then applied to the repository or discarded.
 *
 * Usage: echo '<RunOptions as JSON>' | bun runner.ts   → prints a RunResult as JSON
 * SIGTERM aborts: the program is killed, the overlay is closed and nothing is applied.
 *
 * If the program fails:
 * - rollback "all": nothing is applied;
 * - rollback "file": every file it finished writing is applied. Files it (or a subprocess) still
 *   had open for writing when it was killed may be half-written, so they're rolled back.
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $, type Subprocess } from "bun";
import { structuredPatch } from "diff";
import { openLinuxOverlay } from "./overlay-linux.ts";
import { openMacOverlay } from "./overlay-macos.ts";

export interface RunOptions {
	cwd: string;
	program: string;
	timeoutMs: number;
	rollback: "all" | "file";
}

export interface RunResult {
	exitCode: number | null; // null if it was killed
	timedOut: boolean;
	durationMs: number;
	output: string; // stdout, then stderr
	changes: FileChange[]; // everything the program changed
	applied: string[]; // the changed files that were applied
	rolledBack: string[]; // rollback "file": changed files left half-written, so not applied
}

export interface FileChange {
	path: string; // relative to the tool's working directory
	kind: "added" | "modified" | "deleted";
	patch: string;
}

/** A copy-on-write view of the repository at its real path. */
export interface Overlay {
	originalDir: string; // where the original files are while the overlay is open
	writableDir: string; // writing a file here puts it into the overlay
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

const PROGRAM_FILE = ".pi-code-program.ts";
const PRELUDE = path.join(import.meta.dir, "prelude.ts");
const BIN_DIR = path.join(import.meta.dir, "node_modules", ".bin");
const MAX_OUTPUT_CHARS = 64 * 1024;

async function run(options: RunOptions, abort: AbortSignal): Promise<RunResult> {
	const startedAt = performance.now();
	const cwd = await fs.realpath(options.cwd);
	const repo = await findRepository(cwd);
	const tempDir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "pi-code-"));

	try {
		const open = process.platform === "darwin" ? openMacOverlay : openLinuxOverlay;
		const overlay = await open(repo, tempDir);
		let program: ProgramRun;
		let changes: Change[];
		try {
			program = await runProgram({ ...options, cwd }, abort, overlay, repo, tempDir);
			changes = await findChanges(overlay);
		} finally {
			await overlay.close();
		}

		const { applied, rolledBack } = whatToApply(changes, program, options.rollback, abort.aborted);
		await applyChanges(repo, applied);

		const shown = (file: string) => path.relative(cwd, path.join(repo, file));
		return {
			exitCode: program.exitCode,
			timedOut: program.timedOut,
			durationMs: Math.round(performance.now() - startedAt),
			output: program.output,
			changes: changes.map((change) => describe(shown(change.file), change)),
			applied: applied.map((change) => shown(change.file)),
			rolledBack: rolledBack.map((change) => shown(change.file)),
		};
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

/** Everything if the program succeeded. If it failed, nothing, unless rollback is "file". */
function whatToApply(changes: Change[], program: ProgramRun, rollback: RunOptions["rollback"], aborted: boolean) {
	if (program.exitCode === 0) return { applied: changes, rolledBack: [] };
	if (rollback === "all" || aborted) return { applied: [], rolledBack: [] };

	const halfWritten = (change: Change) => program.openForWriting.includes(change.file);
	return { applied: changes.filter((change) => !halfWritten(change)), rolledBack: changes.filter(halfWritten) };
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
}

async function runProgram(
	options: RunOptions,
	abort: AbortSignal,
	overlay: Overlay,
	repo: string,
	tempDir: string,
): Promise<ProgramRun> {
	// The program file goes into the working directory, so its relative imports resolve as usual.
	const programPath = path.join(options.cwd, PROGRAM_FILE);
	const programFile = path.join(overlay.writableDir, path.relative(repo, programPath));
	await Bun.write(programFile, options.program);

	const excludesFile = path.join(tempDir, "exclude");
	await Bun.write(excludesFile, [PROGRAM_FILE, ...overlay.gitExcludes].join("\n"));

	const child = Bun.spawn({
		cmd: overlay.wrap([process.execPath, "--preload", PRELUDE, programPath], options.cwd),
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal: abort, // kills the program
		env: {
			...process.env,
			PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`,
			NO_COLOR: "1",
			GIT_OPTIONAL_LOCKS: "0", // on macOS .git is the real one: don't let `git status` write to it
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.excludesFile",
			GIT_CONFIG_VALUE_0: excludesFile,
		},
	});
	const [stdout, stderr, { timedOut, openForWriting }] = await Promise.all([
		child.stdout.text(),
		child.stderr.text(),
		waitWithTimeout(child, options.timeoutMs, repo),
	]);
	await fs.rm(programFile, { force: true });

	// Keep the tail, where errors are. Show stack traces as "program.ts:3:11", and drop Bun's version footer.
	const output = (stdout + stderr)
		.slice(-MAX_OUTPUT_CHARS)
		.replaceAll(programPath, "program.ts")
		.replace(/\nBun v[\d.]+ \([^)]*\)\n?$/, "\n");

	return { exitCode: timedOut ? null : child.exitCode, timedOut, output, openForWriting };
}

/**
 * Waits for the program to exit, or kills it after timeoutMs. Before killing it, notes which files
 * it still has open for writing: they may be half-written.
 */
async function waitWithTimeout(child: Subprocess, timeoutMs: number, repo: string) {
	let timer: Timer | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	const winner = await Promise.race([child.exited, timeout]);
	clearTimeout(timer);
	if (winner !== "timeout") return { timedOut: false, openForWriting: [] };

	const openForWriting = await filesOpenForWriting(repo);
	child.kill("SIGKILL");
	await child.exited;
	return { timedOut: true, openForWriting };
}

/** Files under dir that any process in our process group has open for writing, relative to dir. */
async function filesOpenForWriting(dir: string): Promise<string[]> {
	const processGroup = (await $`ps -o pgid= -p ${process.pid}`.text()).trim();
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
	const ignored = await gitIgnored(overlay.originalDir, candidates.map(({ file }) => file));

	const changes: Change[] = [];
	for (const { file, contents: after } of candidates) {
		if (ignored.has(file)) continue;
		const before = await readFile(path.join(overlay.originalDir, file));
		if (!before && !after) continue;
		if (before && after && Buffer.from(before).equals(after)) continue; // read, not changed
		changes.push({ file, before, after });
	}
	return changes.sort((a, b) => a.file.localeCompare(b.file));
}

async function gitIgnored(dir: string, files: string[]): Promise<Set<string>> {
	if (files.length === 0) return new Set();
	const input = new Response(`${files.join("\0")}\0`);
	const output = await $`git check-ignore -z --stdin < ${input}`.cwd(dir).nothrow().quiet().text();
	return new Set(output.split("\0").filter(Boolean));
}

async function applyChanges(repo: string, changes: Change[]) {
	for (const { file, after } of changes) {
		const target = path.join(repo, file);
		if (!after) {
			await fs.rm(target, { force: true });
			continue;
		}
		// Write next to the target, then rename, so each file is replaced atomically.
		const temp = `${target}.pi-code.tmp`;
		await Bun.write(temp, after);
		const original = await fs.stat(target).catch(() => null);
		if (original) await fs.chmod(temp, original.mode);
		await fs.rename(temp, target);
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

/** A regular file's contents, or null if there's no regular file there. */
async function readFile(file: string): Promise<Uint8Array | null> {
	const stats = await fs.lstat(file).catch(() => null);
	return stats?.isFile() ? Bun.file(file).bytes() : null;
}

if (import.meta.main) {
	const abort = new AbortController();
	process.on("SIGTERM", () => abort.abort());
	const options: RunOptions = await Bun.stdin.json();
	console.log(JSON.stringify(await run(options, abort.signal)));
}
