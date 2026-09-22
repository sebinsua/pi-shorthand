import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { rename, renameFile } from "../typescript-refactors.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-typescript-"));
	roots.push(root);
	for (const [file, source] of Object.entries(files)) await Bun.write(path.join(root, file), source);
	return root;
}

test("rename changes one resolved symbol across files", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/parse.ts": 'export const mascot = "😀";\r\nexport function parseUser(value: string) { return value; }\r\n',
		"src/use.ts":
			'import { parseUser } from "./parse";\nexport const api = { parseUser };\nexport const result = parseUser("Ada");\n',
		"src/other.ts": 'function parseUser() { return "unrelated"; }\nexport const text = "parseUser";\n',
	});

	await rename(root, { file: "src/parse.ts", symbol: "parseUser", to: "decodeUser" });

	expect(await Bun.file(path.join(root, "src/parse.ts")).text()).toBe(
		'export const mascot = "😀";\r\nexport function decodeUser(value: string) { return value; }\r\n',
	);
	expect(await Bun.file(path.join(root, "src/use.ts")).text()).toBe(
		'import { decodeUser } from "./parse";\nexport const api = { parseUser: decodeUser };\nexport const result = decodeUser("Ada");\n',
	);
	expect(await Bun.file(path.join(root, "src/other.ts")).text()).toBe(
		'function parseUser() { return "unrelated"; }\nexport const text = "parseUser";\n',
	);
});

test("rename rejects overloaded declarations without writing", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ include: ["src"] }),
		"src/format.ts":
			"export function format(value: string): string;\nexport function format(value: number): number;\nexport function format(value: string | number) { return value; }\n",
		"src/use.ts": 'import { format } from "./format";\nexport const result = format(1);\n',
	});

	await expect(rename(root, { file: "src/format.ts", symbol: "format", to: "render" })).rejects.toThrow(
		"found more than one declaration",
	);
	expect(await Bun.file(path.join(root, "src/format.ts")).text()).toContain("function format");
	expect(await Bun.file(path.join(root, "src/use.ts")).text()).toContain("format(1)");
});

test.each([
	["missing", "found no declaration"],
	["value", "found more than one declaration"],
])("rename rejects %s declarations without writing", async (symbol, message) => {
	const source = "export const value = 1;\nexport function outer() { const value = 2; return value; }\n";
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/app.ts": source,
	});
	await expect(rename(root, { file: "src/app.ts", symbol, to: "next" })).rejects.toThrow(message);
	expect(await Bun.file(path.join(root, "src/app.ts")).text()).toBe(source);
});

test("renameFile moves a file and updates resolved module paths", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/shared/types.ts": "export interface User { name: string }\n",
		"src/parse-user.ts":
			'import type { User } from "./shared/types";\nexport function parseUser(name: string): User { return { name }; }\n',
		"src/index.ts": 'export { parseUser } from "./parse-user";\n',
		"src/app.ts": 'import { parseUser } from "./parse-user";\nexport const user = parseUser("Ada");\n',
	});

	await renameFile(root, { from: "src/parse-user.ts", to: "src/users/parse-user.ts" });

	expect(await Bun.file(path.join(root, "src/parse-user.ts")).exists()).toBe(false);
	expect(await Bun.file(path.join(root, "src/users/parse-user.ts")).text()).toBe(
		'import type { User } from "../shared/types";\nexport function parseUser(name: string): User { return { name }; }\n',
	);
	expect(await Bun.file(path.join(root, "src/index.ts")).text()).toBe(
		'export { parseUser } from "./users/parse-user";\n',
	);
	expect(await Bun.file(path.join(root, "src/app.ts")).text()).toBe(
		'import { parseUser } from "./users/parse-user";\nexport const user = parseUser("Ada");\n',
	);
});

test("renameFile rejects an existing destination without writing", async () => {
	const root = await fixture({
		"src/old.ts": "export const old = true;\n",
		"src/new.ts": "export const existing = true;\n",
	});
	await expect(renameFile(root, { from: "src/old.ts", to: "src/new.ts" })).rejects.toThrow(
		"destination already exists",
	);
	expect(await Bun.file(path.join(root, "src/old.ts")).text()).toContain("old = true");
	expect(await Bun.file(path.join(root, "src/new.ts")).text()).toContain("existing = true");
});

test("renameFile rejects a destination outside the project", async () => {
	const root = await fixture({ "src/old.ts": "export const old = true;\n" });
	await expect(renameFile(root, { from: "src/old.ts", to: "../outside.ts" })).rejects.toThrow("outside the repository");
	expect(await Bun.file(path.join(root, "src/old.ts")).exists()).toBe(true);
});
