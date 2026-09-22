/**
 * Linux: bubblewrap (0.9+) mounts a kernel overlayfs over the repository in a private mount
 * namespace, so only the program sees it. Its writes land in an upper directory in tempDir, which
 * is also where the changes are read from. There's nothing to undo afterwards.
 */

import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { FilesystemEntry, Overlay } from "./runner.ts";
import { diagnosticCounter, measure } from "./diagnostics.ts";

export async function openLinuxOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const bwrap = Bun.which("bwrap");
	if (!bwrap) throw new Error("The code tool needs bubblewrap (0.9 or later) on Linux.");

	// OverlayFS forbids changing a mounted lower tree. The real checkout remains live, so take an
	// independent copy first; reflinks make this cheap on filesystems that support them.
	const lower = path.join(tempDir, "lower");
	const upper = path.join(tempDir, "upper");
	const work = path.join(tempDir, "work");
	const cacheDir = path.join(homedir(), ".cache", "pi-shorthand");
	const internalDir = path.join(cacheDir, "sandbox");
	const sandboxExcludesFile = path.join(internalDir, `${path.basename(tempDir)}.exclude`);
	await copyStableTree(repo, lower);
	await fs.mkdir(upper);
	await fs.mkdir(work);
	await fs.mkdir(internalDir, { recursive: true, mode: 0o700 });
	const internalStats = await fs.lstat(internalDir);
	if (
		!internalStats.isDirectory() ||
		internalStats.isSymbolicLink() ||
		(process.getuid && internalStats.uid !== process.getuid())
	) {
		throw new Error(`Unsafe shorthand sandbox directory: ${internalDir}`);
	}
	if ((internalStats.mode & 0o077) !== 0) await fs.chmod(internalDir, 0o700);
	await fs.writeFile(sandboxExcludesFile, "", { flag: "wx", mode: 0o600 });

	const wrap = (command: string[], cwd: string) => [
		bwrap,
		"--die-with-parent", // so killing bwrap also kills the program
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--unshare-pid",
		"--proc",
		"/proc",
		"--overlay-src",
		lower,
		"--overlay",
		upper,
		work,
		repo,
		"--tmpfs",
		"/dev/shm",
		"--chdir",
		cwd, // resolve the working directory again, inside the overlay
		"--",
		...command,
	];

	const overlay: Overlay = {
		originalDir: lower,
		writableDir: upper,
		executionDir: repo,
		gitExcludes: [],
		executionExcludesFile: sandboxExcludesFile,
		environment: { TMPDIR: "/dev/shm", TMP: "/dev/shm", TEMP: "/dev/shm" },
		wrap,
		changes: async () => {
			const { written, directories, whiteouts } = await writtenEntries(upper, lower);
			const inspected = await inspectChanges(directories, whiteouts, written, lower, repo, wrap);
			overlay.formattingAvailable = inspected.formattingAvailable;
			overlay.ignoredPaths = inspected.ignoredPaths;
			return [...written, ...inspected.deleted];
		},
		close: async () => {
			// OverlayFS deliberately leaves its private work/work directory inaccessible. Node and Bun
			// recurse into it before unlinking it, so restore owner access before removing the workspace.
			const internalWork = path.join(work, "work");
			try {
				const stats = await fs.lstat(internalWork);
				if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid && stats.uid !== process.getuid())) {
					throw new Error(`Unsafe OverlayFS work directory: ${internalWork}`);
				}
				await fs.chmod(internalWork, 0o700);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} finally {
				await fs.rm(sandboxExcludesFile, { force: true });
			}
		},
	};
	return overlay;
}

