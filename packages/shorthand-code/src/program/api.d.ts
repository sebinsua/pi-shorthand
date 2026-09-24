/** Types for programs executed by the code tool. Type-only: this does not install runtime globals. */
import type { ShorthandGlobals } from "./prelude.ts";

declare global {
	const $: ShorthandGlobals["$"];
	const edit: ShorthandGlobals["edit"];
	const glob: ShorthandGlobals["glob"];
	const grep: ShorthandGlobals["grep"];
	const sg: ShorthandGlobals["sg"];
	const refactor: ShorthandGlobals["refactor"];
}

export type { RewriteResult } from "./prelude.ts";
export type { ShorthandGlobals };
