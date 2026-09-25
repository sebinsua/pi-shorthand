// Query graph impact and add syntax-backed callers, chains, and direct test sites.
import { readFile, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { API } from "typescript/unstable/async";
import { fromHandle, object, type GraphNode } from "../model.ts";
import type { Project } from "../project.ts";
import { handleFor, indexedDeclarations, type Declaration, type DeclarationParser } from "../ranges.ts";
import { connect, type ServerConnection } from "../server/client.ts";
import type { ChangedSymbol, MatchedChanges } from "./changes.ts";
import type { GitChanges } from "./git.ts";

export interface Impact {
	changed: ChangedSymbol[];
	totalChanged: number;
	callers: GraphNode[];
	chains: Array<{ handles: string[]; hops: Array<{ from: string; to: string; kind: string }>; byName?: true }>;
	tests: Array<GraphNode & { byName?: true }>;
	notes: string[];
	server: ServerConnection;
}

const testFile = (file: string) => /\.test\.|\.spec\.|(?:^|\/)__tests__\//.test(file);
const trace = (symbol: ChangedSymbol, direction: "impact" | "reverse", maxNodes: number) => ({
	type: "trace",
	from: symbol.node.handle,
	direction,
	maxDepth: 3,
	maxNodes,
});
const result = (value: unknown) => object(object(value)?.result) ?? {};
const handleOf = (value: unknown) => (typeof object(value)?.id === "string" ? String(object(value)?.id) : undefined);
const startLine = (value: unknown) => {
	const item = object(value);
	const span = object(item?.sourceSpan);
	return typeof span?.startLine === "number" ? span.startLine : typeof item?.line === "number" ? item.line : undefined;
};
const edgesOf = (value: unknown): Record<string, unknown>[] => {
	const hops = result(value).hops;
	return Array.isArray(hops) ? hops.filter((item): item is Record<string, unknown> => !!object(item)) : [];
};

function searchable(item: ChangedSymbol, declarations: Declaration[]): boolean {
	const indexed = indexedDeclarations(declarations);
	return (
		indexed.some((declaration) => declaration.name === item.node.name) &&
		!declarations.some(
			(declaration) => declaration.kind === "interface" && item.node.name.startsWith(`${declaration.name}.`),
		)
	);
}

interface ImportPaths {
	root: string;
	baseUrl?: string;
	pathsBasePath?: string;
	paths: Record<string, string[]>;
}

async function importPaths(project: Project): Promise<ImportPaths> {
	const api = new API({ cwd: project.root });
	try {
		const { options } = await api.parseConfigFile(project.tsconfig);
		const paths = options.paths;
		return {
			root: project.root,
			baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
			pathsBasePath: typeof options.pathsBasePath === "string" ? options.pathsBasePath : dirname(project.tsconfig),
			paths:
				paths && typeof paths === "object" && !Array.isArray(paths)
					? Object.fromEntries(
							Object.entries(paths).filter(
								(entry): entry is [string, string[]] =>
									Array.isArray(entry[1]) && entry[1].every((part) => typeof part === "string"),
							),
						)
					: {},
		};
	} finally {
		await api.close();
	}
}

function matchesModule(resolved: string, target: string): boolean {
	if (resolved === target) return true;
	if (
		[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].some(
			(extension) => resolved + extension === target || resolved + "/index" + extension === target,
		)
	)
		return true;
	const sourceExtension = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
	return Object.entries(sourceExtension).some(
		([extension, replacements]) =>
			resolved.endsWith(extension) &&
			replacements.some((replacement) => resolved.slice(0, -extension.length) + replacement === target),
	);
}

function importsFile(source: string, importer: string, target: string, config: ImportPaths): boolean {
	const statements = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
	for (const match of source.matchAll(statements)) {
		const specifier = match[1] ?? match[2];
		if (specifier.startsWith(".")) {
			if (matchesModule(posix.normalize(posix.join(dirname(importer), specifier)), target)) return true;
			continue;
		}
		for (const [pattern, replacements] of Object.entries(config.paths)) {
			const wildcard = pattern.indexOf("*");
			const captured =
				wildcard < 0
					? specifier === pattern
						? ""
						: undefined
					: specifier.startsWith(pattern.slice(0, wildcard)) && specifier.endsWith(pattern.slice(wildcard + 1))
						? specifier.slice(wildcard, specifier.length - (pattern.length - wildcard - 1))
						: undefined;
			if (captured === undefined) continue;
			for (const replacement of replacements) {
				const mapped = replacement.replace("*", captured);
				const local = relative(config.root, resolve(config.baseUrl ?? config.pathsBasePath ?? config.root, mapped))
					.split(sep)
					.join("/");
				if (matchesModule(local, target)) return true;
			}
		}
		if (config.baseUrl) {
			const local = relative(config.root, resolve(config.baseUrl, specifier)).split(sep).join("/");
			if (matchesModule(local, target)) return true;
		}
	}
	return false;
}

async function relevantHits(
	git: GitChanges,
	project: Project,
	item: ChangedSymbol,
	includeOwnFile: boolean,
	config: ImportPaths,
): Promise<Array<{ file: string; line: number }>> {
	const hits = await git.grep(item.node.name.split(".").at(-1)!);
	const sources = new Map<string, string>();
	const relevant: Array<{ file: string; line: number }> = [];
	for (const hit of hits) {
		const local = git.projectPath(hit.file);
		if (local.outside || !local.path || !/\.(?:ts|tsx|mts|cts)$/.test(local.path)) continue;
		const file = local.path;
		if (file === item.node.file && !includeOwnFile) continue;
		let source = sources.get(file);
		if (source === undefined) {
			try {
				source = await readFile(join(project.root, file), "utf8");
			} catch {
				continue;
			}
			sources.set(file, source);
		}
		const target =
			item.node.status === "moved" && item.file.oldPath
				? (git.projectPath(item.file.oldPath).path ?? item.node.file)
				: item.node.file;
		if (file !== item.node.file && !importsFile(source, file, target, config)) continue;
		const text = source.split("\n")[hit.line - 1] ?? "";
		if (/^\s*(?:import\b|export\b[^\n]*\bfrom\b)/.test(text)) continue;
		const code = text.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "");
		const name = item.node.name
			.split(".")
			.at(-1)!
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code)) continue;
		relevant.push(hit);
	}
	return relevant;
}

