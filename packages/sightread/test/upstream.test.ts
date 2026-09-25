// Verify the live graph client and upstream validation mapping.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createFixtureProject } from "./fixture.ts";
import { type GraphClient, mapUpstreamError, RequestError, startGraphClient } from "../src/upstream.ts";

const fixture = createFixtureProject({
	"src/example.ts":
		"export function greet(name: string) { return `Hi ${name}`; }\nexport function caller() { return greet('Ada'); }\nexport class Greeter { sayHello() { return caller(); } }\n",
});
let client: GraphClient;

beforeAll(async () => {
	client = await startGraphClient({ root: fixture.root, tsconfig: join(fixture.root, "tsconfig.json") });
});

afterAll(async () => {
	if (client) await client.close();
	fixture.cleanup();
});

test("reads seven request types and required fields from the live schema", () => {
	const types = client.requestTypes();
	expect(
		types.map(({ type, fields }) => [type, fields.filter((field) => field.required).map((field) => field.name)]),
	).toEqual([
		["details", ["handles"]],
		["entrypoints", ["query"]],
		["escape", ["reason"]],
		["lookup", ["query"]],
		["overview", []],
		["tour", ["reinterpretations"]],
		["trace", ["from"]],
	]);
	expect(types.find(({ type }) => type === "trace")?.fields.find(({ name }) => name === "direction")?.values).toEqual([
		"forward",
		"impact",
		"reverse",
	]);
	expect(
		types.find(({ type }) => type === "lookup")?.fields.find(({ name }) => name === "query")?.description,
	).toContain("symbol name");
});

test("lookup and trace return structured content", async () => {
	const lookup = await client.query({ type: "lookup", query: "greet" });
	const trace = await client.query({ type: "trace", from: "greet", direction: "reverse" });
	expect(lookup.isError).toBe(false);
	expect(trace.isError).toBe(false);
	expect((lookup.value as { result: { type: string; hits: { name: string }[] } }).result.type).toBe("lookup");
	expect(
		(lookup.value as { result: { hits: { name: string }[] } }).result.hits.some((hit) => hit.name === "greet"),
	).toBe(true);
	expect((trace.value as { result: { type: string; start: { name: string } } }).result).toMatchObject({
		type: "trace",
		start: { name: "greet" },
	});
});

test("batch preserves request order", async () => {
	const results = await client.batch([
		{ type: "trace", from: "caller" },
		{ type: "lookup", query: "Greeter" },
	]);
	expect(results.map(({ value }) => (value as { result: { type: string } }).result.type)).toEqual(["trace", "lookup"]);
});

test("rejects unknown types and missing required fields before sending", async () => {
	expect(client.query({ type: "absent" })).rejects.toThrow(
		new RequestError("unknown request type; run sightread --help"),
	);
	expect(client.query({ type: "lookup" })).rejects.toThrow(
		new RequestError("request.query must be string (got undefined)"),
	);
});

test("maps upstream field type and enum validation", async () => {
	expect(client.query({ type: "lookup", query: 42, limit: "bad" })).rejects.toThrow(
		new RequestError('request.query must be string (got 42)\nrequest.limit must be (number | undefined) (got "bad")'),
	);
	expect(client.query({ type: "trace", from: "greet", direction: "sideways" })).rejects.toThrow(
		/request.direction must be .* \(got "sideways"\)/,
	);
});

test("maps a wrapper field rejection", () => {
	const content = [
		{
			type: "text",
			text: '```json\n"draft": { "reason": 42, // ❌ [{"path":"$input.draft.reason","expected":"string"}]\n}\n```',
		},
	];
	const error = mapUpstreamError(content, { draft: { reason: 42 } });
	expect(error).toBeInstanceOf(RequestError);
	expect(error?.message).toBe(
		"server rejected generated wrapper fields; @ttsc/graph 0.30.4 may have changed its request schema",
	);
});

test("preserves plain upstream error text without validation annotations", () => {
	const error = mapUpstreamError([{ type: "text", text: "graph request failed: original detail" }], {});
	expect(error?.message).toBe("graph request failed: original detail");
});
