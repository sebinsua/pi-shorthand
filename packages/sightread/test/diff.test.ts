// Exercise complete diff output against disposable nested Git and TypeScript projects.
import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDiff } from "../src/diff/index.ts";
import { renderDiffText } from "../src/diff/render.ts";
import { connect, stopAllServers, stopServer } from "../src/server/client.ts";

const originalRuntime = process.env.XDG_RUNTIME_DIR;
// A short, resolved temporary root: macOS links /tmp to /private/tmp, and socket paths have a length limit.
const temporaryRoot = realpathSync("/tmp");
const runtime = mkdtempSync(join(temporaryRoot, "sightread-diff-runtime-"));
process.env.XDG_RUNTIME_DIR = runtime;
const fixtures: Array<{ repo: string; root: string }> = [];
const tsx = readFileSync(new URL("./item-list.tsx.txt", import.meta.url), "utf8");

function git(repo: string, ...args: string[]) {
	return execFileSync("git", ["-c", "core.quotePath=false", "-c", "commit.gpgsign=false", ...args], {
		cwd: repo,
		encoding: "utf8",
	}).trim();
}

function fixture(initial: Record<string, string>) {
	const repo = mkdtempSync(join(temporaryRoot, "sightread-diff-repo-"));
	const root = join(repo, "client");
	mkdirSync(root, { recursive: true });
	const put = (name: string, contents: string) => {
		const file = join(repo, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	};
	put("client/tsconfig.json", '{"compilerOptions":{"jsx":"preserve"},"include":["**/*"]}\n');
	put("client/.gitignore", "node_modules/\n");
	for (const [name, contents] of Object.entries(initial)) put(name, contents);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "sightread@example.test");
	git(repo, "config", "user.name", "Sightread Test");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	fixtures.push({ repo, root });
	const project = { root, tsconfig: join(root, "tsconfig.json") };
	return {
		repo,
		root,
		project,
		put,
		sha: git(repo, "rev-parse", "HEAD"),
		run: (json = false) => runDiff(project, "HEAD", { json, color: false }),
	};
}

afterEach(async () => {
	for (const { repo, root } of fixtures.splice(0)) {
		await stopServer({ root, tsconfig: join(root, "tsconfig.json") });
		rmSync(repo, { recursive: true, force: true });
	}
});

afterAll(async () => {
	await stopAllServers();
	rmSync(runtime, { recursive: true, force: true });
	if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalRuntime;
});

test("an untracked realistic TSX component retains its entire range and new-file heading", async () => {
	const f = fixture({ "client/src/stable.ts": "export const stable = 1;\n" });
	f.put("client/src/ItemList.tsx", tsx);
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 4 changed, 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/ItemList.tsx  (new file)",
			"    3-3  Item      type      added",
			"   5-25  ItemList  function  added",
			"  27-27  Empty     variable  added",
			"  29-31  after     function  added",
		].join("\n"),
	);
}, 30_000);

test("no changes prints the complete empty result", async () => {
	const f = fixture({ "client/src/View.tsx": tsx });
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 0 changed, 0 callers, 0 test files\n\n(no changes)`,
	);
}, 30_000);

test("deleted function finds a live caller by name", async () => {
	const f = fixture({
		"client/src/api.ts": "export function removed() { return 1; }\n",
		"client/src/use.ts": "import { removed } from './api';\nexport function use() { return removed(); }\n",
	});
	f.put("client/src/api.ts", "\n");
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 1 callers, 0 test files`,
			"",
			"changed",
			"client/src/api.ts",
			"  1-1  removed  function  deleted (base lines)",
			"",
			"callers",
			"client/src/use.ts",
			"  2-2  use  function",
			"",
			"chains",
			"  use -by_name→ removed  (by name)",
		].join("\n"),
	);
}, 30_000);

test("a pure deletion inside a method selects the method", async () => {
	const f = fixture({
		"client/src/box.ts": "export class Box {\n\tvalue() {\n\t\tconst a = 1;\n\t\tconst b = 2;\n\t\treturn a;\n\t}\n}\n",
	});
	f.put("client/src/box.ts", "export class Box {\n\tvalue() {\n\t\tconst a = 1;\n\t\treturn a;\n\t}\n}\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 0 test files\n\nchanged\nclient/src/box.ts\n  2-5  Box.value  method  edited`,
	);
}, 30_000);

