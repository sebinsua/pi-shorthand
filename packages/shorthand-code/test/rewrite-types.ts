/** Compile-time checks for the public code-program API. Never executed. */
import type { ShorthandGlobals } from "../src/program/api.d.ts";

export function rewriteTypes(sg: ShorthandGlobals["sg"]) {
	sg.rewrite("foo($A)", (m) => m.node.getMatch("A")!.replace("1"));
	sg.rewrite("foo($A)", (m) => [m.node.getMatch("A")!.replace("1")] as const);
	const match = sg.one("foo($A)", "a.ts");
	sg.rewrite(match, (m) => m.node.getMatch("A")!.replace("2"));
	sg.rewrite([match] as const, "bar($A)");
	sg.rewrite(sg.find("foo($A)"), () => null);
	// @ts-expect-error Selected matches already specify their files.
	sg.rewrite(match, "bar()", "a.ts");
	// @ts-expect-error A file scope is not a selected syntax match.
	sg.rewrite(sg.file("a.ts"), "bar()");
	sg.rewrite("foo($A)", () => false);
	sg.rewrite("foo($A)", () => undefined);
	// @ts-expect-error Callbacks are synchronous.
	sg.rewrite("foo($A)", async () => "bar()");
	// @ts-expect-error Arbitrary objects are not edits.
	sg.rewrite("foo($A)", () => ({ replacement: "bar()" }));
	// @ts-expect-error Only false is a skip value, not true.
	sg.rewrite("foo($A)", () => true);
	// @ts-expect-error Arrays contain edits, not whole-match strings.
	sg.rewrite("foo($A)", () => ["bar()"]);
}
