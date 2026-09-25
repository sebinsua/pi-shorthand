// Run graph batches and choose raw, model, or text output.
import { isAbsolute, normalize, relative, sep } from "node:path";
import { inheritRequest, normalizeResult, type GraphResult } from "./model.ts";
import { resolveNamesSettled } from "./names.ts";
import { createPaths } from "./paths.ts";
import type { RangeIndex } from "./ranges.ts";
import { renderText } from "./render.ts";
import type { GraphClient } from "./upstream.ts";

export interface QueryContext {
	client: GraphClient;
	ranges: RangeIndex;
	root?: string;
	tsconfig?: string;
	projectFileCount?: number;
	nestedProjects?: string[];
}

export interface QueryOptions {
	mode?: "text" | "json" | "raw";
	in?: string;
	color?: boolean;
	json?: boolean;
}

function filterIn(result: GraphResult, directory: string): GraphResult {
	const prefix = normalize(directory).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").replace(/^\.$/, "");
	const keep = (file: string) => !prefix || file === prefix || file.startsWith(`${prefix}/`);
	const nodes = result.nodes.filter((node) => keep(node.file));
	const handles = new Set(nodes.map((node) => node.handle));
	const allHandles = new Set(result.nodes.map((node) => node.handle));
	const edges = result.edges.filter((edge) => handles.has(edge.from) && handles.has(edge.to));
	const indices = new Map<number, number>();
	result.edges.forEach((edge, index) => {
		const next = edges.indexOf(edge);
		if (next >= 0) indices.set(index, next);
	});
	const filter = (value: unknown, edgeList = false): unknown => {
		if (typeof value === "string" && allHandles.has(value)) return handles.has(value) ? value : undefined;
		if (Array.isArray(value)) {
			const entries = value.map((item) => filter(item, edgeList)).filter((item) => item !== undefined);
			return entries.length ? entries : undefined;
		}
		if (typeof value === "number" && edgeList) return indices.get(value);
		if (value && typeof value === "object") {
			const entries = Object.entries(value)
				.map(([key, item]) => [key, filter(item, key === "hops")] as const)
				.filter(([, item]) => item !== undefined);
			return entries.length ? Object.fromEntries(entries) : undefined;
		}
		return value;
	};
	const sections = Object.fromEntries(
		Object.entries(result.sections)
			.map(([key, value]) => [key, filter(value, key === "hops")])
			.filter(([, value]) => value !== undefined),
	);
	const primary = ["hits", "entrypoints", "nodes", "reached", "hops", "files", "tests"].find((key) =>
		Array.isArray(result.sections[key]),
	);
	return inheritRequest(result, {
		...result,
		nodes,
		edges,
		sections,
		shown: primary && Array.isArray(sections[primary]) ? sections[primary].length : 0,
	});
}

/** Run one request or a batch and return exactly what the CLI prints. */
export async function runQuery(
	context: QueryContext,
	requests: Record<string, unknown>[],
	options: QueryOptions,
): Promise<string> {
	const mode = options.mode ?? (options.json ? "json" : "text");
	const paths = context.root ? createPaths(context.root) : undefined;
	const resolved = await resolveNamesSettled(context.client, requests, paths);
	const results = await Promise.all(
		resolved.map(async (item) => {
			if ("error" in item) return { error: item.error };
			try {
				return { value: (await context.client.query(item.request)).value };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error), cause: error };
			}
		}),
	);
	if (requests.length === 1 && "error" in results[0]) throw results[0].cause ?? new Error(results[0].error);
	if (mode === "raw")
		return results
			.map((result) =>
				JSON.stringify(
					"error" in result ? { type: requests[results.indexOf(result)].type, error: result.error } : result.value,
				),
			)
			.join("\n");
	const models = await Promise.all(
		results.map((result, index) =>
			"error" in result
				? ({ type: String(requests[index].type), error: result.error, tsconfig: context.tsconfig } as GraphResult)
				: normalizeResult(requests[index], result.value, context.ranges, paths),
		),
	);
	for (const model of models) if (context.tsconfig) model.tsconfig = context.tsconfig;
	for (const model of models) model.nestedProjects = context.nestedProjects ?? [];
	const filtered = options.in
		? models.map((model) => {
				if (model.error) return model;
				const directory = paths
					? paths.inputToRepositoryPath(options.in!)
					: context.root && isAbsolute(options.in!)
						? relative(context.root, options.in!)
						: options.in!;
				return filterIn(
					model,
					directory === ".." || directory.startsWith(`..${sep}`) || isAbsolute(directory) ? "\0" : directory,
				);
			})
		: models;
	if (mode === "json") return JSON.stringify(filtered);
	const formatted = filtered.map((result) =>
		result.error ? `error: ${result.error}` : renderText(result, { color: options.color === true }),
	);
	const output =
		formatted.length === 1
			? formatted[0]
			: formatted.map((value, index) => `=== ${index + 1}: ${models[index].type} ===\n${value}`).join("\n\n");
	return context.nestedProjects?.length
		? `${output}\nnote: graphed ${context.tsconfig ?? "tsconfig.json"} (${context.projectFileCount ?? 0} files); nested projects: ${context.nestedProjects.slice(0, 5).join(", ")}. Run from one of those for its code.`
		: output;
}
