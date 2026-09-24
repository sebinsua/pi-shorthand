import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatChanged, formatterFor } from "../src/runner/format.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "shorthand-format-"));
	roots.push(root);
	for (const [file, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), contents, { mode: 0o755 });
	}
	return root;
}

test("detects project JS tools and nearest package config, skipping ambiguity and missing tools", async () => {
	const root = await fixture({
		"package.json": JSON.stringify({ devDependencies: { prettier: "*", oxfmt: "*" } }),
		"node_modules/.bin/prettier": "#!/bin/sh\nexit 0\n",
		"node_modules/.bin/oxfmt": "#!/bin/sh\nexit 0\n",
		"packages/web/package.json": JSON.stringify({ scripts: { format: "prettier --write ." } }),
	});
	expect(formatterFor("src/a.ts", root)).toBeNull();
	expect(formatterFor("packages/web/a.ts", root)?.name).toBe("prettier");
	expect(formatterFor("packages/web/a.ts", root)?.cwd).toBe(join(root, "packages/web"));
	await rm(join(root, "node_modules/.bin/prettier"));
	expect(formatterFor("packages/web/a.ts", root)).toBeNull();
	expect(formatterFor("unknown.xyz", root)).toBeNull();
	await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { format: "oxfmt --config custom.json ." } }));
	expect(formatterFor("a.ts", root)).toBeNull();
});

test("detects Python tools from pyproject and a project virtualenv", async () => {
	const root = await fixture({
		"pyproject.toml": "[tool.ruff]\n",
		".venv/bin/ruff": "#!/bin/sh\nexit 0\n",
		".venv/bin/black": "#!/bin/sh\nexit 0\n",
	});
	expect(formatterFor("pkg/import.py", root)?.args).toEqual(["format"]);
	await writeFile(join(root, "pyproject.toml"), "[tool.black]\n");
	expect(formatterFor("pkg/import.py", root)?.name).toBe("black");
	await writeFile(join(root, "pyproject.toml"), "[tool.black]\n[tool.ruff]\n");
	expect(formatterFor("pkg/import.py", root)).toBeNull();
});

test("groups changed paths safely and reports formatter failures", async () => {
	const root = await fixture({
		"package.json": '{"scripts":{"format":"oxfmt"}}',
		"node_modules/.bin/oxfmt": `#!${process.execPath}\nawait Bun.write("arguments.json", JSON.stringify(process.argv.slice(2)));`,
	});
	const result = await formatChanged(["src/a b.ts", "src/$x.ts", "ignored.xyz"], root);
	expect(result.warnings).toEqual([]);
	expect(await Bun.file(join(root, "arguments.json")).json()).toEqual(["./src/a b.ts", "./src/$x.ts"]);
	await writeFile(join(root, "node_modules/.bin/oxfmt"), "#!/bin/sh\necho broken >&2\nexit 1\n");
	await chmod(join(root, "node_modules/.bin/oxfmt"), 0o755);
	expect((await formatChanged(["a.ts"], root)).warnings).toEqual(["oxfmt formatting failed: broken"]);
});

test("uses the installed oxfmt with project configuration on only the selected files", async () => {
	const root = await fixture({
		".oxfmtrc.json": '{"semi":false}',
		"a.ts": "const value={x:1};",
		"untouched.ts": "const other={x:2};",
	});
	await mkdir(join(root, "node_modules/.bin"), { recursive: true });
	await symlink(
		join(dirname(require.resolve("oxfmt/package.json")), "bin/oxfmt"),
		join(root, "node_modules/.bin/oxfmt"),
	);
	expect((await formatChanged(["a.ts"], root)).warnings).toEqual([]);
	expect(await Bun.file(join(root, "a.ts")).text()).toBe("const value = { x: 1 }\n");
	expect(await Bun.file(join(root, "untouched.ts")).text()).toBe("const other={x:2};");
});
