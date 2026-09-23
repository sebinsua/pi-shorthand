/**
 * The diff the model reads after a run. Small diffs are shown whole. A large diff is usually one kind of
 * change repeated across many files, so it is shown as one example of each kind, with how many files share
 * it; the per-file list and a path to the whole diff come with it. What people see in Pi is rendered from
 * the result's details, not from this text.
 */
import type { FileChange } from "./runner.ts";

/** Diffs up to this size are shown whole: about 4,000 tokens. */
export const WHOLE_DIFF_CHARS = 16_000;

/** Changed lines, ignoring numbers and string contents, which usually differ between repeated edits. */
export function changeKind(patch: string): string {
	return patch
		.split("\n")
		.filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line))
		.map((line) =>
			line
				.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
				.replace(/\d+/g, "0")
				.trim(),
		)
		.join("\n");
}

export interface ModelDiff {
	text: string;
	/** True when some files are represented by an example rather than shown. */
	summarized: boolean;
}

export function modelDiff(changes: FileChange[], budget = WHOLE_DIFF_CHARS): ModelDiff {
	const whole = changes.map((change) => change.patch).join("\n");
	if (whole.length <= budget) return { text: whole, summarized: false };

	const kinds = new Map<string, FileChange[]>();
	for (const change of changes) {
		const kind = `${change.kind}\0${changeKind(change.patch)}`;
		kinds.set(kind, [...(kinds.get(kind) ?? []), change]);
	}
	// Rarer kinds first: an unusual edit is more likely to be the mistake worth seeing.
	const groups = [...kinds.values()].toSorted((a, b) => a.length - b.length);
	const sections: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const [example, ...same] of groups) {
		const section = [
			example!.patch,
			...(same.length ? [`(and ${same.length} more file${same.length === 1 ? "" : "s"} with the same change)`] : []),
		].join("\n");
		if (sections.length > 0 && used + section.length > budget) {
			omitted += 1 + same.length;
			continue;
		}
		sections.push(section);
		used += section.length;
	}
	const header = `[${changes.length} files changed in ${groups.length} distinct way${groups.length === 1 ? "" : "s"}; one example of each is shown${omitted ? `, except ${omitted} file${omitted === 1 ? "" : "s"} over the size limit` : ""}]`;
	return { text: [header, ...sections].join("\n"), summarized: true };
}
