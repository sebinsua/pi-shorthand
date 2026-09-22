import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { openNfsProxy } from "../nfs-proxy.ts";
import { encodeRpcRecord, RpcRecords } from "../rpc-records.ts";
import { TransactionJournal } from "../transaction-journal.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function words(...values: number[]): Buffer {
	const buffer = Buffer.alloc(values.length * 4);
	values.forEach((value, i) => buffer.writeUInt32BE(value, i * 4));
	return buffer;
}
const call = (xid: number) => words(xid, 0, 2, 100003, 3, 0, 0, 0, 0, 0);
const reply = (xid: number) => words(xid, 1, 0, 0, 0, 0);

async function fixture(respond: (message: Buffer, socket: Socket) => void, timeout = 1000) {
	const sockets = new Set<Socket>();
	const backend = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		const decoder = new RpcRecords();
		socket.on("data", (chunk) => {
			for (const message of decoder.push(Buffer.from(chunk))) respond(message, socket);
		});
	});
	backend.listen(0, "127.0.0.1");
	await once(backend, "listening");
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => backend.close(() => resolve()));
	});
	const address = backend.address();
	if (!address || typeof address === "string") throw new Error("missing test port");
	const journal = new TransactionJournal("/unused-null-rpc-test-root");
	const proxy = await openNfsProxy(address.port, journal, { requestTimeoutMs: timeout });
	cleanups.push(() => proxy.close().catch(() => {}));
	const connect = async () => {
		const client = createConnection({ host: "127.0.0.1", port: proxy.port });
		client.on("error", () => {});
		await once(client, "connect");
		cleanups.push(async () => {
			client.destroy();
		});
		return client;
	};
	return { journal, proxy, connect };
}

