// Turn upstream graph values into stable symbols, edges, and sections.
// Graph evidence uses 1-based UTF-8 byte columns with exclusive ends; edge columns use UTF-16.
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RangeIndex } from "./ranges.ts";
import type { PathMapper } from "./paths.ts";

export interface GraphNode {
	handle: string;
	name: string;
	kind?: string;
	file: string;
	ranges: { start: number; end: number }[] | null;
	site?: { start: number; end: number };
	exact?: true;
	fanIn?: number;
	fanOut?: number;
	line?: number;
	col?: number;
	endCol?: number;
	text?: string;
}

export interface GraphEdge {
	from: string;
	to: string;
	kind: string;
	at?: {
		file: string;
		line: number;
		/** 1-based UTF-16 column of the first character. */
		col?: number;
		/** 1-based line of the exclusive end. */
		endLine?: number;
		/** 1-based UTF-16 column just past the last character. */
		endCol?: number;
	};
}

export interface GraphResult {
	type: string;
	tsconfig?: string;
	nestedProjects?: string[];
	error?: string;
	shown: number;
	total?: number;
	raise?: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	sections: Record<string, unknown>;
}

export const omittedKeys = [
	"audit",
	"next",
	"reason",
	"reasons",
	"nextStep",
	"nextSteps",
	"hint",
	"hints",
	"caveat",
	"caveats",
	"score",
	"scores",
	"depth",
	"line",
	"sourceSpan",
	"startLine",
	"endLine",
	"truncated",
	"signature",
	"signatures",
	"preview",
	"codePreview",
	"documentation",
	"doc",
	"docText",
] as const;

const omitted = new Set<string>(omittedKeys);
const primaryLists = ["hits", "entrypoints", "hotspots", "publicApi", "nodes", "reached", "hops", "files", "tests"];
const requests = new WeakMap<GraphResult, Record<string, unknown>>();

function utf16Column(line: string, byteColumn: number): number | undefined {
	if (!Number.isInteger(byteColumn) || byteColumn < 1) return undefined;
	let bytes = 0;
	let units = 0;
	for (const character of line) {
		if (bytes === byteColumn - 1) return units + 1;
		bytes += Buffer.byteLength(character);
		units += character.length;
		if (bytes > byteColumn - 1) return undefined;
	}
	return bytes === byteColumn - 1 ? units + 1 : undefined;
}

async function evidenceLines(value: unknown, root: string): Promise<Map<string, string[]>> {
	const files = new Set<string>();
	const collect = (nested: unknown): void => {
		if (Array.isArray(nested)) return nested.forEach(collect);
		const item = object(nested);
		if (!item) return;
		const evidence = object(item.evidence);
		if (
			typeof item.from === "string" &&
			typeof item.to === "string" &&
			typeof item.kind === "string" &&
			typeof evidence?.file === "string" &&
			typeof evidence.startCol === "number" &&
			typeof evidence.endCol === "number"
		)
			files.add(evidence.file);
		for (const child of Object.values(item)) collect(child);
	};
	collect(value);
	const contents = await Promise.all(
		[...files].map(async (file): Promise<[string, string[]] | undefined> => {
			const absolute = resolve(root, file);
			const path = relative(root, absolute);
			if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
			try {
				return [file, (await readFile(absolute, "utf8")).split(/\r\n|\n|\r/)];
			} catch {
				return undefined;
			}
		}),
	);
	return new Map(contents.filter((item): item is [string, string[]] => item !== undefined));
}

export function requestFor(result: GraphResult): Record<string, unknown> | undefined {
	return requests.get(result);
}

export function inheritRequest(source: GraphResult, target: GraphResult): GraphResult {
	const request = requests.get(source);
	if (request) requests.set(target, request);
	return target;
}

export function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function fromHandle(value: string): { file: string; name: string; kind: string } | undefined {
	const match = /^(.*)#([^#]+):([^:]+)$/.exec(value);
	return match ? { file: match[1], name: match[2], kind: match[3] } : undefined;
}

function truncated(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(truncated);
	const item = object(value);
	return item ? item.truncated === true || Object.values(item).some(truncated) : false;
}

