// Talk to the live @ttsc/graph MCP tool and translate its request schema and validation errors.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveGraphBinary } from "@ttsc/graph";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Project } from "./project.ts";

export interface RequestField {
	name: string;
	required: boolean;
	description?: string;
	values?: string[];
}

export interface RequestType {
	type: string;
	description?: string;
	fields: RequestField[];
}

export interface QueryResult {
	/** The upstream result, unchanged: `structuredContent` when present, otherwise `content`. */
	value: unknown;
	isError: boolean;
}

export class RequestError extends Error {}

export interface GraphClient {
	requestTypes(): RequestType[];
	query(request: Record<string, unknown>): Promise<QueryResult>;
	batch(requests: Record<string, unknown>[]): Promise<QueryResult[]>;
	close(): Promise<void>;
}

export interface StartOptions {
	stderr?: number | "ignore";
	cacheDirectory?: string;
}

interface Schema {
	type?: string;
	const?: string;
	enum?: string[];
	anyOf?: Schema[];
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	$defs?: Record<string, Schema>;
}

const require = createRequire(import.meta.url);
const graphPackage = require.resolve("@ttsc/graph/package.json");
const graphVersion = (require("@ttsc/graph/package.json") as { version: string }).version;
const graphExecutable = join(dirname(graphPackage), "lib/bin.js");
const packageDirectory = join(import.meta.dir, "..");
const wrapperError = `server rejected generated wrapper fields; @ttsc/graph ${graphVersion} may have changed its request schema`;

function enumValues(schema: Schema): string[] | undefined {
	const values =
		schema.enum ??
		(schema.const === undefined
			? schema.anyOf?.flatMap((branch) => (branch.const === undefined ? [] : [branch.const]))
			: [schema.const]);
	return values?.length ? values : undefined;
}

function readRequestTypes(schema: Schema): RequestType[] {
	return Object.entries(schema.$defs ?? {})
		.filter(([name]) => name.endsWith("IRequest"))
		.map(([, definition]) => {
			const type = enumValues(definition.properties?.type ?? {})?.[0];
			if (!type) throw new Error("graph request definition has no type");
			return {
				type,
				description: definition.description,
				fields: Object.entries(definition.properties ?? {})
					.filter(([name]) => name !== "type")
					.map(([name, field]) => ({
						name,
						required: definition.required?.includes(name) ?? false,
						...(field.description === undefined ? {} : { description: field.description }),
						...(enumValues(field) === undefined ? {} : { values: enumValues(field) }),
					})),
			};
		})
		.toSorted((a, b) => a.type.localeCompare(b.type));
}

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
	let value: unknown = input;
	for (const part of path.match(/[^.[\]]+/g) ?? []) {
		if (value === null || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

function shown(value: unknown): string {
	if (value === undefined) return "undefined";
	return JSON.stringify(value) ?? String(value);
}

/** Map typia's validation annotations from an upstream error result. */
export function mapUpstreamError(content: unknown, input: Record<string, unknown>): RequestError | undefined {
	const issues: { path: string; expected: string }[] = [];
	if (!Array.isArray(content)) return undefined;
	const text: string[] = [];
	for (const block of content) {
		if (
			!block ||
			typeof block !== "object" ||
			!("type" in block) ||
			block.type !== "text" ||
			!("text" in block) ||
			typeof block.text !== "string"
		)
			continue;
		text.push(block.text);
		for (const match of block.text.matchAll(/\/\/ ❌ (\[[^\r\n]*\])/g)) {
			try {
				const parsed: unknown = JSON.parse(match[1]);
				if (!Array.isArray(parsed)) continue;
				for (const issue of parsed) {
					if (
						issue &&
						typeof issue === "object" &&
						"path" in issue &&
						"expected" in issue &&
						typeof issue.path === "string" &&
						typeof issue.expected === "string"
					) {
						issues.push({ path: issue.path.replace(/^\$input\./, ""), expected: issue.expected });
					}
				}
			} catch {
				// A non-validation text result remains an upstream error result.
			}
		}
	}
	if (
		issues.some(({ path }) => path === "question" || path === "draft" || path.startsWith("draft.") || path === "review")
	)
		return new RequestError(wrapperError);
	const requestIssues = issues.filter(({ path }) => path.startsWith("request."));
	if (!requestIssues.length) return text.length ? new RequestError(text.join("\n")) : undefined;
	return new RequestError(
		requestIssues
			.map(({ path, expected }) => `${path} must be ${expected} (got ${shown(valueAtPath(input, path))})`)
			.join("\n"),
	);
}

/** Start a Bun process running the installed graph MCP server for a project. */
export async function startGraphClient(project: Project, options: StartOptions = {}): Promise<GraphClient> {
	const binary = resolveGraphBinary(process.env, packageDirectory);
	if (!binary) throw new Error("@ttsc/graph native binary was not found");
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [graphExecutable, "--cwd", project.root, "--tsconfig", project.tsconfig],
		cwd: project.root,
		env: {
			...process.env,
			TTSC_GRAPH_BINARY: binary,
			...(process.env.TTSC_CACHE_DIR === undefined && options.cacheDirectory
				? { TTSC_CACHE_DIR: options.cacheDirectory }
				: {}),
		},
		stderr: options.stderr ?? "ignore",
	});
	const client = new Client({ name: "sightread", version: "0.0.0" });
	let schema: Schema;
	try {
		await client.connect(transport);
		const { tools } = await client.listTools();
		const tool = tools.find((item) => "request" in (item.inputSchema.properties ?? {}));
		if (!tool) throw new Error("@ttsc/graph exposes no tool with a request property");
		schema = tool.inputSchema as Schema;
		const types = readRequestTypes(schema);
		const definitions = schema.$defs ?? {};
		const graphClient: GraphClient = {
			requestTypes: () => types,
			query: async (request) => {
				const selected = types.find((item) => item.type === request.type);
				if (!selected) throw new RequestError("unknown request type; run sightread --help");
				const definition = Object.entries(definitions).find(
					([name, item]) =>
						name.endsWith("IRequest") && enumValues(item.properties?.type ?? {})?.includes(selected.type),
				)?.[1];
				const missing = selected.fields.filter((field) => field.required && request[field.name] === undefined);
				if (missing.length)
					throw new RequestError(
						missing
							.map(
								(field) =>
									`request.${field.name} must be ${definition?.properties?.[field.name]?.type ?? "value"} (got undefined)`,
							)
							.join("\n"),
					);
				const input = {
					question: typeof request.query === "string" ? request.query : JSON.stringify(request),
					draft: { type: request.type, reason: "Use the requested graph operation." },
					review: "The requested operation fits the question.",
					request,
				};
				const result = await client.callTool({ name: tool.name, arguments: input });
				if (result.isError) {
					const mapped = mapUpstreamError(result.content, input);
					if (mapped) throw mapped;
				}
				return {
					value: "structuredContent" in result ? result.structuredContent : result.content,
					isError: result.isError === true,
				};
			},
			batch: (requests) => Promise.all(requests.map((request) => graphClient.query(request))),
			close: () => client.close(),
		};
		return graphClient;
	} catch (error) {
		await client.close();
		throw error;
	}
}
