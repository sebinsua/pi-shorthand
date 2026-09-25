// Check batch ordering, empty results, and output modes.
import { expect, test } from "bun:test";
import { runQuery } from "../src/query.ts";
import type { RangeIndex } from "../src/ranges.ts";
import type { GraphClient, QueryResult } from "../src/upstream.ts";

const values = [{ result: { type: "lookup", hits: [] }, audit: "keep" }, [{ type: "text", text: "second" }]];
const ranges: RangeIndex = {
	declarations: async () => undefined,
	rangesFor: async () => undefined,
	close: async () => {},
};
const client: GraphClient = {
	requestTypes: () => [],
	query: async (request): Promise<QueryResult> => {
		if (request.type === "lookup") await Bun.sleep(25);
		return { value: request.type === "lookup" ? values[0] : values[1], isError: false };
	},
	batch: async (requests) => Promise.all(requests.map((request) => client.query(request))),
	close: async () => {},
};
const requests = [{ type: "lookup" }, { type: "escape" }];

test("batch returns input order with numbered headers", async () => {
	expect(await runQuery({ client, ranges }, requests, { json: false })).toBe(
		"=== 1: lookup ===\nlookup: 0 shown\n\n(none)\n\n=== 2: escape ===\nescape: 0 shown\n\n(none)",
	);
});

test("a single request has no header", async () => {
	expect(await runQuery({ client, ranges }, requests.slice(0, 1), { json: false })).toBe("lookup: 0 shown\n\n(none)");
});

test("JSON prints models and raw preserves upstream values", async () => {
	const models = JSON.parse(await runQuery({ client, ranges }, requests, { mode: "json" })) as {
		type: string;
		shown: number;
	}[];
	expect(models.map(({ type, shown }) => [type, shown])).toEqual([
		["lookup", 0],
		["escape", 0],
	]);
	expect(await runQuery({ client, ranges }, requests, { mode: "raw" })).toBe(
		values.map((value) => JSON.stringify(value)).join("\n"),
	);
});

test("unchanged input is byte deterministic", async () => {
	const first = await runQuery({ client, ranges }, requests, { mode: "text" });
	expect(await runQuery({ client, ranges }, requests, { mode: "text" })).toBe(first);
});
