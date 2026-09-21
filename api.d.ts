/** Types for programs executed by the code tool. Type-only: this does not install runtime globals. */
import type { ShorthandGlobals } from "./prelude.ts";

declare global {
	const $: ShorthandGlobals["$"];
	const glob: ShorthandGlobals["glob"];
	const grep: ShorthandGlobals["grep"];
	const sg: ShorthandGlobals["sg"];
	const grit: ShorthandGlobals["grit"];
}

export type { RewriteResult } from "./prelude.ts";
export type { ShorthandGlobals };
