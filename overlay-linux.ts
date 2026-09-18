/**
 * Linux: bubblewrap (0.9+) mounts a kernel overlayfs over the repository in a private mount
 * namespace, so only the program sees it. Its writes land in an upper directory in tempDir, which
 * is also where the changes are read from. There's nothing to undo afterwards.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Overlay } from "./runner.ts";

export async function openLinuxOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const bwrap = Bun.which("bwrap");
	if (!bwrap) throw new Error("The code tool needs bubblewrap (0.9 or later) on Linux.");

	const upper = path.join(tempDir, "upper");
	const work = path.join(tempDir, "work");
	await fs.mkdir(upper);
	await fs.mkdir(work);

	return {
		originalDir: repo,
		writableDir: upper,
		gitExcludes: [],
		wrap: (command, cwd) => [
			bwrap,
			"--die-with-parent", // so killing bwrap on timeout also kills the program
			"--dev-bind", "/", "/",
			"--overlay-src", repo,
			"--overlay", upper, work, repo,
			"--chdir", cwd, // resolve the working directory again, inside the overlay
			"--",
			...command,
		],
		changes: () => changesInUpperDir(upper),
		close: async () => {},
	};
}

/**
 * Every file in the upper directory has changed. Deletions are recorded as "whiteouts". Writes git
 * made to .git (e.g. refreshing its index) are left out: they stay in the overlay.
 */
async function changesInUpperDir(upper: string) {
	const changes: { file: string; contents: Uint8Array | null }[] = [];
	for (const entry of await fs.readdir(upper, { recursive: true, withFileTypes: true })) {
		const fullPath = path.join(entry.parentPath, entry.name);
		if (entry.isDirectory() || path.relative(upper, fullPath).startsWith(".git/")) continue;
		const stats = await fs.lstat(fullPath);
		const contents = isWhiteout(stats) ? null : await readFile(fullPath);
		changes.push({ file: path.relative(upper, fullPath), contents });
	}
	return changes;
}

/** overlayfs records a deletion as a character device with device number 0/0. */
function isWhiteout(stats: Stats) {
	return stats.isCharacterDevice() && stats.rdev === 0;
}

/** A regular file's contents, or null if there's no regular file there. */
async function readFile(file: string): Promise<Uint8Array | null> {
	const stats = await fs.lstat(file).catch(() => null);
	return stats?.isFile() ? Bun.file(file).bytes() : null;
}
