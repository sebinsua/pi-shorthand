/**
 * Drift: how far a change strayed from its intended edit set, independent of whether it passed.
 * A missed site is an intended change that is absent; an over-matched decoy is similar-looking source the
 * change should have left alone; an unrelated file is a change outside the expected files. Changes inside
 * an expected file are counted only through its sites and decoys.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

export interface Drift {
	sites: number;
	missed: string[];
	decoys: number;
	overmatched: string[];
	unrelated: string[];
}

/** A condition on one file's squashed source; `undefined` when the file is absent. */
export interface Check {
	file: string;
	label: string;
	holds: (text: string | undefined, root: string) => boolean;
}

/** Ignore layout, quote style and trailing commas, so formatting choices are not counted as drift. */
export const squash = (text: string) =>
	text
		.replace(/\s+/g, "")
		.replaceAll("'", '"')
		.replace(/,([)\]}])/g, "$1");

export const contains = (file: string, snippet: string, label = snippet): Check => ({
	file,
	label: `${file}: ${label}`,
	holds: (text) => text?.includes(squash(snippet)) ?? false,
});

export const matches = (file: string, pattern: RegExp, label = String(pattern)): Check => ({
	file,
	label: `${file}: ${label}`,
	holds: (text) => (text === undefined ? false : pattern.test(text)),
});

export const absent = (file: string): Check => ({
	file,
	label: `${file} removed`,
	holds: (text) => text === undefined,
});

/** Module identity without extension or index file, as extensionless and `.js` specifiers name it. */
const moduleId = (file: string) => file.replace(/\.[jt]s$/, "").replace(/\/index$/, "");

/** Some static import or re-export in `file` resolves to `target` (both repository-relative). */
export const resolvesTo = (file: string, target: string): Check => ({
	file,
	label: `${file} imports ${target}`,
	holds: (text, root) =>
		[...(text ?? "").matchAll(/from"([^"]+)"/g)].some(
			([, specifier]) =>
				specifier!.startsWith(".") &&
				moduleId(path.resolve(root, path.dirname(file), specifier!)) === moduleId(path.resolve(root, target)),
		),
});

export async function measureDrift(
	root: string,
	{ expected, sites, decoys }: { expected: Iterable<string>; sites: Check[]; decoys: Check[] },
): Promise<Drift> {
	const texts = new Map<string, string | undefined>();
	const text = async (file: string) => {
		if (!texts.has(file)) texts.set(file, await readFile(path.join(root, file), "utf8").then(squash, () => undefined));
		return texts.get(file);
	};
	const failing = async (checks: Check[]) => {
		const result: string[] = [];
		for (const check of checks) if (!check.holds(await text(check.file), root)) result.push(check.label);
		return result;
	};
	return {
		sites: sites.length,
		missed: await failing(sites),
		decoys: decoys.length,
		overmatched: await failing(decoys),
		unrelated: await unrelatedChanges(root, new Set(expected)),
	};
}

/** Files differing from the fixture's commit, other than expected ones; whitespace-only changes are ignored. */
async function unrelatedChanges(root: string, expected: Set<string>): Promise<string[]> {
	const status = await $`git status --porcelain=v1 -z --untracked-files=all`.cwd(root).quiet().text();
	const result: string[] = [];
	const fields = status.split("\0");
	const files: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		const entry = fields[index]!;
		if (!entry) continue;
		files.push(entry.slice(3));
		// A rename or copy, as from `git mv`, is followed by its original path as a separate field.
		if (/^[RC]/.test(entry)) files.push(fields[++index]!);
	}
	for (const file of files) {
		if (expected.has(file)) continue;
		const before = await $`git show HEAD:${file}`.cwd(root).quiet().nothrow();
		const after = await readFile(path.join(root, file), "utf8").catch(() => undefined);
		if (before.exitCode === 0 && after !== undefined && squash(before.text()) === squash(after)) continue;
		result.push(file);
	}
	return result.toSorted();
}

export function assertNoDrift(drift: Drift): void {
	assert.deepEqual(
		{ missed: drift.missed, overmatched: drift.overmatched, unrelated: drift.unrelated },
		{ missed: [], overmatched: [], unrelated: [] },
		"Change drifted from the intended edit set",
	);
}