test("edited TSX parses the base with its real extension", async () => {
	const f = fixture({ "client/src/ItemList.tsx": tsx });
	f.put("client/src/ItemList.tsx", tsx.replace("No items", "Nothing here"));
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 0 test files\n\nchanged\nclient/src/ItemList.tsx\n  5-25  ItemList  function  edited`,
	);
}, 30_000);

test("spaces, mts, cts, and changed files outside the project have rooted paths", async () => {
	const f = fixture({ "sibling/readme.md": "before\n" });
	f.put("client/src/with space.mts", "export function spaced() { return 1; }\n");
	f.put("client/src/other.cts", "export function other() { return 2; }\n");
	f.put("sibling/readme.md", "after\n");
	f.put("client/public/regions.json", "{}\n");
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 2 changed, 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/other.cts  (new file)",
			"  1-1  other  function  added",
			"client/src/with space.mts  (new file)",
			"  1-1  spaced  function  added",
			"",
			"notes",
			"  1 non-TypeScript file changed: client/public/regions.json",
			"  1 file changed outside the project: sibling/readme.md",
		].join("\n"),
	);
}, 30_000);

test("a rename labels the file and emits one note", async () => {
	const f = fixture({
		"client/src/old.ts": "export function renamed() {\n\tconst value = 1;\n\treturn value + 1;\n}\n",
	});
	git(f.repo, "mv", "client/src/old.ts", "client/src/new.ts");
	f.put("client/src/new.ts", "export function renamed() {\n\tconst value = 1;\n\treturn value + 2;\n}\n");
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/new.ts  (renamed from client/src/old.ts)",
			"  1-4  renamed  function  moved (from client/src/old.ts)",
			"",
			"notes",
			"  client/src/old.ts → client/src/new.ts: file rename",
		].join("\n"),
	);
}, 30_000);

test("a pure rename marks its declaration moved and finds old-path importers", async () => {
	const f = fixture({
		"client/src/api.ts": "export function target() { return 1; }\n",
		"client/src/use.ts": "import { target } from './api';\nexport function use() { return target(); }\n",
		"client/src/fresh.ts": "import { target } from './new';\nexport function fresh() { return target(); }\n",
		"client/src/View.tsx": tsx,
	});
	git(f.repo, "mv", "client/src/api.ts", "client/src/new.ts");
	const value = JSON.parse(await f.run(true));
	expect(value.changed).toEqual([
		{
			handle: "client/src/new.ts#target:function",
			name: "target",
			kind: "function",
			file: "client/src/new.ts",
			ranges: [{ start: 1, end: 1 }],
			status: "moved",
			oldPath: "client/src/api.ts",
		},
	]);
	expect(value.callers.map((node: { name: string }) => node.name)).toEqual(["fresh", "use"]);
	expect(
		value.chains.some(
			(chain: { byName?: boolean; handles: string[] }) =>
				chain.byName && chain.handles[0] === "client/src/use.ts#use:function",
		),
	).toBe(true);
	expect(
		value.chains.some(
			(chain: { byName?: boolean; handles: string[] }) =>
				!chain.byName && chain.handles[0] === "client/src/fresh.ts#fresh:function",
		),
	).toBe(true);
	expect(await f.run()).toContain("moved (from client/src/api.ts)");
}, 30_000);

test("a symlinked project root maps changed paths inside the project", async () => {
	const f = fixture({ "client/src/api.ts": "export function target() { return 1; }\n", "client/src/View.tsx": tsx });
	f.put("client/src/api.ts", "export function target() { return 2; }\n");
	const link = join(f.repo, "linked-client");
	symlinkSync(f.root, link, "dir");
	const output = await runDiff({ root: link, tsconfig: join(link, "tsconfig.json") }, "HEAD", {
		json: true,
		color: false,
	});
	const value = JSON.parse(output);
	expect(value.project).toBe("client");
	expect(value.changed.map((node: { handle: string }) => node.handle)).toEqual(["client/src/api.ts#target:function"]);
}, 30_000);

test("deleted symbol finds a caller through a tsconfig path alias", async () => {
	const f = fixture({
		"client/src/api.ts": "export function target() { return 1; }\n",
		"client/src/use.ts": "import { target } from '@api';\nexport function use() { return target(); }\n",
		"client/src/View.tsx": tsx,
		"client/tsconfig.base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@api":["src/api.ts"]}}}\n',
	});
	f.put(
		"client/tsconfig.json",
		'{"extends":"./tsconfig.base.json","compilerOptions":{"jsx":"preserve"},"include":["**/*"]}\n',
	);
	f.put("client/src/api.ts", "\n");
	const value = JSON.parse(await f.run(true));
	expect(value.callers.map((node: { name: string }) => node.name)).toEqual(["use"]);
	expect(value.chains[0].byName).toBe(true);
}, 30_000);

test("a dollar sign in a deleted name is searched literally", async () => {
	const f = fixture({
		"client/src/api.ts": "export function make$() { return 1; }\n",
		"client/src/use.ts": "import { make$ } from './api';\nexport function use() { return make$(); }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/api.ts", "\n");
	const value = JSON.parse(await f.run(true));
	expect(value.changed[0].name).toBe("make$");
	expect(value.callers.map((node: { name: string }) => node.name)).toEqual(["use"]);
}, 30_000);

test("a tab in a tracked filename survives NUL-delimited git paths", async () => {
	const f = fixture({ "client/src/a\tb.ts": "export function target() { return 1; }\n", "client/src/View.tsx": tsx });
	f.put("client/src/a\tb.ts", "export function target() { return 2; }\n");
	const value = JSON.parse(await f.run(true));
	expect(value.changed.map((node: { file: string }) => node.file)).toEqual(["client/src/a\tb.ts"]);
}, 30_000);

test("default base reports when no other branch exists and explicit HEAD works", async () => {
	const f = fixture({ "client/src/View.tsx": tsx });
	await expect(runDiff(f.project, undefined, { json: false, color: false })).rejects.toThrow(
		"no default branch found; pass diff [base]",
	);
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 0 changed, 0 callers, 0 test files\n\n(no changes)`,
	);
}, 30_000);

