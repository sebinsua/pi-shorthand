// Fingerprint project configuration, dependencies, and sightread source.
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Project } from "../project.ts";

const require = createRequire(import.meta.url);
const names = [
	"tsconfig.json",
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
];
const versions = ["@ttsc/graph", "ttsc", "typescript"].map((name) => [
	name,
	(require(`${name}/package.json`) as { version: string }).version,
]);
const ownVersion = (require("../../package.json") as { version: string }).version;
const sourceRoot = join(import.meta.dir, "..");

async function sourceFiles(directory: string, prefix = ""): Promise<Array<[string, number, number]>> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const name = join(prefix, entry.name);
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path, name);
			if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
			const info = await stat(path);
			return [[name, info.mtimeMs, info.size] as [string, number, number]];
		}),
	);
	return files.flat().toSorted(([a], [b]) => a.localeCompare(b));
}

async function resolveExtends(file: string, value: string): Promise<string> {
	if (value.startsWith(".") || isAbsolute(value)) {
		const base = resolve(dirname(file), value);
		for (const candidate of [base, `${base}.json`, join(base, "tsconfig.json")]) {
			try {
				if ((await stat(candidate)).isFile()) return candidate;
			} catch {
				/* Try the next form. */
			}
		}
		return base;
	}
	const localRequire = createRequire(file);
	for (const candidate of [`${value}/package.json`, `${value}/tsconfig.json`, value]) {
		try {
			const found = localRequire.resolve(candidate);
			if (found.endsWith("package.json")) {
				const packageValue = JSON.parse(await readFile(found, "utf8")) as { tsconfig?: string };
				return resolve(dirname(found), packageValue.tsconfig ?? "tsconfig.json");
			}
			return found;
		} catch {
			/* Try the next package form. */
		}
	}
	return resolve(dirname(file), "node_modules", value);
}

async function configChain(selected: string): Promise<Array<[string, number, number]>> {
	const seen = new Set<string>();
	const files: Array<[string, number, number]> = [];
	const visit = async (file: string): Promise<void> => {
		if (seen.has(file)) return;
		seen.add(file);
		const info = await stat(file);
		files.push([file, info.mtimeMs, info.size]);
		const value: unknown = Bun.JSONC.parse(await readFile(file, "utf8"));
		if (!value || typeof value !== "object" || !("extends" in value)) return;
		const extension = (value as { extends?: unknown }).extends;
		const parents =
			typeof extension === "string"
				? [extension]
				: Array.isArray(extension)
					? extension.filter((item): item is string => typeof item === "string")
					: [];
		for (const parent of parents) await visit(await resolveExtends(file, parent));
	};
	await visit(selected);
	return files.toSorted(([a], [b]) => a.localeCompare(b));
}

export async function projectSignature(project: Project): Promise<string> {
	const files = await Promise.all(
		names.map(async (name) => {
			try {
				const info = await stat(join(project.root, name));
				return [name, info.mtimeMs, info.size];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return [name, "missing"];
			}
		}),
	);
	const selected = await configChain(project.tsconfig);
	const source = await sourceFiles(sourceRoot);
	return createHash("sha256")
		.update(
			JSON.stringify({
				files,
				selected,
				source,
				versions,
				ownVersion,
			}),
		)
		.digest("hex");
}
