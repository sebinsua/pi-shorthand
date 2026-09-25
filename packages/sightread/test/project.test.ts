// Exercise project discovery and its ordered suggestions.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryError, findProject } from "../src/project.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "sightread-discovery-"));
	roots.push(root);
	return root;
}

function config(root: string, path: string): string {
	const configDir = join(root, path);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "tsconfig.json"), "{}");
	return configDir;
}

test("walks up to the nearest tsconfig", async () => {
	const root = directory();
	config(root, ".");
	const nearest = config(root, "app");
	const nested = join(nearest, "src", "deep");
	mkdirSync(nested, { recursive: true });
	expect(await findProject(nested)).toEqual({ root: nearest, tsconfig: join(nearest, "tsconfig.json") });
});

test("suggests up to three levels down in depth and path order, skipping generated folders", async () => {
	const root = directory();
	config(root, "alpha");
	config(root, "zeta");
	config(root, "middle/nested");
	config(root, "deep/inside/project");
	config(root, "four/levels/down/too-deep");
	for (const skipped of [".llm-ephemeral", "node_modules", ".bare", ".git", "dist", "build"])
		config(root, `${skipped}/hidden`);
	await expect(findProject(root)).rejects.toThrow(
		new DiscoveryError(
			"no tsconfig.json above this directory; try --cwd alpha (nearby: zeta, middle/nested, deep/inside/project)",
		),
	);
});

test("limits suggestions to ten directories", async () => {
	const root = directory();
	const candidates = Array.from({ length: 12 }, (_, index) => config(root, `p${String(index).padStart(2, "0")}`));
	await expect(findProject(root)).rejects.toThrow(
		`no tsconfig.json above this directory; try --cwd p00 (nearby: ${candidates
			.slice(1, 10)
			.map((candidate) => candidate.slice(root.length + 1))
			.join(", ")})`,
	);
});

test("omits nearby text for one candidate", async () => {
	const root = directory();
	config(root, "one");
	await expect(findProject(root)).rejects.toThrow("no tsconfig.json above this directory; try --cwd one");
});

test("quotes only a suggested path containing spaces", async () => {
	const root = directory();
	config(root, "my app");
	await expect(findProject(root)).rejects.toThrow('no tsconfig.json above this directory; try --cwd "my app"');
});

test("reports when there are no candidates", async () => {
	const root = directory();
	await expect(findProject(root)).rejects.toThrow("no tsconfig.json above this directory or up to 3 levels below it");
});