test("reuses a fresh daemon and refreshes after a same-line source edit", async () => {
	const f = fixture({
		"client/src/api.ts": "export function target() { return 1; }\n",
		"client/src/api.test.ts": "import { target } from './api';\nexport function check() { return 1; }\n",
	});
	f.put("client/src/api.ts", "export function target() { return 2; }\n");
	const first = await f.run();
	expect(first).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 0 test files\n\nchanged\nclient/src/api.ts\n  1-1  target  function  edited`,
	);
	const one = await connect(f.project);
	expect(await f.run()).toBe(first);
	expect((await connect(f.project)).pid).toBe(one.pid);
	f.put("client/src/api.test.ts", "import { target } from './api';\nexport function check() { return target(); }\n");
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 2 changed, 0 callers, 1 test file`,
			"",
			"changed",
			"client/src/api.ts",
			"  1-1  target  function  edited",
			"client/src/api.test.ts",
			"  2-2  check  function  edited",
			"",
			"tests",
			"client/src/api.test.ts",
			"  2  target  test",
		].join("\n"),
	);
	expect((await connect(f.project)).pid).not.toBe(one.pid);
}, 30_000);

test("edited overloads and merged interfaces each keep every range", async () => {
	const base =
		[
			"export function call(x: string): string;",
			"export function call(x: number): number;",
			"export function call(x: string | number) { return x; }",
			"export interface Item {",
			"\ta: string;",
			"}",
			"export interface Item {",
			"\tb: number;",
			"}",
		].join("\n") + "\n";
	const f = fixture({ "client/src/types.ts": base });
	f.put(
		"client/src/types.ts",
		base
			.replace("return x;", "return String(x);")
			.replace("export interface Item {\n\tb", "export interface Item { // expanded\n\tb"),
	);
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 2 changed, 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/types.ts",
			"  1-1, 2-2, 3-3  call  function   edited",
			"       4-6, 7-9  Item  interface  edited",
		].join("\n"),
	);
}, 30_000);

test("insert, method edit, import note, and removal render once and match full JSON", async () => {
	const f = fixture({
		"client/src/a.ts":
			"import { thing } from './dep';\nexport function old() { return 1; }\nexport class Row {\n\tget() { return 1; }\n}\n",
		"client/src/dep.ts": "export const thing = 1;\nexport const other = 2;\n",
	});
	f.put(
		"client/src/a.ts",
		"import { other } from './dep';\nexport class Row {\n\tget() { return 2; }\n}\nexport function added() { return 3; }\n",
	);
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 3 changed, 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/a.ts",
			"  2-2  old      function  deleted (base lines)",
			"  3-3  Row.get  method    edited",
			"  5-5  added    function  added",
			"",
			"notes",
			"  client/src/a.ts: imports changed",
		].join("\n"),
	);
	expect(JSON.parse(await f.run(true))).toEqual({
		base: f.sha,
		project: "client",
		tsconfig: "tsconfig.json",
		changed: [
			{
				handle: "client/src/a.ts#old:function",
				name: "old",
				kind: "function",
				file: "client/src/a.ts",
				ranges: [{ start: 2, end: 2 }],
				status: "deleted",
				baseRanges: [{ start: 2, end: 2 }],
			},
			{
				handle: "client/src/a.ts#Row.get:method",
				name: "Row.get",
				kind: "method",
				file: "client/src/a.ts",
				ranges: [{ start: 3, end: 3 }],
				status: "edited",
			},
			{
				handle: "client/src/a.ts#added:function",
				name: "added",
				kind: "function",
				file: "client/src/a.ts",
				ranges: [{ start: 5, end: 5 }],
				status: "added",
			},
		],
		callers: [],
		chains: [],
		tests: [],
		notes: ["client/src/a.ts: imports changed"],
	});
}, 30_000);

