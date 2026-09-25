// Open the background graph server as a small library interface.
import { findProject } from "./project.ts";
import { connect } from "./server/client.ts";
import type { GraphResult } from "./model.ts";

export { type GraphResult, type GraphNode, type GraphEdge } from "./model.ts";

/** Connect to a project's graph; close leaves its background server available. */
export async function openGraph(options: { cwd: string }): Promise<{
	query(request: Record<string, unknown>): Promise<GraphResult>;
	query(requests: Record<string, unknown>[]): Promise<GraphResult[]>;
	close(): Promise<void>;
}> {
	const server = await connect(await findProject(options.cwd));
	let closed = false;
	async function query(request: Record<string, unknown>): Promise<GraphResult>;
	async function query(requests: Record<string, unknown>[]): Promise<GraphResult[]>;
	async function query(
		input: Record<string, unknown> | Record<string, unknown>[],
	): Promise<GraphResult | GraphResult[]> {
		if (closed) throw new Error("Graph is closed");
		const requests = Array.isArray(input) ? input : [input];
		const models = JSON.parse(await server.query(requests, { mode: "json" })) as GraphResult[];
		return Array.isArray(input) ? models : models[0];
	}
	return {
		query,
		async close() {
			closed = true;
		},
	};
}