function symbol(
	value: Record<string, unknown>,
):
	| { handle: string; name: string; file: string; kind?: string; line?: number; site?: { start: number; end: number } }
	| undefined {
	if (typeof value.name !== "string") return undefined;
	const parsed = typeof value.id === "string" ? fromHandle(value.id) : undefined;
	const file = typeof value.file === "string" ? value.file : parsed?.file;
	const kind = typeof value.kind === "string" ? value.kind : parsed?.kind;
	if (!file) return undefined;
	if (kind)
		return {
			handle: parsed ? (value.id as string) : `${file}#${value.name}:${kind}`,
			name: value.name,
			file,
			kind,
			...(typeof value.line === "number" ? { line: value.line } : {}),
		};
	if (typeof value.startLine === "number" && typeof value.endLine === "number") {
		return {
			handle: `${file}#${value.name}:site:${value.startLine}-${value.endLine}`,
			name: value.name,
			file,
			site: { start: value.startLine, end: value.endLine },
		};
	}
	return undefined;
}

/** Normalise one upstream value without assuming a request-specific result layout. */
export async function normalizeResult(
	request: Record<string, unknown>,
	upstreamValue: unknown,
	ranges: RangeIndex,
	paths?: PathMapper,
): Promise<GraphResult> {
	const root = object(object(upstreamValue)?.result) ?? object(upstreamValue) ?? {};
	const linesByFile = await evidenceLines(root, paths?.project ?? process.cwd());
	const type = typeof root.type === "string" ? root.type : String(request.type ?? "result");
	const nodes = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const edgeKeys = new Map<string, number>();
	const pending: Promise<void>[] = [];
	const addSymbol = (item: Record<string, unknown>): string | undefined => {
		const ref = symbol(item);
		if (!ref) return undefined;
		const handle = paths?.toRepositoryHandle(ref.handle) ?? ref.handle;
		const exact =
			type === "lookup" &&
			typeof request.query === "string" &&
			(ref.name === request.query || ref.name.split(".").at(-1) === request.query);
		const existing = nodes.get(handle);
		if (existing) {
			if (exact) existing.exact = true;
			return handle;
		}
		const node: GraphNode = {
			handle,
			name: ref.name,
			file: paths?.toRepositoryPath(ref.file) ?? ref.file,
			ranges: null,
			...(ref.kind ? { kind: ref.kind } : {}),
			...(ref.site ? { site: ref.site } : {}),
			...(exact ? { exact: true as const } : {}),
			...(typeof item.fanIn === "number" ? { fanIn: item.fanIn } : {}),
			...(typeof item.fanOut === "number" ? { fanOut: item.fanOut } : {}),
		};
		nodes.set(handle, node);
		if (ref.kind)
			pending.push(
				ranges.rangesFor({ name: ref.name, file: ref.file, kind: ref.kind, line: ref.line }).then((found) => {
					node.ranges = found?.length ? found : null;
				}),
			);
		return handle;
	};
	const addEndpoint = (handle: string) => {
		if (nodes.has(paths?.toRepositoryHandle(handle) ?? handle)) return;
		const ref = fromHandle(handle);
		if (ref) addSymbol({ id: handle, ...ref });
	};
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			const entries = value.map(walk).filter((entry) => entry !== undefined);
			return entries.length ? entries : undefined;
		}
		const item = object(value);
		if (!item) return typeof value === "string" && fromHandle(value) && paths ? paths.toRepositoryHandle(value) : value;
		if (typeof item.from === "string" && typeof item.to === "string" && typeof item.kind === "string") {
			addEndpoint(item.from);
			addEndpoint(item.to);
			const evidence = object(item.evidence);
			const lines = typeof evidence?.file === "string" ? linesByFile.get(evidence.file) : undefined;
			const startLine = evidence?.startLine;
			const endLine = evidence?.endLine;
			const col =
				lines && typeof startLine === "number" && typeof evidence?.startCol === "number"
					? utf16Column(lines[startLine - 1] ?? "", evidence.startCol)
					: undefined;
			const endCol =
				lines && typeof endLine === "number" && typeof evidence?.endCol === "number"
					? utf16Column(lines[endLine - 1] ?? "", evidence.endCol)
					: undefined;
			const edge: GraphEdge = {
				from: paths?.toRepositoryHandle(item.from) ?? item.from,
				to: paths?.toRepositoryHandle(item.to) ?? item.to,
				kind: item.kind,
				...(typeof evidence?.file === "string" && typeof evidence.startLine === "number"
					? {
							at: {
								file: paths?.toRepositoryPath(evidence.file) ?? evidence.file,
								line: evidence.startLine,
								...(col !== undefined && endCol !== undefined && typeof endLine === "number"
									? { col, endLine, endCol }
									: {}),
							},
						}
					: {}),
			};
			const key = JSON.stringify(edge);
			let index = edgeKeys.get(key);
			if (index === undefined) {
				index = edges.length;
				edges.push(edge);
				edgeKeys.set(key, index);
			}
			return index;
		}
		const handle = addSymbol(item);
		if (handle) return handle;
		const result: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(item)) {
			if (omitted.has(key) || (key === "steps" && item.hops !== undefined)) continue;
			const converted =
				key === "file" && typeof nested === "string" && paths ? paths.toRepositoryPath(nested) : walk(nested);
			if (converted !== undefined && (object(converted) === undefined || Object.keys(converted as object).length))
				result[key] = converted;
		}
		return Object.keys(result).length ? result : undefined;
	};
	const sections: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(root)) {
		if (key === "type" || key === "total" || omitted.has(key) || (key === "steps" && root.hops !== undefined)) continue;
		let converted = walk(value);
		if (type === "lookup" && key === "hits" && Array.isArray(converted))
			converted = [...converted].toSorted(
				(a, b) =>
					Number(nodes.has(String(b)) && nodes.get(String(b))?.exact === true) -
					Number(nodes.has(String(a)) && nodes.get(String(a))?.exact === true),
			);
		if (converted !== undefined) sections[key] = converted;
	}
	const step = /^(.+?) -\[([A-Za-z]+) at ([^:\]\n]+):([1-9]\d*)\]-> (.+)$/;
	const convertSteps = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(convertSteps);
		if (typeof value === "string") {
			const match = step.exec(value);
			if (!match) return value;
			const from = [...nodes.values()].filter((node) => !node.site && node.name === match[1]);
			const to = [...nodes.values()].filter((node) => !node.site && node.name === match[5]);
			if (from.length !== 1 || to.length !== 1)
				return paths
					? value.replace(` at ${match[3]}:${match[4]}]`, ` at ${paths.toRepositoryPath(match[3])}:${match[4]}]`)
					: value;
			const edge: GraphEdge = {
				from: from[0].handle,
				to: to[0].handle,
				kind: match[2],
				at: { file: paths?.toRepositoryPath(match[3]) ?? match[3], line: Number(match[4]) },
			};
			const key = JSON.stringify(edge);
			let index = edgeKeys.get(key);
			if (index === undefined) {
				index = edges.length;
				edges.push(edge);
				edgeKeys.set(key, index);
			}
			return index;
		}
		const item = object(value);
		if (!item) return value;
		return Object.fromEntries(
			Object.entries(item).map(([key, nested]) => [
				key,
				key === "steps" ? convertSteps(nested) : convertNested(nested),
			]),
		);
	};
	const convertNested = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(convertNested);
		const item = object(value);
		return item
			? Object.fromEntries(
					Object.entries(item).map(([key, nested]) => [
						key,
						key === "steps" ? convertSteps(nested) : convertNested(nested),
					]),
				)
			: value;
	};
	for (const [key, value] of Object.entries(sections))
		sections[key] = key === "steps" ? convertSteps(value) : convertNested(value);
	await Promise.all(pending);
	const sorted = [...nodes.values()].toSorted(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			(a.ranges?.[0]?.start ?? a.site?.start ?? Infinity) - (b.ranges?.[0]?.start ?? b.site?.start ?? Infinity) ||
			a.name.localeCompare(b.name),
	);
	const first = primaryLists.find((key) => Array.isArray(root[key]));
	const shown = first ? (root[first] as unknown[]).length : 0;
	const total = typeof root.total === "number" ? root.total : undefined;
	const limit = type === "trace" ? "maxNodes" : type === "details" ? "memberLimit" : "limit";
	const model: GraphResult = {
		type,
		shown,
		...(total === undefined ? {} : { total }),
		...(truncated(root) ? { raise: `${type}.${limit}` } : {}),
		nodes: sorted,
		edges,
		sections,
	};
	requests.set(model, request);
	return model;
}