/** Copies a coherent tree, retrying if anything in the source changes during the copy. */
export async function copyStableTree(source: string, destination: string) {
	for (let attempt = 0; attempt < 3; attempt++) {
		diagnosticCounter("snapshot attempts", attempt + 1);
		let before: string;
		try {
			before = await measure("snapshot inventory", () => treeIdentity(source));
		} catch (error) {
			if (isMissing(error)) continue;
			throw new Error(`Could not inspect the repository before snapshotting: ${errorMessage(error)}`, {
				cause: error,
			});
		}
		await measure("snapshot reset", () => fs.rm(destination, { recursive: true, force: true }));
		try {
			await measure("snapshot copy", async () => {
				if (process.platform === "linux") {
					// Keep traversal and copying in one native process rather than crossing the JS/fs
					// boundary for every entry. --reflink=auto also works on ordinary ext4.
					await $`cp --recursive --no-dereference --preserve=mode,timestamps --reflink=auto -- ${source} ${destination}`.quiet();
				} else {
					await fs.cp(source, destination, {
						recursive: true,
						preserveTimestamps: true,
						verbatimSymlinks: true,
						mode: constants.COPYFILE_FICLONE,
					});
				}
			});
		} catch (error) {
			let after: string;
			try {
				after = await measure("snapshot verification after copy error", () => treeIdentity(source));
			} catch (inspectionError) {
				if (isMissing(inspectionError)) continue;
				throw new Error(`Could not verify the repository after a snapshot error: ${errorMessage(inspectionError)}`, {
					cause: inspectionError,
				});
			}
			if (after !== before) continue;
			throw new Error(`Could not copy the repository snapshot: ${errorMessage(error)}`, { cause: error });
		}
		let after: string;
		try {
			after = await measure("snapshot verification", () => treeIdentity(source));
		} catch (error) {
			if (isMissing(error)) continue;
			throw new Error(`Could not verify the repository snapshot: ${errorMessage(error)}`, { cause: error });
		}
		if (after === before) return;
	}
	throw new Error("The repository kept changing while shorthand tried to snapshot it. Please retry.");
}

/** Metadata that changes whenever an entry is written, replaced, added or removed. */
async function treeIdentity(root: string): Promise<string> {
	const records = [identityRecord(".", await fs.lstat(root, { bigint: true }))];
	const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
	diagnosticCounter("snapshot entries", entries.length + 1);
	let bytes = 0;
	let next = 0;
	const workers = await Promise.allSettled(
		Array.from({ length: Math.min(availableParallelism(), entries.length) }, async () => {
			while (next < entries.length) {
				const entry = entries[next++];
				const file = path.join(entry.parentPath, entry.name);
				if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) {
					throw new Error(`Unsupported repository entry type at ${JSON.stringify(path.relative(root, file))}`);
				}
				const stats = await fs.lstat(file, { bigint: true });
				if (entry.isFile()) bytes += Number(stats.size);
				records.push(identityRecord(path.relative(root, file), stats));
			}
		}),
	);
	for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
	diagnosticCounter("snapshot logical bytes", bytes);
	return records.toSorted().join("\0");
}