test("a direct test call appears under tests", async () => {
	const f = fixture({
		"client/src/api.ts": "export function target() { return 1; }\n",
		"client/src/api.test.ts": "import { target } from './api';\nexport function testTarget() { return target(); }\n",
	});
	f.put("client/src/api.ts", "export function target() { return 2; }\n");
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 1 test file`,
			"",
			"changed",
			"client/src/api.ts",
			"  1-1  target  function  edited",
			"",
			"tests",
			"client/src/api.test.ts",
			"  2  target  test",
		].join("\n"),
	);
}, 30_000);

test("30-symbol cap orders production symbols before test-file symbols", async () => {
	const f = fixture({});
	f.put(
		"client/src/z.ts",
		Array.from({ length: 30 }, (_, index) => `export const p${String(index).padStart(2, "0")} = ${index};`).join("\n") +
			"\n",
	);
	f.put("client/src/a.test.ts", "export const testItem = 1;\n");
	const rows = Array.from(
		{ length: 30 },
		(_, index) => `  ${`${index + 1}-${index + 1}`.padStart(5)}  p${String(index).padStart(2, "0")}  variable  added`,
	);
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 31 changed (30 analysed), 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/z.ts  (new file)",
			...rows,
			"",
			"notes",
			"  1 omitted (cap 30): 1 added",
		].join("\n"),
	);
}, 30_000);

test("deleted locals do not search unrelated files or appear as changes", async () => {
	const f = fixture({
		"client/src/api.ts": "export function removed() {\n\tconst result = 1;\n\treturn result;\n}\n",
		"client/src/other.ts": "export function unrelated() { const result = 2; return result; }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/api.ts", "\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 0 test files\n\nchanged\nclient/src/api.ts\n  1-4  removed  function  deleted (base lines)`,
	);
}, 30_000);

