import { expect, test } from "bun:test";
import { changeKind, modelDiff } from "../src/report/model-diff.ts";
import type { FileChange } from "../src/runner/runner.ts";

const change = (path: string, before: string, after: string, kind: FileChange["kind"] = "modified"): FileChange => ({
	path,
	kind,
	patch: [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -1 +1 @@",
		`-${before}`,
		`+${after}`,
	].join("\n"),
});

const renames = (count: number) =>
	Array.from({ length: count }, (_, i) =>
		change(`src/f${i}.ts`, `formatAmount(${i}, "a${i}");`, `formatPrice(${i}, "a${i}");`),
	);

test("a small diff is shown whole", () => {
	const changes = renames(3);
	expect(modelDiff(changes)).toEqual({ text: changes.map((c) => c.patch).join("\n"), summarized: false });
});

test("repeated edits differing only in numbers and strings are one kind of change", () => {
	expect(changeKind(renames(2)[0]!.patch)).toBe(changeKind(renames(2)[1]!.patch));
	expect(changeKind(renames(1)[0]!.patch)).not.toBe(
		changeKind(change("x.ts", "formatAmount(1);", "formatPrice(1, {});").patch),
	);
});

test("a large diff shows one example of each kind, rarest first, with how many files share it", () => {
	const odd = change("src/odd.ts", "const formatAmount = 1;", "const formatPrice = 1;");
	const added = change("src/new.ts", "", "export {};", "added");
	const shown = modelDiff([...renames(40), odd, added], 1_000);

	expect(shown.summarized).toBe(true);
	const lines = shown.text.split("\n");
	expect(lines[0]).toBe("[42 files changed in 3 distinct ways; one example of each is shown]");
	expect(shown.text.indexOf("src/odd.ts")).toBeLessThan(shown.text.indexOf("src/f0.ts"));
	expect(shown.text).toContain("src/new.ts");
	expect(shown.text).toContain("(and 39 more files with the same change)");
	expect(shown.text).not.toContain("src/f1.ts");
});

test("examples beyond the size limit are counted rather than shown", () => {
	const distinct = Array.from({ length: 30 }, (_, i) =>
		change(`src/f${i}.ts`, `call${"x".repeat(i)}();`, `next${"y".repeat(i)}();`),
	);
	const shown = modelDiff(distinct, 1_000);

	expect(shown.text.split("\n")[0]).toMatch(
		/^\[30 files changed in 30 distinct ways; one example of each is shown, except \d+ files over the size limit\]$/,
	);
	expect(shown.text.length).toBeLessThan(1_500);
});
