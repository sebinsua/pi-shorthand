/** How results look in Pi, checked as plain text against hand-built results. */

import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { callLine, resultLines } from "../display.ts";
import type { FileChange, RunResult } from "../runner.ts";

// Plain text: no colours, so the tests read the words and layout.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
beforeAll(() => initTheme("dark")); // renderDiff uses Pi's global theme

const change = (path: string, added = 1, removed = 1): FileChange => ({
	path,
	kind: "modified",
	patch: [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${removed} +1,${added} @@`,
		...Array.from({ length: removed }, (_, i) => `-old ${i}`),
		...Array.from({ length: added }, (_, i) => `+new ${i}`),
	].join("\n"),
});

const result = (overrides: Partial<RunResult>): RunResult => ({
	exitCode: 0,
	timedOut: false,
	durationMs: 600,
	output: "",
	warnings: [],
	cleanupWarnings: [],
	changes: [],
	applied: [],
	conflicts: [],
	rolledBack: [],
	stillRunning: [],
	timeoutMs: 2000,
	rollback: "all",
	...overrides,
});

const show = (run: RunResult, expanded = false) =>
	resultLines(run, expanded, theme).map((line) => Bun.stripANSI(line).trimEnd());

describe("the verdict", () => {
	test("success", () => {
		const run = result({ changes: [change("a.ts"), change("b.ts")], applied: ["a.ts", "b.ts"] });
		expect(show(run)[0]).toBe("✓ Applied 2 files · +2 −2 · 0.6s");
	});

	test("no changes", () => {
		expect(show(result({}))[0]).toBe("✓ No changes · 0.6s");
	});

	test('a failure with rollback "all" says it rolled back everything', () => {
		const run = result({ exitCode: 1, changes: [change("a.ts")] });
		expect(show(run)[0]).toBe("✕ Failed · rolled back all changes · exit 1 · 0.6s");
	});

	test('a timeout with rollback "file" says what it kept and rolled back', () => {
		const run = result({
			exitCode: null,
			timedOut: true,
			timeoutMs: 1000,
			rollback: "file",
			changes: [change("a.ts"), change("b.ts")],
			applied: ["a.ts"],
			rolledBack: ["b.ts"],
		});
		const lines = show(run);
		expect(lines[0]).toBe("⚠ Timed out after 1s · kept 1 file, rolled back 1 · +1 −1 · 0.6s");
		expect(lines[1]).toBe("  rolled back b.ts: half-written when the program was killed");
	});

	test("a conflict says nothing was applied and names the changed destination", () => {
		const run = result({ changes: [change("a.ts")], conflicts: ["a.ts"] });
		expect(show(run).slice(0, 2)).toEqual(["✕ Conflict · nothing applied · 0.6s", "  changed while running: a.ts"]);
	});

	test("a conflict preserves a failure or timeout from the program", () => {
		expect(show(result({ exitCode: 2, conflicts: ["a.ts"] }))[0]).toBe("✕ Conflict · nothing applied · exit 2 · 0.6s");
		expect(show(result({ exitCode: null, timedOut: true, timeoutMs: 1000, conflicts: ["a.ts"] }))[0]).toBe(
			"✕ Conflict · nothing applied · timed out after 1s · 0.6s",
		);
	});

	test("a late conflict reports files already applied", () => {
		const run = result({ changes: [change("a.ts"), change("b.ts")], applied: ["a.ts"], conflicts: ["b.ts"] });
		expect(show(run)[0]).toBe("✕ Conflict · 1 file applied · 0.6s");
	});

	test("the call line names a non-default rollback mode and the timeout", () => {
		expect(callLine({ title: "Rename", rollback: "file", timeout: 5 }, theme)).toBe(
			"code Rename (rollback per file, timeout 5s)",
		);
		expect(callLine({ title: "Rename" }, theme)).toBe("code Rename");
	});
});

describe("what went wrong", () => {
	test("a failure shows the error, then the program line it came from", () => {
		const run = result({ exitCode: 1, output: "error: expected 1 match, found 3\n", errorLine: "line 3: throw x;" });
		expect(show(run).slice(0, 3)).toEqual([
			"✕ Failed · no changes · exit 1 · 0.6s",
			"  expected 1 match, found 3",
			"  line 3: throw x;",
		]);
	});

	test("a timeout names the command still running, or else the last step", () => {
		const stuck = result({ exitCode: null, timedOut: true, stillRunning: ["find / -name x (for 2s)"] });
		expect(show(stuck)[1]).toBe("  stuck on $ find / -name x (for 2s)");
		const inCode = result({ exitCode: null, timedOut: true, lastStep: 'grep("x") (3 ms)' });
		expect(show(inCode)[1]).toBe('  last step: grep("x") (3 ms)');
	});

	test("warnings, found before or printed while running, are indented under the verdict", () => {
		const run = result({
			warnings: ["line 1: $`x` isn't awaited"],
			output: "warning: sg.rewrite matched nothing\nhello\n",
		});
		expect(show(run)).toEqual([
			"✓ No changes · 0.6s",
			"  ⚠ line 1: $`x` isn't awaited",
			"  ⚠ sg.rewrite matched nothing",
			"",
			"hello",
		]);
	});
});

describe("sections", () => {
	test("output is labelled as the program's when there's also a diff", () => {
		const run = result({ changes: [change("a.ts")], applied: ["a.ts"], output: "done\n" });
		const lines = show(run);
		expect(lines.slice(lines.indexOf("Program output"))).toEqual(["Program output", "done"]);
	});

	test("hundreds of files collapse to a short list", () => {
		const changes = Array.from({ length: 300 }, (_, i) => change(`f${i}.ts`));
		const lines = show(result({ changes, applied: changes.map((c) => c.path) }));
		expect(lines[0]).toBe("✓ Applied 300 files · +300 −300 · 0.6s");
		expect(lines).toContain("… and 292 more files");
		expect(lines.length).toBeLessThan(15);
	});

	test("a failure's diff is one line until expanded", () => {
		const run = result({ exitCode: 1, changes: [change("a.ts")] });
		expect(show(run).at(-1)).toMatch(/^Would have changed 1 file · \+1 −1 \(/);
		expect(show(run, true)).toContain("a.ts +1 −1");
	});
});
