import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import type { Drift } from "./drift.ts";

export interface Task {
	id: string;
	category: "small-edit" | "migration" | "implementation" | "extraction" | "propagation" | "rename" | "move";
	revision: string;
	/** Outcome-only request: the agent explores and decides how to make the change. */
	prompt: string;
	/** A precise, tool-neutral request, as a parent agent would write after exploring. */
	brief?: string;
	files: Record<string, string>;
	/** Files that must exist after the change; `null` marks a file the change removes. */
	solution: Record<string, string | null>;
	/** tsconfig `include`; flat fixtures keep the original `*.ts`. */
	include?: string[];
	verify: (root: string) => Promise<void>;
	/** Counts of missed, over-matched and unrelated changes, reported even when verification fails. */
	drift?: (root: string) => Promise<Drift>;
}

export type PromptStyle = "outcome" | "brief";

export function promptFor(task: Task, style: PromptStyle): string {
	if (style === "outcome") return task.prompt;
	if (!task.brief) throw new Error(`Task ${task.id} has no brief prompt`);
	return task.brief;
}

export const source = (root: string, file: string) => readFile(path.join(root, file), "utf8");
export const moduleAt = (root: string, file: string) =>
	import(`${pathToFileURL(path.join(root, file)).href}?verify=${crypto.randomUUID()}`);
export const parseSource = async (root: string, file: string) =>
	parse(Lang.TypeScript, await source(root, file)).root();
