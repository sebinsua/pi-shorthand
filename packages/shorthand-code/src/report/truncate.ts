/**
 * Tool-output limits for callers without their own, matching Pi's defaults: whichever of 2000 lines or
 * 50KB is reached first. Only whole lines are kept, except a single last line too long to fit on its own.
 */
import type { Truncate } from "./text-for-model.ts";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Keeps the start. */
export const truncateHead: Truncate = (content) => {
	const lines = content.split("\n");
	const kept: string[] = [];
	let size = 0;
	for (const line of lines) {
		const added = bytes(line) + (kept.length > 0 ? 1 : 0);
		if (kept.length === MAX_LINES || size + added > MAX_BYTES) break;
		kept.push(line);
		size += added;
	}
	return result(content, kept, lines.length);
};

/** Keeps the end, where errors and final results usually are. */
export const truncateTail: Truncate = (content) => {
	const lines = content.split("\n");
	const kept: string[] = [];
	let size = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const added = bytes(lines[index]) + (kept.length > 0 ? 1 : 0);
		if (kept.length === MAX_LINES || size + added > MAX_BYTES) break;
		kept.unshift(lines[index]);
		size += added;
	}
	if (kept.length === 0 && lines.length > 0) {
		// The last line alone is over the byte limit: keep its end.
		const last = Buffer.from(lines.at(-1)!, "utf8");
		kept.push(last.subarray(last.length - MAX_BYTES).toString("utf8"));
	}
	return result(content, kept, lines.length);
};

function result(original: string, kept: string[], totalLines: number) {
	const content = kept.join("\n");
	return { content, truncated: content !== original, outputLines: kept.length, totalLines };
}
