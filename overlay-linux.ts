/**
 * Linux: bubblewrap (0.9+) mounts a kernel overlayfs over the repository in a private mount
 * namespace, so only the program sees it. Its writes land in an upper directory in tempDir, which
 * is also where the changes are read from. There's nothing to undo afterwards.
 */

import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import type { Overlay } from "./runner.ts";

export async function openLinuxOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const bwrap = Bun.which("bwrap");
	if (!bwrap) throw new Error("The code tool needs bubblewrap (0.9 or later) on Linux.");

	// OverlayFS forbids changing a mounted lower tree. The real checkout remains live, so take an
	// independent copy first; reflinks make this cheap on filesystems that support them.
	const lower = path.join(tempDir, "lower");
	const upper = path.join(tempDir, "upper");
	const work = path.join(tempDir, "work");
	await copyStableTree(repo, lower);
	const filesAtStart = await gitVisibleFiles(lower);
	await fs.mkdir(upper);
	await fs.mkdir(work);

	const wrap = (command: string[], cwd: string) => [
		bwrap,
		"--die-with-parent", // so killing bwrap also kills the program
		"--dev-bind",
		"/",
		"/",
		"--overlay-src",
		lower,
		"--overlay",
		upper,
		work,
		repo,
		"--chdir",
		cwd, // resolve the working directory again, inside the overlay
		"--",
		...command,
	];

	return {
		originalDir: lower,
		writableDir: upper,
		executionDir: repo,
		gitExcludes: [],
		wrap,
		changes: async () => [...(await writtenFiles(upper)), ...(await deletedFiles(filesAtStart, repo, wrap))],
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
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}

/** Copies a coherent tree, retrying if anything in the source changes during the copy. */
export async function copyStableTree(source: string, destination: string) {
	for (let attempt = 0; attempt < 3; attempt++) {
		let before: string;
		try {
			before = await treeIdentity(source);
		} catch (error) {
			if (isMissing(error)) continue;
			throw new Error(`Could not inspect the repository before snapshotting: ${errorMessage(error)}`, {
				cause: error,
			});
		}
		await fs.rm(destination, { recursive: true, force: true });
		try {
			await fs.cp(source, destination, {
				recursive: true,
				preserveTimestamps: true,
				verbatimSymlinks: true,
				mode: constants.COPYFILE_FICLONE,
			});
		} catch (error) {
			let after: string;
			try {
				after = await treeIdentity(source);
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
			after = await treeIdentity(source);
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
	for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
		const file = path.join(entry.parentPath, entry.name);
		if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) {
			throw new Error(`Unsupported repository entry type at ${JSON.stringify(path.relative(root, file))}`);
		}
		const stats = await fs.lstat(file, { bigint: true });
		records.push(identityRecord(path.relative(root, file), stats));
	}
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

/** Regular files in the upper directory, except git's own writes to .git (e.g. refreshing its index). */
async function writtenFiles(upper: string) {
	const written: { file: string; contents: Uint8Array | null }[] = [];
	for (const entry of await fs.readdir(upper, { recursive: true, withFileTypes: true })) {
		const fullPath = path.join(entry.parentPath, entry.name);
		const file = path.relative(upper, fullPath);
		if (!entry.isFile() || file.startsWith(".git/")) continue;
		written.push({ file, contents: await Bun.file(fullPath).bytes() });
	}
	return written;
}

/**
 * Files git saw before that are gone from the final overlay. Check the directory entries themselves:
 * staging a file or changing an ignore rule changes Git's classification without deleting the file.
 * Overlayfs's own records aren't enough either: deleting a directory leaves one whiteout for all of
 * it, and recreating a directory hides everything that was in it.
 */
async function deletedFiles(filesAtStart: string[], repo: string, wrap: (command: string[], cwd: string) => string[]) {
	if (filesAtStart.length === 0) return [];
	const script =
		'import { lstatSync } from "node:fs";' +
		'for (const file of (await Bun.stdin.text()).split("\\0")) {' +
		"if (file && !lstatSync(file, { throwIfNoEntry: false })) process.stdout.write(`${file}\\0`);" +
		"}";
	const input = new Response(`${filesAtStart.join("\0")}\0`);
	// Inside the overlay, one mount at a time: overlayfs won't let two mounts share a work directory.
	const output = await $`${wrap([process.execPath, "-e", script], repo)} < ${input}`.text();
	return output
		.split("\0")
		.filter(Boolean)
		.map((file) => ({ file, contents: null }));
}

async function gitVisibleFiles(repo: string): Promise<string[]> {
	const output = await $`git ls-files -z --cached --others --exclude-standard`.cwd(repo).text();
	return output.split("\0").filter(Boolean);
}
