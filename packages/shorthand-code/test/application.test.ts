import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { applyChanges } from "../src/runner/runner.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-application-"));
	roots.push(root);
	const repo = path.join(root, "repo");
	await mkdir(repo);
	return { root, repo };
}

function added(file: string) {
	return { file, before: null, after: { type: "file" as const, contents: Buffer.from(file), mode: 0o644 } };
}

const options = () => ({ abort: new AbortController().signal });

test("application creates nested parents shared by new files and symlinks", async () => {
	const { repo } = await fixture();
	const changes = [
		added("new/nested/a.ts"),
		added("new/nested/b.ts"),
		{ file: "new/link", before: null, after: { type: "symlink" as const, target: "nested/a.ts" } },
	];
	const result = await applyChanges(repo, changes, options());
	expect(result.conflicts).toEqual([]);
	expect(result.applied).toEqual(changes);
	expect(await Bun.file(path.join(repo, "new/nested/a.ts")).text()).toBe("new/nested/a.ts");
	expect(await Bun.file(path.join(repo, "new/link")).text()).toBe("new/nested/a.ts");
});

test("failed application removes its new empty parents but preserves existing directories", async () => {
	const { repo } = await fixture();
	await mkdir(path.join(repo, "existing"));
	await expect(
		applyChanges(repo, [added("existing/new/a.ts"), added("other/deep/b.ts")], {
			...options(),
			testHooks: { failAfter: 1 },
		}),
	).rejects.toThrow("Injected application failure");
	expect(await readdir(repo)).toEqual(["existing"]);
	expect(await readdir(path.join(repo, "existing"))).toEqual([]);
});

test("missing descendants beneath an external symlink remain conflicts", async () => {
	const { root, repo } = await fixture();
	const outside = path.join(root, "outside");
	await mkdir(outside);
	await symlink(outside, path.join(repo, "link"));
	const result = await applyChanges(repo, [added("link/new/nested/file")], options());
	expect(result.conflicts).toEqual(["link/new/nested/file"]);
	expect(result.applied).toEqual([]);
	expect(await readdir(outside)).toEqual([]);
});

test("an existing file cannot be treated as a missing parent", async () => {
	const { repo } = await fixture();
	await Bun.write(path.join(repo, "file"), "original");
	const result = await applyChanges(repo, [added("file/new/child")], options());
	expect(result.conflicts).toEqual(["file/new/child"]);
	expect(await Bun.file(path.join(repo, "file")).text()).toBe("original");
});

test("aborted application removes empty directories created during preparation", async () => {
	const { repo } = await fixture();
	const result = await applyChanges(repo, [added("new/nested/file")], { abort: AbortSignal.abort() });
	expect(result.applied).toEqual([]);
	expect(await readdir(repo)).toEqual([]);
});
