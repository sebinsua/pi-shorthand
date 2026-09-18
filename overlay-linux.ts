/**
 * Linux: bubblewrap (0.9+) mounts a kernel overlayfs over the repository in a private mount
 * namespace, so only the program sees it. Its writes land in an upper directory in tempDir, which
 * is also where the changes are read from. There's nothing to undo afterwards.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import type { Overlay } from "./runner.ts";

export async function openLinuxOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const bwrap = Bun.which("bwrap");
	if (!bwrap) throw new Error("The code tool needs bubblewrap (0.9 or later) on Linux.");

	const upper = path.join(tempDir, "upper");
	const work = path.join(tempDir, "work");
	await fs.mkdir(upper);
	await fs.mkdir(work);

	const wrap = (command: string[], cwd: string) => [
		bwrap,
		"--die-with-parent", // so killing bwrap also kills the program
		"--dev-bind",
		"/",
		"/",
		"--overlay-src",
		repo,
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
		originalDir: repo,
		writableDir: upper,
		gitExcludes: [],
		wrap,
		changes: async () => [...(await writtenFiles(upper)), ...(await deletedFiles(repo, wrap))],
		close: async () => {},
	};
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
 * Files git saw before that are gone in the overlay, found by asking git inside it. (overlayfs's own
 * records aren't enough: deleting a directory leaves one "whiteout" for all of it, and recreating a
 * directory hides everything that was in it.)
 */
async function deletedFiles(repo: string, wrap: (command: string[], cwd: string) => string[]) {
	const untracked = ["git", "ls-files", "-z", "--others", "--exclude-standard"];
	const inOverlay = (command: string[]) =>
		$`${wrap(command, repo)}`.env({ ...process.env, GIT_OPTIONAL_LOCKS: "0" }).text();

	const before = $`${untracked}`.cwd(repo).text(); // outside the overlay, so it can run alongside
	// Inside the overlay, one mount at a time: overlayfs won't let two mounts share a work directory.
	const trackedGone = await inOverlay(["git", "ls-files", "-z", "--deleted"]);
	const untrackedAfter = await inOverlay(untracked);
	const untrackedBefore = await before;

	const stillThere = new Set(untrackedAfter.split("\0"));
	const deleted = [...trackedGone.split("\0"), ...untrackedBefore.split("\0").filter((file) => !stillThere.has(file))];
	return deleted.filter(Boolean).map((file) => ({ file, contents: null }));
}
