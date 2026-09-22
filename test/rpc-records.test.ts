import { expect, test } from "bun:test";
import { encodeRpcRecord, RpcRecords } from "../rpc-records.ts";

function fragment(value: string, last: boolean): Buffer {
	const wire = encodeRpcRecord(Buffer.from(value));
	if (!last) wire.writeUInt32BE(wire.readUInt32BE() & 0x7fffffff);
	return wire;
}

test("RPC records survive every single TCP split point", () => {
	const wire = Buffer.concat([fragment("abc", false), fragment("def", true), fragment("next", true)]);
	for (let split = 0; split <= wire.length; split++) {
		const decoder = new RpcRecords();
		const records = [...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))];
		expect(records.map((record) => record.toString())).toEqual(["abcdef", "next"]);
		decoder.finish();
	}
});

test("RPC records tolerate bytewise delivery and empty fragments", () => {
	const decoder = new RpcRecords();
	const wire = Buffer.concat([fragment("", false), fragment("a", false), fragment("", true), fragment("", true)]);
	const records = [...wire].flatMap((byte) => decoder.push(Buffer.from([byte])));
	expect(records.map((record) => record.toString())).toEqual(["a", ""]);
	decoder.finish();
});

test("RPC decoder rejects truncated headers, bodies and unterminated records", () => {
	for (const wire of [Buffer.from([0]), fragment("body", true).subarray(0, 6), fragment("body", false)]) {
		const decoder = new RpcRecords();
		decoder.push(wire);
		expect(() => decoder.finish()).toThrow("truncated");
		expect(() => decoder.push(fragment("later", true))).toThrow();
	}
});

test("RPC size limits apply across fragments before buffering their payloads", () => {
	const decoder = new RpcRecords(5);
	decoder.push(fragment("abc", false));
	expect(() => decoder.push(fragment("def", true).subarray(0, 4))).toThrow("limits");
	expect(() => decoder.finish()).toThrow();
	const emptyFlood = new RpcRecords(5, 2);
	expect(() => emptyFlood.push(Buffer.concat(Array.from({ length: 3 }, () => fragment("", false))))).toThrow("limits");
});

test("RPC decoder retains owned data and refuses input after EOF", () => {
	const decoder = new RpcRecords();
	const first = fragment("abc", false);
	decoder.push(first);
	first.fill(0);
	expect(decoder.push(fragment("d", true))[0].toString()).toBe("abcd");
	decoder.finish();
	expect(() => decoder.push(Buffer.alloc(0))).toThrow("closed");
});
