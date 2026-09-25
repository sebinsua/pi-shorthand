// Check complete text for live lookup, trace, details, tour, and overview results.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { normalizeResult, type GraphResult } from "../src/model.ts";
import { createRangeIndex, parseDeclarations, type RangeIndex } from "../src/ranges.ts";
import { renderText } from "../src/render.ts";
import { startGraphClient, type GraphClient } from "../src/upstream.ts";
import { createFixtureProject } from "./fixture.ts";

const fixture = createFixtureProject({
	"client/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
	"client/src/model.ts": [
		"export function greet(name: string) { return `Hi ${name}`; }",
		'export function caller() { return greet("Ada"); }',
		"export class Greeter {",
		"  sayHello(value: string): string;",
		"  sayHello(value: number): number;",
		"  sayHello(value: string | number) { return value; }",
		"}",
	].join("\n"),
	"client/src/View.tsx": [
		"type Row<T> = { id: string; value: T };",
		"export function View<T>({ rows }: { rows: Row<T>[] }) {",
		'  return <main className="list"><h1>Rows</h1><section>{rows.map((row) =>',
		"    <article key={row.id}><header>{row.id}</header><p>{String(row.value)}</p></article>",
		"  )}</section></main>;",
		"}",
	].join("\n"),
});
const root = join(fixture.root, "client");
let client: GraphClient;
let ranges: RangeIndex;
const outputs = new Map<string, string>();

beforeAll(async () => {
	client = await startGraphClient({ root, tsconfig: join(root, "tsconfig.json") });
	ranges = createRangeIndex(root);
	for (const request of [
		{ type: "lookup", query: "greet", limit: 3 },
		{ type: "trace", from: "src/model.ts#greet:function", direction: "reverse", maxNodes: 6 },
		{ type: "details", handles: ["src/model.ts#greet:function"], neighbors: true },
		{ type: "tour", reinterpretations: ["greet"], limit: 2 },
		{ type: "overview", aspect: "all" },
	]) {
		const value = (await client.query(request)).value;
		outputs.set(request.type, renderText(await normalizeResult(request, value, ranges), { color: false }));
	}
});

afterAll(async () => {
	await ranges?.close();
	await client?.close();
	fixture.cleanup();
});

test("lookup ranked text is complete", () => {
	expect(outputs.get("lookup")).toBe(
		[
			"lookup for greet: 2 shown",
			"",
			"hits",
			"  = greet    function  src/model.ts:1-1",
			"    Greeter  class     src/model.ts:3-7",
		].join("\n"),
	);
});

test("reverse trace text is complete and each edge has one evidence line", () => {
	expect(outputs.get("trace")).toBe(
		[
			"trace reverse from greet: 1 shown",
			"",
			"src/model.ts",
			"  1-1  greet   function",
			"  2-2  caller  function",
			"",
			"hops",
			"  caller → greet  calls at model.ts:2",
		].join("\n"),
	);
});

test("details text is complete", () => {
	expect(outputs.get("details")).toBe(["details: 1 shown", "", "src/model.ts", "  1-1  greet  function"].join("\n"));
});

test("tour text is complete, including sites and nested flow", () => {
	expect(outputs.get("tour")).toBe(
		[
			"tour for greet: 2 shown",
			"",
			"entrypoints",
			"    greet   function  src/model.ts:1-1",
			"    caller  function  src/model.ts:2-2",
			"",
			"src/model.ts",
			"  2  caller  reference",
			"  2  greet   reference",
			"",
			"primaryFlow",
			"  start: caller",
			"  steps",
			"    caller → greet  calls at model.ts:2",
			"",
			"nearby",
			"  caller",
			"  greet",
		].join("\n"),
	);
});

test("overview text is complete", () => {
	expect(outputs.get("overview")).toBe(
		[
			"overview: 0 shown",
			"",
			"src/model.ts",
			"  1-1  greet    function",
			"  2-2  caller   function",
			"  3-7  Greeter  class",
			"src/View.tsx",
			"  1-1  Row   type",
			"  2-6  View  function",
			"",
			`project: ${realpathSync(root)}`,
			"",
			"counts",
			"  files: 2",
			"  nodes: 9",
			"  edges: 13",
			"  byKind",
			"    interface: 1",
			"    type: 1",
			"    function: 3",
			"    method: 1",
			"    class: 1",
			"    file: 2",
			"",
			"layers",
			"  dir: src",
			"  files: 2",
			"  exported: 4",
			"",
			"hotspots",
			"  View",
			"  Row",
			"  caller",
			"  greet",
			"",
			"publicApi",
			"  View",
			"  caller",
			"  greet",
			"  Greeter",
		].join("\n"),
	);
});

test("TSX ranges use JSX parsing, which differs from TS parsing", async () => {
	const source = readFileSync(join(root, "src/View.tsx"), "utf8");
	const tsx = await parseDeclarations("View.tsx", source);
	const ts = await parseDeclarations("View.ts", source);
	expect(tsx.find(({ name }) => name === "View")?.end).toBe(6);
	expect(ts.find(({ name }) => name === "View")?.end).toBe(5);
	expect(outputs.get("overview")).toContain("2-6  View");
});

test("test sites use their line and kind in a file group, and file:line in sections", () => {
	const result: GraphResult = {
		type: "tour",
		shown: 1,
		nodes: [
			{
				handle: "src/long.ts#thing:function",
				name: "thing",
				kind: "function",
				file: "src/long.ts",
				ranges: [{ start: 12000, end: 12345 }],
			},
			{
				handle: "test/thing.test.ts#thing.test.ts:site:8-8",
				name: "thing.test.ts",
				file: "test/thing.test.ts",
				ranges: null,
				site: { start: 8, end: 8 },
			},
		],
		edges: [],
		sections: { tests: ["test/thing.test.ts#thing.test.ts:site:8-8"] },
	};
	expect(renderText(result, { color: false })).toBe(
		[
			"tour: 1 shown",
			"",
			"src/long.ts",
			"  12000-12345  thing  function",
			"test/thing.test.ts",
			"  8    test",
			"",
			"tests",
			"  thing.test.ts:8",
		].join("\n"),
	);
});
