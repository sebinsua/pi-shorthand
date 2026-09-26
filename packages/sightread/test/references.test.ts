// Exercise compiler-resolved references through the CLI and a real graph server.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphResult } from "../src/model.ts";
import { renderText } from "../src/render.ts";

const repository = mkdtempSync(join(realpathSync("/tmp"), "sr-ref-"));
const root = join(repository, "client");
const runtime = mkdtempSync(join(realpathSync("/tmp"), "sr-run-"));
const cli = join(import.meta.dir, "../src/cli.ts");
const files: Record<string, string> = {
	"tsconfig.json":
		'{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"nodenext","moduleResolution":"nodenext"}}',
	"src/row.ts": [
		"export interface Getter { get(i: number): number; }",
		"export class Row implements Getter {",
		"  get(i: number) { return i; }",
		"}",
	].join("\n"),
	"src/barrel.ts": 'export { Row as ExportedRow } from "./row.ts";\n',
	"src/use.ts": [
		'import { Row as TableRow, type Getter } from "./row.ts";',
		'import { ExportedRow } from "./barrel.ts";',
		"const row = new TableRow();",
		"export function twice() { return row.get(1) + row.get(2); }",
		"export function multiline() { return row",
		"  .get(",
		"    3,",
		"  ); }",
		"export function optional() { return row?.get(0); }",
		"export function throughInterface(value: Getter) { return value.get(4); }",
		"export function throughExport() { return new ExportedRow().get(5); }",
		"class Cache { get(i: number) { return i; } }",
		"const get = (i: number) => i;",
		"export const decoys = new Cache().get(6) + get(7) + '.get('.length;",
	].join("\n"),
	"src/View.tsx": [
		'import { Row } from "./row.ts";',
		"type Item<T> = { id: string; value: T };",
		"export function View<T>({ items }: { items: Item<T>[] }) {",
		"  const row = new Row();",
		"  return <main data-count={row.get(8)}><header><h1>Rows</h1></header><section>",
		"    {items.map((item) => <article key={item.id}><h2>{item.id}</h2><p>{String(item.value)}</p></article>)}",
		"  </section></main>;",
		"}",
	].join("\n"),
};
mkdirSync(root);
for (const [name, contents] of Object.entries(files)) {
	const path = join(root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${contents}\n`);
}

function run(...args: string[]) {
	return runIn(root, ...args);
}

function runIn(directory: string, ...args: string[]) {
	const child = Bun.spawnSync([process.execPath, cli, "--cwd", directory, ...args], {
		env: { ...Bun.env, XDG_RUNTIME_DIR: runtime },
	});
	return { code: child.exitCode, out: child.stdout.toString().trimEnd(), err: child.stderr.toString().trimEnd() };
}

const fresh = join(repository, "fresh");
mkdirSync(join(fresh, "src"), { recursive: true });
writeFileSync(join(fresh, "tsconfig.json"), '{"compilerOptions":{"strict":true,"module":"nodenext"}}\n');
writeFileSync(join(fresh, "src/row.ts"), "export class Row { get(i: number) { return i; } }\n");

afterAll(() => {
	run("stop");
	runIn(fresh, "stop");
	rmSync(repository, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
});

test("references include each resolved occurrence and its source line", () => {
	const output = run("--json", JSON.stringify({ type: "references", symbol: "Row.get" }));
	expect(output.code).toBe(0);
	const [result] = JSON.parse(output.out) as Array<{
		type: string;
		shown: number;
		nodes: Array<{ file: string; line: number; col: number; endCol: number; text: string }>;
	}>;
	expect(result.type).toBe("references");
	expect(result.shown).toBe(7);
	expect(result.nodes.map(({ file, line, col, endCol, text }) => ({ file, line, col, endCol, text }))).toEqual([
		{
			file: "src/use.ts",
			line: 4,
			col: 38,
			endCol: 41,
			text: "export function twice() { return row.get(1) + row.get(2); }",
		},
		{
			file: "src/use.ts",
			line: 4,
			col: 51,
			endCol: 54,
			text: "export function twice() { return row.get(1) + row.get(2); }",
		},
		{ file: "src/use.ts", line: 6, col: 4, endCol: 7, text: "  .get(\n    3,\n  ); }" },
		{ file: "src/use.ts", line: 9, col: 42, endCol: 45, text: "export function optional() { return row?.get(0); }" },
		{
			file: "src/use.ts",
			line: 10,
			col: 64,
			endCol: 67,
			text: "export function throughInterface(value: Getter) { return value.get(4); }",
		},
		{
			file: "src/use.ts",
			line: 11,
			col: 60,
			endCol: 63,
			text: "export function throughExport() { return new ExportedRow().get(5); }",
		},
		{
			file: "src/View.tsx",
			line: 5,
			col: 32,
			endCol: 35,
			text: "  return <main data-count={row.get(8)}><header><h1>Rows</h1></header><section>",
		},
	]);
	expect(run(JSON.stringify({ type: "references", symbol: "Row.get" })).out).toBe(
		[
			"references to Row.get (declared at src/row.ts:3): 7 in 2 files",
			"",
			"src/use.ts",
			"   4:38  export function twice() { return row.get(1) + row.get(2); }",
			"   4:51  export function twice() { return row.get(1) + row.get(2); }",
			"    6:4  .get(",
			"           3,",
			"         ); }",
			"   9:42  export function optional() { return row?.get(0); }",
			"  10:64  export function throughInterface(value: Getter) { return value.get(4); }",
			"  11:60  export function throughExport() { return new ExportedRow().get(5); }",
			"",
			"src/View.tsx",
			"  5:32  return <main data-count={row.get(8)}><header><h1>Rows</h1></header><section>",
		].join("\n"),
	);
});

test("declarations are included only when requested", () => {
	const [result] = JSON.parse(
		run(
			"--json",
			JSON.stringify({
				type: "references",
				symbol: "Row.get",
				includeDeclaration: true,
			}),
		).out,
	) as Array<{ nodes: Array<{ file: string; line: number; col: number; endCol: number; text: string }> }>;
	expect(
		result.nodes
			.filter(({ file }) => file === "src/row.ts")
			.map(({ file, line, col, endCol, text }) => ({ file, line, col, endCol, text })),
	).toEqual([{ file: "src/row.ts", line: 3, col: 3, endCol: 6, text: "  get(i: number) { return i; }" }]);
});

test("names, errors, help, and batches use the references request", () => {
	const help = run("--help");
	expect(help.out).toContain("references\n  symbol*");
	expect(help.out).toContain("  includeDeclaration");
	const missing = run(JSON.stringify({ type: "references", symbol: "Row.noSuchMethod" }));
	expect(missing.code).toBe(1);
	expect(missing.err).toContain("Row.noSuchMethod not found");
	const ambiguous = run(JSON.stringify({ type: "references", symbol: "get" }));
	expect(ambiguous.code).toBe(1);
	expect(ambiguous.err).toContain("get is ambiguous; use a handle:");
	const handle = run("--json", JSON.stringify({ type: "references", symbol: "src/row.ts#Row.get:method" }));
	expect((JSON.parse(handle.out) as Array<{ shown: number }>)[0].shown).toBe(7);
	const batch = run(
		"--json",
		JSON.stringify([
			{ type: "references", symbol: "Row.get" },
			{ type: "trace", from: "Row.get", direction: "reverse" },
		]),
	);
	expect(batch.code).toBe(0);
	const results = JSON.parse(batch.out) as Array<{ type: string; nodes: unknown[] }>;
	expect(results.map(({ type }) => type)).toEqual(["references", "trace"]);
	expect(results[0].nodes).toHaveLength(7);
	expect(results[1].nodes.length).toBeGreaterThan(0);
});

test("references follow edits, new files and deleted files between queries", () => {
	const write = (name: string, lines: string[]) => writeFileSync(join(fresh, name), `${lines.join("\n")}\n`);
	const sites = () =>
		(
			JSON.parse(runIn(fresh, "--json", JSON.stringify({ type: "references", symbol: "Row.get" })).out) as Array<{
				nodes: Array<{ file: string; line: number; col: number; text: string }>;
			}>
		)[0].nodes.map(({ file, line, col, text }) => `${file}:${line}:${col} ${text}`);
	write("src/a.ts", ['import { Row } from "./row.ts";', "export const a = (row: Row) => row.get(1);"]);
	write("src/b.ts", ['import { Row } from "./row.ts";', "export const b = (row: Row) => row.get(2);"]);
	expect(sites()).toEqual([
		"src/a.ts:2:36 export const a = (row: Row) => row.get(1);",
		"src/b.ts:2:36 export const b = (row: Row) => row.get(2);",
	]);
	write("src/a.ts", ['import { Row } from "./row.ts";', "", "export const a = (row: Row) => row.get(1) + row.get(3);"]);
	write("src/c.ts", ['import { Row } from "./row.ts";', "export const c = (row: Row) => row.get(4);"]);
	unlinkSync(join(fresh, "src/b.ts"));
	expect(sites()).toEqual([
		"src/a.ts:3:36 export const a = (row: Row) => row.get(1) + row.get(3);",
		"src/a.ts:3:49 export const a = (row: Row) => row.get(1) + row.get(3);",
		"src/c.ts:2:36 export const c = (row: Row) => row.get(4);",
	]);
	write("src/c.ts", ["export const c = 4;"]);
	expect(sites()).toEqual([
		"src/a.ts:3:36 export const a = (row: Row) => row.get(1) + row.get(3);",
		"src/a.ts:3:49 export const a = (row: Row) => row.get(1) + row.get(3);",
	]);
});

test("colour dims each line and keeps its own reference bright", () => {
	const text = "\treturn row.get(1) + row.get(2);";
	const node = (col: number) => ({
		handle: `src/a.ts#reference:4:${col}`,
		name: "Row.get",
		file: "src/a.ts",
		line: 4,
		col,
		endCol: col + 3,
		text,
		ranges: null,
	});
	const result: GraphResult = {
		type: "references",
		shown: 2,
		nodes: [node(13), node(26)],
		edges: [],
		sections: { symbol: "Row.get" },
	};
	const [bold, dim, reset] = ["\u001b[1m", "\u001b[2m", "\u001b[0m"];
	expect(renderText(result, { color: true }).split("\n")).toEqual([
		"references to Row.get: 2 in 1 file",
		"",
		`${bold}src/a.ts${reset}`,
		`  ${dim}4:13${reset}  ${dim}return row.${reset}${bold}get${reset}${dim}(1) + row.get(2);${reset}`,
		`  ${dim}4:26${reset}  ${dim}return row.get(1) + row.${reset}${bold}get${reset}${dim}(2);${reset}`,
	]);
	expect(renderText(result, { color: false }).split("\n").slice(2)).toEqual([
		"src/a.ts",
		"  4:13  return row.get(1) + row.get(2);",
		"  4:26  return row.get(1) + row.get(2);",
	]);
});

test("a single symbol, qualified by its file, works in details and trace", () => {
	const output = run(
		"--json",
		JSON.stringify([
			{ type: "details", symbol: "src/row.ts#Row.get" },
			{ type: "trace", symbol: "src/row.ts#Row.get", direction: "reverse" },
			{ type: "references", symbol: "src/row.ts#Row.get" },
		]),
	);
	expect(output.code).toBe(0);
	const [details, trace, references] = JSON.parse(output.out) as Array<{
		type: string;
		nodes: Array<{ handle: string; exported?: true; line?: number; endLine?: number }>;
	}>;
	expect(details.type).toBe("details");
	expect(details.nodes.map(({ handle }) => handle)).toContain("src/row.ts#Row.get:method");
	expect(trace.type).toBe("trace");
	expect(references.nodes.find(({ line }) => line === 6)?.endLine).toBe(8);
	const missing = run(JSON.stringify({ type: "details", symbol: "src/use.ts#Row.get" }));
	expect(missing.code).toBe(1);
	expect(missing.err).toContain("src/use.ts#Row.get not found");
});
