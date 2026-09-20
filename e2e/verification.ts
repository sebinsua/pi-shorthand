import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";

/** Compile evaluator-owned type assertions without depending on the candidate's tsconfig. */
export async function assertTypes(program: string): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), "shorthand-type-check-"));
	try {
		await writeFile(path.join(directory, "check.ts"), program);
		await writeFile(
			path.join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "bundler",
					allowImportingTsExtensions: true,
					types: [],
				},
				files: ["check.ts"],
			}),
		);
		const tsc = path.resolve(import.meta.dir, "../node_modules/.bin/tsc");
		const result = await $`${tsc} -p ${directory}`.nothrow().quiet();
		assert.equal(result.exitCode, 0, `Public type check failed:\n${result.stdout}\n${result.stderr}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Use the evaluator runtime's resolver, accepting equivalent .js and extensionless imports. */
export async function assertImports(root: string, file: string, target: string): Promise<void> {
	const importer = path.join(root, file);
	const expected = await realpath(path.join(root, target));
	const { imports } = new Bun.Transpiler({ loader: "ts" }).scan(await readFile(importer, "utf8"));
	for (const entry of imports) {
		try {
			if ((await realpath(Bun.resolveSync(entry.path, path.dirname(importer)))) === expected) return;
		} catch {
			// Other imports may resolve through compiler-only types or be unrelated to the helper.
		}
	}
	assert.fail(`${file} must import ${target}`);
}