test("a deleted module-level function finds only an importing caller and a same-file caller", async () => {
	const f = fixture({
		"client/src/api.ts": "export function removed() { return 1; }\nexport function own() { return removed(); }\n",
		"client/src/use.ts": "import { removed } from './api.js';\nexport function use() { return removed(); }\n",
		"client/src/decoy.ts": "export function decoy() { return removed(); }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/api.ts", "export function own() { return removed(); }\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 2 callers, 0 test files\n\nchanged\nclient/src/api.ts\n  1-1  removed  function  deleted (base lines)\n\ncallers\nclient/src/api.ts\n  1-1  own  function\nclient/src/use.ts\n  2-2  use  function\n\nchains\n  own -by_name→ removed  (by name)\n  use -by_name→ removed  (by name)`,
	);
}, 30_000);

test("an edited local marks its enclosing function", async () => {
	const f = fixture({
		"client/src/api.ts": "export function calculate() {\n\tconst result = 1;\n\treturn result;\n}\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/api.ts", "export function calculate() {\n\tconst result = 2;\n\treturn result;\n}\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 0 test files\n\nchanged\nclient/src/api.ts\n  1-4  calculate  function  edited`,
	);
}, 30_000);

test("test callback calls are found by name through a relative import", async () => {
	const f = fixture({
		"client/src/api/index.ts": "export function target() { return 1; }\n",
		"client/src/api.test.ts":
			"import { test } from 'bun:test';\nimport { target } from './api';\ntest('target', () => {\n\ttarget();\n});\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/api/index.ts", "export function target() { return 2; }\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 0 callers, 1 test file\n\nchanged\nclient/src/api/index.ts\n  1-1  target  function  edited\n\ntests\nclient/src/api.test.ts\n  4  target  test  (by name)`,
	);
	expect(JSON.parse(await f.run(true)).tests).toEqual([
		{
			handle: "client/src/api.test.ts#target:site:4-4",
			name: "target",
			file: "client/src/api.test.ts",
			ranges: null,
			site: { start: 4, end: 4 },
			byName: true,
		},
	]);
}, 30_000);

test("a longer caller chain removes its contiguous tail", async () => {
	const f = fixture({
		"client/src/api.ts": "export function target() { return 1; }\n",
		"client/src/middle.ts": "import { target } from './api';\nexport function middle() { return target(); }\n",
		"client/src/outer.ts": "import { middle } from './middle';\nexport function outer() { return middle(); }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/api.ts", "export function target() { return 2; }\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 2 callers, 0 test files\n\nchanged\nclient/src/api.ts\n  1-1  target  function  edited\n\ncallers\nclient/src/middle.ts\n  2-2  middle  function\nclient/src/outer.ts\n  2-2  outer  function\n\nchains\n  outer → middle → target`,
	);
}, 30_000);

test("the cap selects edited production code before added symbols", async () => {
	const f = fixture({
		"client/src/z.ts": "export function edited() { return 1; }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/z.ts", "export function edited() { return 2; }\n");
	f.put(
		"client/src/a.ts",
		Array.from({ length: 30 }, (_, index) => `export const a${index} = ${index};`).join("\n") + "\n",
	);
	expect(await f.run()).toBe(
		[
			`diff ${f.sha.slice(0, 12)} → working tree (client): 31 changed (30 analysed), 0 callers, 0 test files`,
			"",
			"changed",
			"client/src/z.ts",
			"  1-1  edited  function  edited",
			"client/src/a.ts  (new file)",
			...Array.from(
				{ length: 29 },
				(_, index) =>
					`  ${`${index + 1}-${index + 1}`.padStart(5)}  a${index}${index < 10 ? " " : ""}  variable  added`,
			),
			"",
			"notes",
			"  1 omitted (cap 30): 1 added",
		].join("\n"),
	);
}, 30_000);

test("type reference hops are labelled in complete text and JSON chains", async () => {
	const f = fixture({
		"client/src/model.ts": "export interface ChangedSymbol { value: number }\n",
		"client/src/impact.ts":
			"import type { ChangedSymbol } from './model';\nexport interface Impact { changed: ChangedSymbol[] }\nexport function collectImpact(): Impact { return { changed: [] }; }\nexport function runDiff() { return collectImpact(); }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/model.ts", "export interface ChangedSymbol { value: string }\n");
	const output = await f.run();
	expect(output).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 4 callers, 0 test files\n\nchanged\nclient/src/model.ts\n  1-1  ChangedSymbol  interface  edited\n\ncallers\nclient/src/impact.ts\n  2-2  Impact          interface\n  2-2  Impact.changed  variable\n  3-3  collectImpact   function\n  4-4  runDiff         function\n\nchains\n  runDiff → collectImpact -type_ref→ Impact -type_ref→ ChangedSymbol\n  Impact.changed -type_ref→ ChangedSymbol`,
	);
	expect(JSON.parse(await f.run(true)).chains).toEqual([
		{
			handles: [
				"client/src/impact.ts#runDiff:function",
				"client/src/impact.ts#collectImpact:function",
				"client/src/impact.ts#Impact:interface",
				"client/src/model.ts#ChangedSymbol:interface",
			],
			hops: [
				{
					from: "client/src/impact.ts#runDiff:function",
					to: "client/src/impact.ts#collectImpact:function",
					kind: "calls",
				},
				{
					from: "client/src/impact.ts#collectImpact:function",
					to: "client/src/impact.ts#Impact:interface",
					kind: "type_ref",
				},
				{
					from: "client/src/impact.ts#Impact:interface",
					to: "client/src/model.ts#ChangedSymbol:interface",
					kind: "type_ref",
				},
			],
		},
		{
			handles: ["client/src/impact.ts#Impact.changed:variable", "client/src/model.ts#ChangedSymbol:interface"],
			hops: [
				{
					from: "client/src/impact.ts#Impact.changed:variable",
					to: "client/src/model.ts#ChangedSymbol:interface",
					kind: "type_ref",
				},
			],
		},
	]);
}, 30_000);

test("added and deleted containers stand for their members", async () => {
	const f = fixture({
		"client/src/old.ts":
			"export class Old {\n\tmethod() { return 1; }\n}\nexport interface Gone {\n\tvalue: number;\n}\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/old.ts", "\n");
	f.put(
		"client/src/new.ts",
		"export class New {\n\tmethod() { return 1; }\n}\nexport interface Fresh {\n\tvalue: number;\n}\n",
	);
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 4 changed, 0 callers, 0 test files\n\nchanged\nclient/src/old.ts\n  1-3  Old   class      deleted (base lines)\n  4-6  Gone  interface  deleted (base lines)\nclient/src/new.ts  (new file)\n  1-3  New    class      added\n  4-6  Fresh  interface  added`,
	);
}, 30_000);

test("repeated notes coalesce and appear in a fixed order", () => {
	const notes = [
		"a.md: not TypeScript",
		"b.md: not TypeScript",
		"c.md: not TypeScript",
		"d.md: not TypeScript",
		"z.ts: imports changed",
		"y.ts: imports changed",
		"x.ts: imports changed",
		"w.ts: imports changed",
		"A: impact truncated at 16 callers; reverse trace used",
		"B: impact truncated at 16 callers; reverse trace used",
		"C: impact truncated at 16 callers; reverse trace used",
		"D: impact truncated at 16 callers; reverse trace used",
		"E: impact truncated at 16 callers; reverse trace used",
		"F: impact truncated at 16 callers; reverse trace used",
		"3 omitted (cap 30): 3 added",
		"client/src/out.ts: outside project",
	];
	expect(
		renderDiffText(
			{ base: "123456789012", project: "client", changed: [], callers: [], chains: [], tests: [], notes },
			new Map(),
			false,
		),
	).toBe(
		"diff 123456789012 → working tree (client): 0 changed, 0 callers, 0 test files\n\nnotes\n  3 omitted (cap 30): 3 added\n  impact truncated for 6 symbols (A, B, C, D, E, …); reverse trace used\n  4 imports changed: w.ts, x.ts, y.ts, … (1 more)\n  4 non-TypeScript files changed: a.md, b.md, c.md, … (1 more)\n  1 file changed outside the project: client/src/out.ts",
	);
});

test("changed declarations outside the graphed config are coalesced", async () => {
	const f = fixture({
		"client/src/api.ts": "export function included() { return 1; }\n",
		"client/src/node/__tests__/fixtures/with space/main.ts": "export function main() { return 1; }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/tsconfig.json", '{"compilerOptions":{"jsx":"preserve"},"include":["src/api.ts","src/View.tsx"]}\n');
	git(f.repo, "add", "client/tsconfig.json");
	git(f.repo, "commit", "-qm", "restrict project");
	f.put("client/src/node/__tests__/fixtures/with space/main.ts", "export function main() { return 2; }\n");
	expect(await f.run()).toBe(
		`diff ${git(f.repo, "rev-parse", "HEAD").slice(0, 12)} → working tree (client): 0 changed, 0 callers, 0 test files\n\nnotes\n  1 changed declarations outside the graphed project (tsconfig.json)`,
	);
}, 30_000);

test("a graph handle with spaces round-trips to its caller", async () => {
	const f = fixture({
		"client/src/with space/api.ts": "export function target() { return 1; }\n",
		"client/src/use.ts": "import { target } from './with space/api';\nexport function use() { return target(); }\n",
		"client/src/View.tsx": tsx,
	});
	f.put("client/src/with space/api.ts", "export function target() { return 2; }\n");
	expect(await f.run()).toBe(
		`diff ${f.sha.slice(0, 12)} → working tree (client): 1 changed, 1 callers, 0 test files\n\nchanged\nclient/src/with space/api.ts\n  1-1  target  function  edited\n\ncallers\nclient/src/use.ts\n  2-2  use  function\n\nchains\n  use → target`,
	);
}, 30_000);

const testSite = (file: string, line: number) => ({
	handle: `${file}#target:site:${line}-${line}`,
	name: "target",
	file,
	ranges: null,
	site: { start: line, end: line },
	byName: true as const,
});

test("uses of one name across a test file render as one row of line runs", () => {
	const tests = [
		...[4, 5, 6, 9, 12, 13].map((line) => testSite("client/src/api.test.ts", line)),
		testSite("client/src/other.test.ts", 7),
	];
	expect(
		renderDiffText(
			{ base: "123456789012", project: "client", changed: [], callers: [], chains: [], tests, notes: [] },
			new Map(),
			false,
		),
	).toBe(
		"diff 123456789012 → working tree (client): 0 changed, 0 callers, 2 test files\n\ntests\nclient/src/api.test.ts\n  4-6, 9-9, 12-13  target  test  (by name)\nclient/src/other.test.ts\n  7  target  test  (by name)",
	);
});