type Lookup = {
	getDeclarations(file: string): Promise<Declaration[]>;
	nodeFor(handle: string): Promise<GraphNode | undefined>;
};

function selectChanges(matched: MatchedChanges) {
	const ordered = matched.changed.toSorted(
		(a, b) =>
			Number(a.node.status === "added") - Number(b.node.status === "added") ||
			Number(testFile(a.node.file)) - Number(testFile(b.node.file)) ||
			a.node.file.localeCompare(b.node.file) ||
			(a.node.ranges?.[0]?.start ?? 0) - (b.node.ranges?.[0]?.start ?? 0),
	);
	const changed = ordered.slice(0, 30);
	const notes = [...matched.notes];
	if (ordered.length > 30) {
		const omitted = ordered.slice(30);
		const counts = (["edited", "deleted", "moved", "added"] as const)
			.map((status) => ({ status, count: omitted.filter((item) => item.node.status === status).length }))
			.filter(({ count }) => count)
			.map(({ status, count }) => `${count} ${status}`);
		notes.push(`${omitted.length} omitted (cap 30): ${counts.join(", ")}`);
	}
	return { ordered, changed, notes };
}

async function queryGraph(project: Project, changed: ChangedSymbol[]) {
	const active = changed.filter(({ node }) => node.status !== "deleted");
	let server = await connect(project);
	const requests = active.map((item) => trace(item, "impact", 16));
	let values = requests.length ? await server.values(requests) : [];
	const staleTime = async () => {
		for (const path of new Set(changed.map(({ node }) => node.file))) {
			try {
				if ((await stat(join(project.root, path))).mtimeMs > server.startedAt) return true;
			} catch {
				/* Deleted paths have no current timestamp. */
			}
		}
		return false;
	};
	const mismatches = () =>
		active.flatMap((item, index) => {
			const line = startLine(result(values[index]).start);
			return line !== undefined && !item.codeStarts.includes(line) ? [{ item, line }] : [];
		});
	if ((await staleTime()) || mismatches().length) {
		server = await server.restart();
		values = requests.length ? await server.values(requests) : [];
	}
	const skipped = new Set(mismatches().map(({ item }) => item.node.handle));
	return {
		active: active.filter((item) => !skipped.has(item.node.handle)),
		server,
		values: values.filter((_, index) => !skipped.has(active[index].node.handle)),
		notes: [...skipped].map((handle) => `${handle}: graph disagrees with the file; skipped`),
	};
}

