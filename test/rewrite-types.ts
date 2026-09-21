/** Compile-time checks for the public code-program API. Never executed. */
import type { ShorthandGlobals } from "../api.d.ts";

export function rewriteTypes(sg: ShorthandGlobals["sg"]) {
	sg.rewrite("foo($A)", (m) => m.node.getMatch("A")!.replace("1"));
	sg.rewrite("foo($A)", (m) => [m.node.getMatch("A")!.replace("1")] as const);
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
