// Find the nearest TypeScript project and suggest nearby projects when none contains the start directory.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { API } from "typescript/unstable/async";

export interface Project {
	/** Absolute directory containing the tsconfig. */
	root: string;
	/** Absolute path of that tsconfig.json. */
	tsconfig: string;
}

export class DiscoveryError extends Error {}

const skipped = new Set([".llm-ephemeral", "node_modules", ".bare", ".git", "dist", "build"]);

/** Count the same source files used when choosing a referenced TypeScript project. */
export async function projectFiles(project: Project): Promise<Set<string>> {
	const api = new API({ cwd: project.root });
	try {
		const parsed = await api.parseConfigFile(project.tsconfig);
		return new Set(
			parsed.fileNames
				.filter((name) => /\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.d\.(?:ts|mts|cts)$/.test(name))
				.map((name) => resolve(name)),
		);
	} finally {
		await api.close();
	}
}

/** List nearby tsconfig directories below the graphed config, up to three levels deep. */
export function nestedProjects(project: Project): string[] {
	const root = dirname(project.tsconfig);
	const found: string[] = [];
	let level = [root];
	for (let depth = 1; depth <= 3 && level.length; depth++) {
		const next: string[] = [];
		for (const parent of level) {
			let entries;
			try {
				entries = readdirSync(parent, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || skipped.has(entry.name)) continue;
				const child = join(parent, entry.name);
				if (hasTsconfig(child)) found.push(child);
				if (depth < 3) next.push(child);
			}
		}
		level = next;
	}
	return found;
}

function hasTsconfig(directory: string): boolean {
	try {
		return statSync(join(directory, "tsconfig.json")).isFile();
	} catch {
		return false;
	}
}

function configReferences(file: string): string[] {
	const value: unknown = Bun.JSONC.parse(readFileSync(file, "utf8"));
	if (!value || typeof value !== "object") return [];
	const config = value as { files?: unknown; include?: unknown; references?: unknown };
	if (!Array.isArray(config.references) || config.references.length === 0) return [];
	if (Array.isArray(config.files) ? config.files.length > 0 : config.include !== undefined) return [];
	return config.references.flatMap((entry: unknown) => {
		if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string") return [];
		const target = resolve(dirname(file), entry.path);
		try {
			return [statSync(target).isDirectory() ? join(target, "tsconfig.json") : target];
		} catch {
			return [target];
		}
	});
}

/**
 * The project to graph when the nearest tsconfig.json is a solution config: one that lists no files
 * of its own and only `references` others. That's the default layout of a Vite app
 * (`tsconfig.app.json` and `tsconfig.node.json`) and of project-reference monorepos, and graphing the
 * solution itself would find nothing.
 *
 * References are followed through nested solution configs. The chosen project is the one whose
 * source files include the current directory; at the root, where none does, it's the one with the
 * most TypeScript source files.
 */
async function chosenConfig(solution: string, cwd: string): Promise<string> {
	const seen = new Set<string>();
	const leaves: string[] = [];
	function visit(file: string) {
		if (seen.has(file)) return;
		seen.add(file);
		const references = configReferences(file);
		if (references.length === 0) leaves.push(file);
		else for (const reference of references) visit(reference);
	}
	visit(solution);
	if (leaves.length === 1) return leaves[0];
	const api = new API({ cwd: dirname(solution) });
	try {
		let best = solution;
		let bestContains = false;
		let bestCount = -1;
		for (const file of leaves) {
			const parsed = await api.parseConfigFile(file);
			const files = parsed.fileNames.filter(
				(name) => /\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.d\.(?:ts|mts|cts)$/.test(name),
			);
			const contains = files.some((name) => {
				const path = relative(cwd, name);
				return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
			});
			if ((contains && !bestContains) || (contains === bestContains && files.length > bestCount)) {
				best = file;
				bestContains = contains;
				bestCount = files.length;
			}
		}
		return best;
	} finally {
		await api.close();
	}
}

function suggestion(start: string, candidate: string): string {
	const path = relative(start, candidate);
	return /\s/.test(path) ? `"${path}"` : path;
}

/** Walk up from `start` to the nearest tsconfig.json; otherwise search below for suggestions. */
export async function findProject(start: string): Promise<Project> {
	const initial = resolve(start);
	let directory = initial;
	while (true) {
		if (hasTsconfig(directory)) {
			const solution = join(directory, "tsconfig.json");
			return {
				root: directory,
				tsconfig: configReferences(solution).length ? await chosenConfig(solution, initial) : solution,
			};
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}

	const candidates: string[] = [];
	let level = [initial];
	for (let depth = 1; depth <= 3 && candidates.length < 10 && level.length > 0; depth++) {
		const next: string[] = [];
		for (const parent of level) {
			if (candidates.length === 10) break;
			let entries;
			try {
				entries = readdirSync(parent, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || skipped.has(entry.name)) continue;
				const child = join(parent, entry.name);
				if (hasTsconfig(child)) candidates.push(child);
				if (depth < 3) next.push(child);
				if (candidates.length === 10) break;
			}
		}
		level = next.toSorted();
	}
	const nearby = candidates;
	if (nearby.length === 0) throw new DiscoveryError("no tsconfig.json above this directory or up to 3 levels below it");
	const [nearest, ...rest] = nearby;
	throw new DiscoveryError(
		`no tsconfig.json above this directory; try --cwd ${suggestion(initial, nearest)}${rest.length ? ` (nearby: ${rest.map((path) => suggestion(initial, path)).join(", ")})` : ""}`,
	);
}