function createLookup(git: GitChanges, project: Project, parser: DeclarationParser, matched: MatchedChanges): Lookup {
	const declarations = matched.current;
	const getDeclarations = async (file: string): Promise<Declaration[]> => {
		const cached = declarations.get(file);
		if (cached) return cached;
		try {
			const parsed = indexedDeclarations(await parser.parse(file, await readFile(join(project.root, file), "utf8")));
			declarations.set(file, parsed);
			return parsed;
		} catch {
			return [];
		}
	};
	const nodeFor = async (handle: string): Promise<GraphNode | undefined> => {
		const ref = fromHandle(handle);
		if (!ref || git.projectPath(`${git.project === "." ? "" : `${git.project}/`}${ref.file}`).outside) return undefined;
		const items = (await getDeclarations(ref.file)).filter((item) => handleFor(ref.file, item) === handle);
		return {
			handle,
			name: ref.name,
			kind: ref.kind,
			file: ref.file,
			ranges: items.length ? items.map(({ start, end }) => ({ start, end })) : null,
		};
	};
	return { getDeclarations, nodeFor };
}

async function reverseFallback(active: ChangedSymbol[], values: unknown[], server: ServerConnection) {
	const truncated = active.flatMap((item, index) =>
		result(values[index]).truncated === true ? [{ item, index }] : [],
	);
	const reverseValues = truncated.length
		? await server.values(truncated.map(({ item }) => trace(item, "reverse", 24)))
		: [];
	const reverseByIndex = new Map(truncated.map(({ index }, position) => [index, reverseValues[position]]));
	return reverseByIndex;
}

type Chain = Impact["chains"][number];
type Hop = Chain["hops"][number];

function incomingEdges(
	item: ChangedSymbol,
	edges: Record<string, unknown>[],
	testMap: Map<string, GraphNode & { byName?: true }>,
) {
	const incoming = new Map<string, Hop[]>();
	for (const edge of edges) {
		if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
		const evidence = object(edge.evidence);
		if (typeof evidence?.file === "string" && testFile(evidence.file) && edge.to === item.node.handle) {
			const line = typeof evidence.startLine === "number" ? evidence.startLine : undefined;
			if (line !== undefined) {
				const key = `${evidence.file}:${line}:${item.node.name}`;
				testMap.set(key, {
					handle: `${evidence.file}#${item.node.name}:site:${line}-${line}`,
					name: item.node.name,
					file: evidence.file,
					ranges: null,
					site: { start: line, end: line },
				});
			}
		}
		const existing = incoming.get(edge.to) ?? [];
		if (!existing.some((hop) => hop.from === edge.from && hop.kind === edge.kind))
			existing.push({ from: edge.from, to: edge.to, kind: typeof edge.kind === "string" ? edge.kind : "unknown" });
		incoming.set(edge.to, existing);
	}
	return incoming;
}