function identityRecord(file: string, stats: BigIntStats): string {
	return `${file}\0${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Files and symlinks represented in the upper layer, except Git's own metadata writes. */
async function writtenEntries(upper: string, lower: string) {
	const written: { file: string; entry: FilesystemEntry }[] = [];
	const directories = [""];
	const whiteouts: string[] = [];
	for (const entry of await fs.readdir(upper, { recursive: true, withFileTypes: true })) {
		const fullPath = path.join(entry.parentPath, entry.name);
		const file = path.relative(upper, fullPath);
		if (file === ".git" || file.startsWith(".git/")) continue;
		if (entry.isDirectory()) {
			const before = await fs.lstat(path.join(lower, file)).catch((error) => {
				if (isMissing(error)) return null;
				throw error;
			});
			if (before && !before.isDirectory())
				throw new Error(`Unsupported directory replacement at ${JSON.stringify(file)}.`);
			directories.push(file);
			continue;
		}
		if (entry.isFile()) {
			const stats = await fs.lstat(fullPath);
			written.push({
				file,
				entry: { type: "file", contents: await Bun.file(fullPath).bytes(), mode: stats.mode & 0o7777 },
			});
			continue;
		}
		if (entry.isSymbolicLink()) {
			written.push({ file, entry: { type: "symlink", target: await fs.readlink(fullPath) } });
			continue;
		}
		const stats = await fs.lstat(fullPath);
		if (stats.isCharacterDevice() && stats.rdev === 0) {
			whiteouts.push(file);
			continue;
		}
		throw new Error(`Unsupported filesystem entry at ${JSON.stringify(file)}.`);
	}
	return { written, directories, whiteouts };
}

/**
 * Files git saw before that are gone from the final overlay. Check the directory entries themselves:
 * staging a file or changing an ignore rule changes Git's classification without deleting the file.
 * Overlayfs's own records aren't enough either: deleting a directory leaves one whiteout for all of
 * it, and recreating a directory hides everything that was in it.
 */
async function inspectChanges(
	directories: string[],
	whiteouts: string[],
	written: { file: string; entry: FilesystemEntry }[],
	lower: string,
	repo: string,
	wrap: (command: string[], cwd: string) => string[],
) {
	// Only upper directories can hide lower children (including opaque directory recreation).
	// Descend into a lower subtree only when its corresponding merged directory has disappeared.
	const script = `
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
const { directories, whiteouts, lower, files, writtenPaths } = await Bun.stdin.json();
const missing = new Set();
const collected = new Set();
function collect(file) {
  if (file === ".git" || file.startsWith(".git/")) return;
  if (collected.has(file)) return;
  collected.add(file);
  const before = lstatSync(join(lower, file), { throwIfNoEntry: false });
  if (!before) return;
  if (before.isDirectory()) {
    for (const name of readdirSync(join(lower, file))) collect(join(file, name));
  } else missing.add(file);
}
for (const file of whiteouts) collect(file);
for (const directory of directories) {
  const before = lstatSync(join(lower, directory), { throwIfNoEntry: false });
  if (!before?.isDirectory()) continue;
  for (const name of readdirSync(join(lower, directory))) {
    const file = join(directory, name);
    if (file === ".git" || file.startsWith(".git/")) continue;
    if (!lstatSync(file, { throwIfNoEntry: false })) collect(file);
  }
}
const candidates = [...new Set([...writtenPaths, ...missing])];
let ignoredPaths = [];
if (candidates.length) {
  const git = Bun.spawn(["git", "check-ignore", "-z", "--stdin"], {
    stdin: new Response(candidates.join("\\0") + "\\0"), stdout: "pipe", stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([git.exited, new Response(git.stdout).text(), new Response(git.stderr).text()]);
  if (code !== 0 && code !== 1) throw new Error("Could not evaluate final ignore rules: " + error.trim());
  ignoredPaths = output.split("\\0").filter(Boolean);
}
const ignored = new Set(ignoredPaths);
let formattingAvailable = false;
if (process.env.PI_SHORTHAND_FORMAT !== "0" && files.some(file => !ignored.has(file))) {
  try {
    const { formatterFor } = await import(${JSON.stringify(path.join(import.meta.dir, "format.ts"))});
    formattingAvailable = files.some(file => !ignored.has(file) && formatterFor(file, process.cwd()) !== null);
  } catch {
    // Discovery is only an optimization. Let the best-effort formatting pass report its own error.
    formattingAvailable = true;
  }
}
console.log(JSON.stringify({ deleted: [...missing], ignoredPaths, formattingAvailable }));
`;
	const filesToFormat = written.filter(({ entry }) => entry.type === "file").map(({ file }) => file);
	const input = new Response(
		JSON.stringify({
			directories,
			whiteouts,
			lower,
			files: filesToFormat,
			writtenPaths: written.map(({ file }) => file),
		}),
	);
	// Inside the overlay, one mount at a time: overlayfs won't let two mounts share a work directory.
	const output = await $`${wrap([process.execPath, "-e", script], repo)} < ${input}`.text();
	const {
		deleted: files,
		formattingAvailable,
		ignoredPaths,
	} = JSON.parse(output) as {
		deleted: string[];
		formattingAvailable: boolean;
		ignoredPaths: string[];
	};
	if (!files.length) return { deleted: [], formattingAvailable, ignoredPaths };
	// Preserve the original rule: deleted ignored/untracked files are not application candidates.
	const ignored = await $`git check-ignore -z --stdin < ${new Response(files.join("\0") + "\0")}`
		.cwd(lower)
		.nothrow()
		.quiet();
	if (ignored.exitCode > 1) throw new Error(`Could not classify deleted files: ${ignored.stderr.toString().trim()}`);
	const excluded = new Set(ignored.text().split("\0").filter(Boolean));
	return {
		deleted: files.filter((file) => !excluded.has(file)).map((file) => ({ file, entry: null })),
		formattingAvailable,
		ignoredPaths,
	};
}
