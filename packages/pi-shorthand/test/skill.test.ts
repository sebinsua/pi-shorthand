import { expect, test } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCode from "../src/index.ts";

test("Pi loads the shorthand skill from shorthand-code", async () => {
	const handlers = new Map<string, () => unknown>();
	await registerCode(
		{
			on(event: string, handler: () => unknown) {
				handlers.set(event, handler);
			},
			registerTool() {},
		} as unknown as ExtensionAPI,
		async () => undefined,
	);
	const discovered = (await handlers.get("resources_discover")?.()) as { skillPaths: string[] };
	expect(discovered.skillPaths).toHaveLength(1);
	const skill = await Bun.file(path.join(discovered.skillPaths[0], "shorthand/SKILL.md")).text();
	expect(skill.startsWith("---\nname: shorthand\n")).toBe(true);
});

test("Node resolves shorthand-code's package.json, as Pi does when loading the extension", () => {
	// Bun ignores a package's `exports` map here, and Node doesn't, so check under Node.
	const result = Bun.spawnSync(["node", "-e", 'console.log(require.resolve("shorthand-code/package.json"))'], {
		cwd: path.join(import.meta.dir, ".."),
	});
	expect(result.stderr.toString()).toBe("");
	expect(result.stdout.toString().trim().endsWith(path.join("shorthand-code", "package.json"))).toBe(true);
});