function findChains(item: ChangedSymbol, incoming: Map<string, Hop[]>, changedHandles: Set<string>): Chain[] {
	const found: Chain[] = [];
	const visit = (target: string, tail: Chain, seen: Set<string>) => {
		if (tail.handles.length > 3) return;
		for (const hop of incoming.get(target) ?? []) {
			const caller = hop.from;
			const ref = fromHandle(caller);
			if (!ref || testFile(ref.file) || seen.has(caller) || changedHandles.has(caller)) continue;
			const chain = { handles: [caller, ...tail.handles], hops: [hop, ...tail.hops] };
			found.push(chain);
			visit(caller, chain, new Set([...seen, caller]));
		}
	};
	visit(item.node.handle, { handles: [item.node.handle], hops: [] }, new Set([item.node.handle]));
	return found.toSorted(
		(a, b) =>
			Number(fromHandle(a.handles[0])?.file === item.node.file) -
				Number(fromHandle(b.handles[0])?.file === item.node.file) || b.handles.length - a.handles.length,
	);
}

async function recordChains(
	found: Chain[],
	nodeFor: Lookup["nodeFor"],
	callerMap: Map<string, GraphNode>,
	chains: Impact["chains"],
) {
	const indexed: Chain[] = [];
	for (const chain of found) {
		const { handles } = chain;
		const nodes = await Promise.all(handles.slice(0, -1).map(nodeFor));
		if (nodes.some((node) => !node?.ranges?.length)) continue;
		indexed.push(chain);
		for (const node of nodes) if (node) callerMap.set(node.handle, node);
	}
	const seenOuter = new Set<string>();
	for (const chain of indexed) {
		const { handles } = chain;
		const outer = handles[0];
		if (seenOuter.has(outer) || seenOuter.size >= 5) continue;
		seenOuter.add(outer);
		chains.push(chain);
	}
}

async function graphChains(input: {
	active: ChangedSymbol[];
	changed: ChangedSymbol[];
	values: unknown[];
	reverseByIndex: Map<number, unknown>;
	notes: string[];
	callerMap: Map<string, GraphNode>;
	testMap: Map<string, GraphNode & { byName?: true }>;
	chains: Impact["chains"];
	nodeFor: Lookup["nodeFor"];
}) {
	const { active, changed, values, reverseByIndex, notes, callerMap, testMap, chains, nodeFor } = input;
	const changedHandles = new Set(changed.map(({ node }) => node.handle));
	for (let index = 0; index < active.length; index++) {
		const item = active[index];
		let value = values[index];
		if (!handleOf(result(value).start)) {
			notes.push(`${item.node.name}: not indexed: outside tsconfig or unsupported declaration`);
			continue;
		}
		let edges = edgesOf(value);
		if (result(value).truncated === true) {
			notes.push(`${item.node.name}: impact truncated at 16 callers; reverse trace used`);
			value = reverseByIndex.get(index);
			edges = [...edges, ...edgesOf(value)];
		}
		const incoming = incomingEdges(item, edges, testMap);
		await recordChains(findChains(item, incoming, changedHandles), nodeFor, callerMap, chains);
	}
}

async function deletedCallers(input: {
	git: GitChanges;
	project: Project;
	parser: DeclarationParser;
	changed: ChangedSymbol[];
	getDeclarations: Lookup["getDeclarations"];
	nodeFor: Lookup["nodeFor"];
	callerMap: Map<string, GraphNode>;
	chains: Impact["chains"];
	config: ImportPaths;
}) {
	const { git, project, parser, changed, getDeclarations, nodeFor, callerMap, chains, config } = input;
	const changedHandles = new Set(changed.map(({ node }) => node.handle));
	for (const item of changed.filter(({ node }) => node.status === "deleted" || node.status === "moved")) {
		const old = await git.baseText(item.file.oldPath ?? item.file.path);
		if (!old || !searchable(item, await parser.parse(item.node.file, old))) continue;
		const found = new Set<string>();
		for (const hit of await relevantHits(git, project, item, nodeStatusOwnFile(item), config)) {
			const local = git.projectPath(hit.file);
			if (local.outside || !local.path) continue;
			const decl = (await getDeclarations(local.path))
				.filter(({ start, end }) => start <= hit.line && hit.line <= end)
				.toSorted((a, b) => a.end - a.start - (b.end - b.start))[0];
			if (!decl) continue;
			const handle = handleFor(local.path, decl);
			if (found.has(handle) || changedHandles.has(handle) || found.size >= 5) continue;
			found.add(handle);
			const node = await nodeFor(handle);
			if (node) callerMap.set(handle, node);
			chains.push({
				handles: [handle, item.node.handle],
				hops: [{ from: handle, to: item.node.handle, kind: "by_name" }],
				byName: true,
			});
		}
	}
}

