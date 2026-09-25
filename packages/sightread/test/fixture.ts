// Build disposable TypeScript projects for real graph integration tests.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Create a temporary TypeScript project from relative file contents. */
export function createFixtureProject(files: Record<string, string>): { root: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "sightread-"));
	try {
		for (const [path, contents] of Object.entries({ "tsconfig.json": "{}", ...files })) {
			const target = join(root, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}
		return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
