import { mkdir, readFile, readlink, lstat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

interface FileState {
	mode: number;
	kind: "file" | "symlink";
	content: string;
}

async function snapshot(root: string): Promise<Record<string, FileState>> {
	const listed = await $`git ls-files -z --cached --others --exclude-standard`.cwd(root).quiet();
	const files: Record<string, FileState> = {};
	for (const file of new Set(listed.text().split("\0").filter(Boolean))) {
		const full = path.join(root, file);
		const stat = await lstat(full).catch(() => null);
		if (!stat || stat.isDirectory()) continue;
		files[file] = {
			mode: stat.mode & 0o777,
			kind: stat.isSymbolicLink() ? "symlink" : "file",
			content: stat.isSymbolicLink() ? await readlink(full) : (await readFile(full)).toString("base64"),
		};
	}
	return files;
}

/** Compare to the actual starting tree, not HEAD (which may already have dirty changes). */
export async function saveChanges(before: string, after: string, destination: string) {
	const [original, final] = await Promise.all([snapshot(before), snapshot(after)]);
	const changes = [...new Set([...Object.keys(original), ...Object.keys(final)])]
		.toSorted()
		.flatMap((file) =>
			JSON.stringify(original[file]) === JSON.stringify(final[file])
				? []
				: [{ path: file, before: original[file] ?? null, after: final[file] ?? null }],
		);
	await mkdir(destination, { recursive: true });
	await writeFile(path.join(destination, "changes.json"), JSON.stringify(changes, null, 2));
	// Materialise only changed files so diff also includes untracked additions and dirty starting content.
	for (const side of ["before", "after"] as const) {
		await mkdir(path.join(destination, side), { recursive: true });
		for (const change of changes) {
			const state = change[side];
			if (!state) continue;
			const target = path.join(destination, side, change.path);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, state.kind === "symlink" ? state.content : Buffer.from(state.content, "base64"));
		}
	}
	const diff = await $`git diff --no-index --binary -- before after`.cwd(destination).nothrow().quiet();
	if (diff.exitCode > 1) throw new Error(diff.stderr.toString());
	await writeFile(path.join(destination, "final.patch"), diff.stdout);
	return {
		directory: destination,
		changedFiles: changes.length,
		patch: path.join(destination, "final.patch"),
		manifest: path.join(destination, "changes.json"),
	};
}
