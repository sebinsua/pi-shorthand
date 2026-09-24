import { expect, test } from "bun:test";
import { MAX_BYTES, MAX_LINES, truncateHead, truncateTail } from "../src/report/truncate.ts";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

test("text within the limits is unchanged", () => {
	for (const truncate of [truncateHead, truncateTail]) {
		expect(truncate("a\nb")).toEqual({ content: "a\nb", truncated: false, outputLines: 2, totalLines: 2 });
		expect(truncate("")).toMatchObject({ content: "", truncated: false });
	}
});

test("the line limit keeps the first or last lines", () => {
	const text = lines(MAX_LINES + 5);
	const head = truncateHead(text);
	expect(head).toMatchObject({ truncated: true, outputLines: MAX_LINES, totalLines: MAX_LINES + 5 });
	expect(head.content.split("\n").at(-1)).toBe(`line ${MAX_LINES}`);
	const tail = truncateTail(text);
	expect(tail).toMatchObject({ truncated: true, outputLines: MAX_LINES });
	expect(tail.content.split("\n")[0]).toBe("line 6");
});

test("the byte limit keeps whole lines", () => {
	const line = "x".repeat(1023);
	const text = Array.from({ length: 60 }, () => line).join("\n"); // 1KB per line with its newline
	const head = truncateHead(text);
	expect(head.truncated).toBe(true);
	expect(Buffer.byteLength(head.content)).toBeLessThanOrEqual(MAX_BYTES);
	expect(head.content.split("\n").every((kept) => kept === line)).toBe(true);
	expect(truncateTail(text).outputLines).toBe(head.outputLines);
});

test("a last line over the byte limit keeps its end", () => {
	const text = `start\n${"a".repeat(MAX_BYTES)}end`;
	const tail = truncateTail(text);
	expect(tail).toMatchObject({ truncated: true, outputLines: 1, totalLines: 2 });
	expect(tail.content.endsWith("end")).toBe(true);
	expect(Buffer.byteLength(tail.content)).toBe(MAX_BYTES);
	expect(truncateHead(text)).toMatchObject({ content: "start", truncated: true, outputLines: 1 });
});