test("NFS proxy forwards fragmented calls and validates replies before delivery", async () => {
	const { proxy, journal, connect } = await fixture((message, socket) => {
		socket.write(encodeRpcRecord(reply(message.readUInt32BE())));
	});
	const client = await connect();
	const response = once(client, "data");
	const request = encodeRpcRecord(call(10));
	client.write(request.subarray(0, 3));
	client.write(request.subarray(3));
	const [wire] = await response;
	expect(new RpcRecords().push(wire)[0]).toEqual(reply(10));
	await proxy.close();
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("NFS proxy rejects mismatched replies without delivering them", async () => {
	const { journal, connect } = await fixture((_message, socket) => {
		socket.write(encodeRpcRecord(reply(999)));
	});
	const client = await connect();
	let received = false;
	client.on("data", () => {
		received = true;
	});
	const closed = once(client, "close");
	client.write(encodeRpcRecord(call(10)));
	await closed;
	expect(received).toBe(false);
	await expect(journal.seal()).rejects.toThrow("unmatched");
});

test("NFS proxy times out a missing response and poisons the journal", async () => {
	const { journal, connect } = await fixture(() => {}, 25);
	const client = await connect();
	const closed = once(client, "close");
	client.write(encodeRpcRecord(call(10)));
	await closed;
	await expect(journal.seal()).rejects.toThrow("timed out");
});

test("NFS proxy rejects truncated client records", async () => {
	const { journal, connect } = await fixture(() => {});
	const client = await connect();
	const closed = once(client, "close");
	client.end(Buffer.from([0, 0]));
	await closed;
	await expect(journal.seal()).rejects.toThrow("truncated");
});

test("NFS proxy serializes calls across separate clients", async () => {
	const seen: number[] = [];
	let release: (() => void) | undefined;
	let firstSeen!: () => void;
	const arrived = new Promise<void>((resolve) => {
		firstSeen = resolve;
	});
	const { proxy, journal, connect } = await fixture((message, socket) => {
		const xid = message.readUInt32BE();
		seen.push(xid);
		if (xid === 1) {
			release = () => socket.write(encodeRpcRecord(reply(xid)));
			firstSeen();
		} else socket.write(encodeRpcRecord(reply(xid)));
	});
	const first = await connect();
	const second = await connect();
	const firstReply = once(first, "data");
	const secondReply = once(second, "data");
	first.write(encodeRpcRecord(call(1)));
	await arrived;
	second.write(encodeRpcRecord(call(2)));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(seen).toEqual([1]);
	release!();
	await Promise.all([firstReply, secondReply]);
	expect(seen).toEqual([1, 2]);
	await proxy.close();
	await journal.seal();
});

test("NFS proxy rejects extra complete or partial replies", async () => {
	for (const trailing of [encodeRpcRecord(reply(10)), Buffer.from([0, 0])]) {
		const { journal, connect } = await fixture((_message, socket) => {
			socket.write(Buffer.concat([encodeRpcRecord(reply(10)), trailing]));
		});
		const client = await connect();
		const closed = once(client, "close");
		client.write(encodeRpcRecord(call(10)));
		await closed;
		await expect(journal.seal()).rejects.toThrow("extra");
	}
});

test("NFS proxy rejects backend traffic while idle", async () => {
	let backendSocket: Socket | undefined;
	const { journal, connect } = await fixture((message, socket) => {
		backendSocket = socket;
		socket.write(encodeRpcRecord(reply(message.readUInt32BE())));
	});
	const client = await connect();
	const response = once(client, "data");
	client.write(encodeRpcRecord(call(10)));
	await response;
	const closed = once(client, "close");
	backendSocket!.write(encodeRpcRecord(reply(10)));
	await closed;
	await expect(journal.seal()).rejects.toThrow("unsolicited");
});

test("NFS proxy concurrent closes share teardown completion", async () => {
	const { proxy, journal, connect } = await fixture(() => {});
	await connect();
	const first = proxy.close();
	const second = proxy.close();
	expect(first).toBe(second);
	await Promise.all([first, second]);
	await journal.seal();
});

test("NFS close drains an accepted request and its reply before sealing", async () => {
	let arrived!: () => void;
	const accepted = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	let release!: () => void;
	const { proxy, journal, connect } = await fixture((message, socket) => {
		release = () => socket.write(encodeRpcRecord(reply(message.readUInt32BE())));
		arrived();
	});
	const client = await connect();
	const response = once(client, "data");
	client.write(encodeRpcRecord(call(41)));
	await accepted;
	const closing = proxy.close();
	release();
	const [wire] = await response;
	expect(new RpcRecords().push(wire)[0]).toEqual(reply(41));
	await closing;
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("NFS close still rejects a pending request that never completes", async () => {
	let arrived!: () => void;
	const accepted = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const { proxy, journal, connect } = await fixture(() => arrived(), 25);
	const client = await connect();
	client.write(encodeRpcRecord(call(42)));
	await accepted;
	await expect(proxy.close()).rejects.toThrow("timed out");
	await expect(journal.seal()).rejects.toThrow("timed out");
});

test.each([false, true])("NFS proxy finishes a half-closed client's reply (closing proxy: %s)", async (closeEarly) => {
	let arrived!: () => void;
	const accepted = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	let release!: () => void;
	const { proxy, journal, connect } = await fixture((message, socket) => {
		release = () => socket.write(encodeRpcRecord(reply(message.readUInt32BE())));
		arrived();
	});
	const client = await connect();
	const received: Buffer[] = [];
	client.on("data", (chunk) => received.push(Buffer.from(chunk)));
	const closed = once(client, "close");
	client.end(encodeRpcRecord(call(43)));
	await accepted;
	// Let the request-side FIN arrive while the backend reply is still pending.
	await new Promise((resolve) => setTimeout(resolve, 20));
	const closing = closeEarly ? proxy.close() : undefined;
	release();
	if (closing) await closing;
	await closed;
	await proxy.close();
	expect(new RpcRecords().push(Buffer.concat(received))).toEqual([reply(43)]);
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("NFS proxy still rejects a mismatched reply after the client half-closes", async () => {
	const { proxy, journal, connect } = await fixture((_message, socket) => {
		setTimeout(() => socket.write(encodeRpcRecord(reply(999))), 20);
	});
	const client = await connect();
	let received = false;
	client.on("data", () => {
		received = true;
	});
	const closed = once(client, "close");
	client.end(encodeRpcRecord(call(44)));
	await closed;
	expect(received).toBe(false);
	await expect(proxy.close()).rejects.toThrow("unmatched");
	await expect(journal.seal()).rejects.toThrow("unmatched");
});

test("NFS observation failure returns a definite RPC error and never forwards later calls", async () => {
	let forwarded = 0;
	const { proxy, journal, connect } = await fixture(() => {
		forwarded++;
	});
	const client = await connect();
	// Unsupported procedure poisons observation before reaching the backend.
	for (const xid of [31, 32]) {
		const response = once(client, "data");
		const request = call(xid);
		if (xid === 31) request.writeUInt32BE(999, 20);
		client.write(encodeRpcRecord(request));
		const [wire] = await response;
		expect(new RpcRecords().push(wire)[0]).toEqual(words(xid, 1, 0, 0, 0, 5));
	}
	expect(forwarded).toBe(0);
	await expect(proxy.close()).rejects.toThrow();
	await expect(journal.seal()).rejects.toThrow();
});
