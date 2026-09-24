import { expect, test } from "bun:test";
import { preserveTextFormat } from "../src/runner/text-format.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("preserves UTF-8 BOMs and uniform LF, CRLF or CR conventions", () => {
	for (const ending of ["\n", "\r\n", "\r"]) {
		expect(preserveTextFormat(bytes(`\uFEFFbefore${ending}`), bytes("after\nadded\r\n"))).toEqual(
			bytes(`\uFEFFafter${ending}added${ending}`),
		);
	}
});

test("does not infer endings from mixed or single-line files, or change trailing-newline intent", () => {
	for (const original of ["a\r\nb\n", "a"]) {
		const updated = bytes("changed\n");
		expect(preserveTextFormat(bytes(original), updated)).toBe(updated);
	}
	expect(preserveTextFormat(bytes("before\r\n"), bytes("after"))).toEqual(bytes("after"));
});

test("leaves binary and invalid UTF-8 content byte-exact on either side", () => {
	for (const binary of [new Uint8Array([0, 13, 10]), new Uint8Array([255, 10])]) {
		const text = bytes("text\r\n");
		expect(preserveTextFormat(text, binary)).toBe(binary);
		expect(preserveTextFormat(binary, text)).toBe(text);
	}
});

test("does not duplicate a BOM or allocate for unchanged conventions", () => {
	const updated = bytes("\uFEFFnew\r\n");
	expect(preserveTextFormat(bytes("\uFEFFold\r\n"), updated)).toBe(updated);
});
