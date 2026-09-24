import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { Lang, parse } from "@ast-grep/napi";
import { file, move, moveDeclaration, remember } from "../placement.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "shorthand-move-imports-")));
	roots.push(root);
	const all = {
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				strict: true,
				module: "ESNext",
				moduleResolution: "bundler",
				noEmit: true,
				paths: { "@app/*": ["./src/*"] },
			},
			include: ["src"],
		}),
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

function declaration(root: string, path: string, pattern: string) {
	const absolute = join(root, path);
	const source = readFileSync(absolute, "utf8");
	const node = parse(Lang.TypeScript, source).root().find(pattern)!;
	expect(node).not.toBeNull();
	// The statement, including any `export` keyword around the declaration.
	const statement = node.parent()?.kind() === "export_statement" ? node.parent()! : node;
	return remember({ file: absolute, text: statement.text(), node: statement }, source);
}

/** Every source file under src, as a stand-in for Git's searches. */
const everyFile = (root: string) => {
	const all = () =>
		(readdirSync(join(root, "src"), { recursive: true }) as string[])
			.filter((path) => path.endsWith(".ts"))
			.map((path) => resolve(root, "src", path));
	return { mentioning: all, loadingModules: all };
};

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

async function typeCheck(root: string) {
	const tsc = resolve(import.meta.dir, "../node_modules/.bin/tsc");
	const result = await $`${tsc} -p ${join(root, "tsconfig.json")}`.nothrow().quiet();
	expect(result.stdout.toString() + result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
}

test("moving a declaration updates its dependencies, the source and every kind of importer", async () => {
	const root = project({
		"src/lib/util.ts": "export const helper = (n: number) => n + 1;\n",
		"src/types.ts": "export type Shape = { kind: string };\n",
		"src/a.ts": [
			'import { helper } from "./lib/util";',
			'import type { Shape } from "./types";',
			"const scale = 2;",
			"type Local = { n: number };",
			"export function moveMe(n: number, shape: Shape): Local {",
			"\treturn { n: helper(n) * scale + shape.kind.length };",
			"}",
			'export const other = moveMe(1, { kind: "x" });',
			"",
		].join("\n"),
		"src/b.ts": 'import { moveMe, other } from "./a";\nexport const b = moveMe(2, { kind: "b" }).n + other.n;\n',
		"src/c.ts": 'import { moveMe as m } from "./a";\nexport const c = m(3, { kind: "c" });\n',
		"src/d.ts": 'export { moveMe } from "./a";\n',
		"src/index.ts": 'export * from "./a";\n',
	});

	moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved/target.ts"), everyFile(root));

	expect(read(root, "src/moved/target.ts")).toBe(
		[
			'import { helper } from "../lib/util";',
			'import type { Shape } from "../types";',
			'import { scale, type Local } from "../a";',
			"export function moveMe(n: number, shape: Shape): Local {",
			"\treturn { n: helper(n) * scale + shape.kind.length };",
			"}",
			"",
		].join("\n"),
	);
	expect(read(root, "src/a.ts")).toContain('import { moveMe } from "./moved/target";');
	expect(read(root, "src/a.ts")).toContain("export const scale = 2;");
	expect(read(root, "src/a.ts")).toContain("export type Local = { n: number };");
	expect(read(root, "src/a.ts")).not.toContain("function moveMe");
	expect(read(root, "src/b.ts")).toBe(
		'import { other } from "./a";\nimport { moveMe } from "./moved/target";\nexport const b = moveMe(2, { kind: "b" }).n + other.n;\n',
	);
	expect(read(root, "src/c.ts")).toContain('import { moveMe as m } from "./moved/target";');
	expect(read(root, "src/c.ts")).not.toContain('from "./a"');
	expect(read(root, "src/d.ts")).toContain('export { moveMe } from "./moved/target";');
	expect(read(root, "src/d.ts")).not.toContain('from "./a"');
	expect(read(root, "src/index.ts")).toBe('export * from "./a";\nexport { moveMe } from "./moved/target";\n');
	await typeCheck(root);
});

test("new specifiers keep each file's .js style and quotes, and a moved type stays type-only", async () => {
	const root = project({
		"src/shapes.ts": "export interface Shape { kind: string }\nexport const unit = 1;\n",
		"src/use.ts": "import type { Shape } from './shapes.js';\nexport const s: Shape = { kind: 'x' };\n",
		"src/target.ts": "import { unit } from './shapes.js';\nexport const u = unit;\n",
	});

	moveDeclaration(join(root, "src/shapes.ts"), "Shape", join(root, "src/target.ts"), everyFile(root));

	expect(read(root, "src/use.ts")).toBe(
		"import type { Shape } from './target.js';\nexport const s: Shape = { kind: 'x' };\n",
	);
	expect(read(root, "src/target.ts")).toContain("export interface Shape { kind: string }");
	expect(read(root, "src/shapes.ts").trim()).toBe("export const unit = 1;");
	await typeCheck(root);
});

test("a declaration the target already imports from the source becomes local there", async () => {
	const root = project({
		"src/a.ts": "export const limit = 3;\nexport const other = 1;\n",
		"src/target.ts": 'import { limit, other } from "./a";\nexport const both = () => limit + other;\n',
	});

	moveDeclaration(join(root, "src/a.ts"), "limit", join(root, "src/target.ts"), everyFile(root));

	expect(read(root, "src/target.ts")).toBe(
		'import { other } from "./a";\nexport const both = () => limit + other;\nexport const limit = 3;\n',
	);
	await typeCheck(root);
});

test.each([
	["a default export", { "src/a.ts": "export default function moveMe() {}\n" }, "moveMe", "default export"],
	[
		"overloads",
		{ "src/a.ts": "export function moveMe(a: string): string;\nexport function moveMe(a: string) { return a; }\n" },
		"moveMe",
		"overloads or merged declarations",
	],
	["a local export list", { "src/a.ts": "function moveMe() {}\nexport { moveMe };\n" }, "moveMe", "export list"],
	[
		"a namespace import that uses it",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'import * as a from "./a";\na.moveMe();\n',
		},
		"moveMe",
		"namespace import",
	],
	[
		"a dynamic import of the source",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'export const lazy = () => import("./a").then((a) => a.moveMe);\n',
		},
		"moveMe",
		"import()",
	],
	[
		"a namespace re-export of the source",
		{ "src/a.ts": "export function moveMe() {}\n", "src/b.ts": 'export * as a from "./a";\n' },
		"moveMe",
		"as a namespace",
	],
	[
		"a dynamic import in a file that never names it",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'export const load = () => import("./a");\n',
		},
		"moveMe",
		"import()",
	],
	[
		"a target with its own declaration of that name",
		{ "src/a.ts": "export function moveMe() {}\n", "src/target.ts": "export const moveMe = 1;\n" },
		"moveMe",
		"already declares moveMe",
	],
	[
		"a global the target shadows",
		{ "src/a.ts": "export const read = () => fetch;\n", "src/target.ts": "export const fetch = 1;\n" },
		"read",
		"fetch is a global",
	],
])("refuses %s before writing anything", (_, files, symbol, message) => {
	const root = project({ "src/target.ts": "export {};\n", ...files });
	const before = Object.fromEntries(Object.keys(files).map((path) => [path, read(root, path)]));
	const targetBefore = read(root, "src/target.ts");
	expect(() => moveDeclaration(join(root, "src/a.ts"), symbol, join(root, "src/target.ts"), everyFile(root))).toThrow(
		message,
	);
	for (const [path, text] of Object.entries(before)) expect(read(root, path)).toBe(text);
	expect(read(root, "src/target.ts")).toBe(targetBefore);
});