function nodeStatusOwnFile(item: ChangedSymbol): boolean {
	return item.node.status === "deleted" && !item.node.name.includes(".");
}

async function testSites(input: {
	git: GitChanges;
	project: Project;
	parser: DeclarationParser;
	changed: ChangedSymbol[];
	getDeclarations: Lookup["getDeclarations"];
	testMap: Map<string, GraphNode & { byName?: true }>;
	config: ImportPaths;
}) {
	const { git, project, parser, changed, getDeclarations, testMap, config } = input;
	for (const item of changed) {
		const declarations =
			item.node.status === "deleted"
				? await parser.parse(item.node.file, (await git.baseText(item.file.oldPath ?? item.file.path)) ?? "")
				: await getDeclarations(item.node.file);
		if (!searchable(item, declarations)) continue;
		for (const hit of await relevantHits(git, project, item, false, config)) {
			const local = git.projectPath(hit.file);
			if (local.outside || !local.path || !testFile(local.path)) continue;
			const key = `${local.path}:${hit.line}:${item.node.name}`;
			if (testMap.has(key)) continue;
			testMap.set(key, {
				handle: `${local.path}#${item.node.name}:site:${hit.line}-${hit.line}`,
				name: item.node.name,
				file: local.path,
				ranges: null,
				site: { start: hit.line, end: hit.line },
				byName: true,
			});
		}
	}
}

/** Collect capped changes, fresh graph impact, fallback callers, and test sites. */
export async function collectImpact(
	git: GitChanges,
	project: Project,
	parser: DeclarationParser,
	matched: MatchedChanges,
): Promise<Impact> {
	const { ordered, changed, notes } = selectChanges(matched);
	const queried = await queryGraph(project, changed);
	const { active, server, values } = queried;
	notes.push(...queried.notes);
	const { getDeclarations, nodeFor } = createLookup(git, project, parser, matched);
	const callerMap = new Map<string, GraphNode>();
	const testMap = new Map<string, GraphNode & { byName?: true }>();
	const chains: Impact["chains"] = [];
	const reverseByIndex = await reverseFallback(active, values, server);
	const config = await importPaths(project);
	await graphChains({ active, changed, values, reverseByIndex, notes, callerMap, testMap, chains, nodeFor });
	await deletedCallers({ git, project, parser, changed, getDeclarations, nodeFor, callerMap, chains, config });
	await testSites({ git, project, parser, changed, getDeclarations, testMap, config });
	const tests = [...testMap.values()].toSorted((a, b) => a.file.localeCompare(b.file) || a.site!.start - b.site!.start);
	if (tests.length > 200) notes.push(`... ${tests.length - 200} more direct test sites`);
	return {
		changed,
		totalChanged: ordered.length,
		callers: [...callerMap.values()].toSorted(
			(a, b) => a.file.localeCompare(b.file) || (a.ranges?.[0]?.start ?? 0) - (b.ranges?.[0]?.start ?? 0),
		),
		chains: chains.filter(
			(chain, index) =>
				!chains.some(
					(other, otherIndex) =>
						index !== otherIndex &&
						other.handles.length > chain.handles.length &&
						other.handles.slice(-chain.handles.length).every((handle, position) => handle === chain.handles[position]),
				),
		),
		tests: tests.slice(0, 200),
		notes,
		server,
	};
}