test("importers through a tsconfig path alias keep using the alias", async () => {
	const root = project({
		"src/api.ts": "export function parseUser(name: string) { return { name }; }\n",
		"src/app.ts": 'import { parseUser } from "@app/api";\nexport const user = parseUser("Ada");\n',
	});

	moveDeclaration(join(root, "src/api.ts"), "parseUser", join(root, "src/users/parse.ts"), everyFile(root));

	expect(read(root, "src/app.ts")).toBe(
		'import { parseUser } from "@app/users/parse";\nexport const user = parseUser("Ada");\n',
	);
	await typeCheck(root);
});

test("a declaration the source still uses is exported from the target", async () => {
	const root = project({ "src/a.ts": "const limit = 3;\nexport const twice = limit * 2;\n" });

	moveDeclaration(join(root, "src/a.ts"), "limit", join(root, "src/limits.ts"), everyFile(root));

	expect(read(root, "src/limits.ts")).toBe("export const limit = 3;\n");
	expect(read(root, "src/a.ts")).toContain('import { limit } from "./limits";');
	await typeCheck(root);
});

test("a nested local that shares an import's name does not hide the import's other uses", async () => {
	const root = project({
		"src/util.ts": "export const helper = (n: number) => n + 1;\n",
		"src/a.ts":
			'import { helper } from "./util";\nexport function run(n: number) {\n\tconst inner = () => { const helper = 0; return helper; };\n\treturn helper(n) + inner();\n}\n',
	});

	moveDeclaration(join(root, "src/a.ts"), "run", join(root, "src/run.ts"), everyFile(root));

	expect(read(root, "src/run.ts")).toStartWith('import { helper } from "./util";\n');
	await typeCheck(root);
});

test("sg.move places syntax without changing imports", () => {
	const root = project({
		"src/a.ts": 'import { x } from "./x";\nexport function f() { return x; }\n',
		"src/b.ts": 'import { f } from "./a";\nf();\n',
		"src/x.ts": "export const x = 1;\n",
	});
	move(declaration(root, "src/a.ts", "function f() { return x; }"), { endOf: file(join(root, "src/moved.ts")) });
	expect(read(root, "src/moved.ts")).toBe("export function f() { return x; }\n");
	expect(read(root, "src/b.ts")).toBe('import { f } from "./a";\nf();\n');
});

test("a declaration must exist once at the top level", () => {
	const root = project({ "src/a.ts": "export function f() {}\nfunction g() { const h = 1; }\n" });
	expect(() => moveDeclaration(join(root, "src/a.ts"), "h", join(root, "src/b.ts"), everyFile(root))).toThrow(
		"found no top-level declaration of h",
	);
});
