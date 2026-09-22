/** Local observation transport; AgentFS remains the NFS implementation. */
import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { NfsObserver } from "./nfs-observer.ts";
import { encodeRpcRecord, RpcRecords } from "./rpc-records.ts";
import { IncompleteObservationError, TransactionJournal } from "./transaction-journal.ts";

async function* records(socket: Socket, invalid: (error: unknown) => void): AsyncGenerator<Buffer> {
	const decoder = new RpcRecords();
	try {
		for await (const chunk of socket) {
			for (const record of decoder.push(Buffer.from(chunk))) yield record;
		}
	} finally {
		try {
			decoder.finish();
		} catch (error) {
			invalid(error);
		}
	}
}

function write(socket: Socket, message: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.write(encodeRpcRecord(message), (error) => (error ? reject(error) : resolve()));
	});
}

/** A definite RPC error avoids kernel retry delays after observation rejects an operation. */
function systemError(request: Buffer): Buffer {
	if (request.length < 4) throw new IncompleteObservationError("missing RPC transaction id");
	const reply = Buffer.alloc(24);
	[request.readUInt32BE(), 1, 0, 0, 0, 5].forEach((value, index) => reply.writeUInt32BE(value, index * 4));
	return reply;
}

export interface NfsProxy {
	port: number;
	/** After unmounting. Drains accepted requests; broken/incomplete transport rejects the transaction. */
	close(): Promise<void>;
}

export async function openNfsProxy(
	backendPort: number,
	journal: TransactionJournal,
	options: { requestTimeoutMs: number; maxClients?: number },
): Promise<NfsProxy> {
	const { requestTimeoutMs, maxClients = 16 } = options;
	if (
		!Number.isSafeInteger(requestTimeoutMs) ||
		requestTimeoutMs < 1 ||
		!Number.isSafeInteger(maxClients) ||
		maxClients < 1
	)
		throw new Error("Invalid NFS proxy limits");
	const observer = new NfsObserver(journal);
	const upstream = createConnection({ host: "127.0.0.1", port: backendPort });
	const clients = new Set<Socket>();
	const tasks = new Set<Promise<void>>();
	let closing = false;
	let failure: Error | undefined;
	let observationRejected = false;
	let pending = 0;
	let queue: Promise<void> = Promise.resolve();
	let awaiting: { resolve: (reply: Buffer) => void; reject: (error: Error) => void } | undefined;
	let closePromise: Promise<void> | undefined;
	const fail = (error: unknown, disconnectClients = true) => {
		failure ??= error instanceof Error ? error : new Error(String(error));
		journal.invalidate(failure.message);
		awaiting?.reject(failure);
		awaiting = undefined;
		upstream.destroy();
		if (disconnectClients) for (const client of clients) client.destroy();
	};
	upstream.on("error", fail);
	const connected = once(upstream, "connect");
	const connectionTimeout = setTimeout(() => fail(new Error("NFS backend connection timed out")), requestTimeoutMs);
	// Destruction without an error also needs to settle connection establishment.
	const closedBeforeConnect = () => fail(new Error("NFS backend closed before connection"));
	upstream.once("close", closedBeforeConnect);
	try {
		await Promise.race([
			connected,
			once(upstream, "close").then(() => {
				throw failure ?? new Error("NFS backend closed");
			}),
		]);
	} finally {
		clearTimeout(connectionTimeout);
		upstream.off("close", closedBeforeConnect);
	}
	const decoder = new RpcRecords();
	upstream.on("data", (chunk) => {
		try {
			if (!awaiting) throw new IncompleteObservationError("unsolicited NFS backend data");
			const responses = decoder.push(Buffer.from(chunk));
			if (responses.length > 1 || (responses.length === 1 && decoder.incomplete))
				throw new IncompleteObservationError("extra NFS backend response data");
			if (responses.length === 1) {
				const receiver = awaiting;
				awaiting = undefined;
				receiver.resolve(responses[0]);
			}
		} catch (error) {
			fail(error);
		}
	});
	upstream.on("close", () => {
		try {
			decoder.finish();
		} catch (error) {
			fail(error);
		}
		if ((!closing || pending) && !failure) fail(new Error("NFS backend connection lost"));
	});
	const observeAndForward = async (request: Buffer): Promise<Buffer> => {
		// A rejected observation still gets a definite RPC error, including later
		// requests already accepted from the same client.
		if (observationRejected) return systemError(request);
		if (failure) throw failure;
		const timeout = setTimeout(() => fail(new Error("NFS observation request timed out")), requestTimeoutMs);
		try {
			let validateReply: Awaited<ReturnType<NfsObserver["before"]>>;
			try {
				validateReply = await observer.before(request);
			} catch (error) {
				observationRejected = true;
				fail(error, false);
				return systemError(request);
			}
			if (failure) throw failure;
			const backendReply = new Promise<Buffer>((resolve, reject) => {
				awaiting = { resolve, reject };
			});
			const [, message] = await Promise.all([write(upstream, request), backendReply]);
			await validateReply(message);
			if (failure) throw failure;
			return message;
		} finally {
			clearTimeout(timeout);
		}
	};
	const exchange = (request: Buffer, client: Socket): Promise<void> => {
		pending++;
		const operation = queue
			.then(() => observeAndForward(request))
			.then((message) => write(client, message))
			.finally(() => {
				pending--;
			});
		queue = operation.then(() => {}, fail);
		return operation;
	};
	const server = createServer((client) => {
		if (closing) {
			client.destroy();
			return;
		}
		if (failure || clients.size >= maxClients) {
			client.destroy();
			fail(new Error("NFS proxy connection rejected"));
			return;
		}
		clients.add(client);
		client.on("error", fail);
		const task = (async () => {
			try {
				for await (const request of records(client, fail)) await exchange(request, client);
			} catch (error) {
				if (!closing) fail(error);
			} finally {
				clients.delete(client);
			}
		})();
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
	});
	server.on("error", fail);
	server.listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
	} catch (error) {
		upstream.destroy();
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("NFS proxy has no TCP address");
	return {
		port: address.port,
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
				// macOS can return from unmount before its final RPC response has
				// drained. Include response delivery in the queue, and let already
				// buffered records enter it before closing idle client connections.
				const deadline = setTimeout(() => fail(new Error("NFS shutdown drain timed out")), requestTimeoutMs);
				try {
					for (;;) {
						const drained = queue;
						await drained;
						await new Promise<void>((resolve) => setImmediate(resolve));
						if (failure || (!pending && queue === drained)) break;
					}
				} finally {
					clearTimeout(deadline);
				}
				for (const client of clients) client.destroy();
				const backendClosed = upstream.closed
					? Promise.resolve()
					: new Promise<void>((resolve) => upstream.once("close", () => resolve()));
				upstream.destroy();
				// A timeout poisons the candidate immediately, but cannot cancel an in-flight
				// filesystem baseline capture. Teardown waits for that capture to settle.
				await Promise.all([stopped, backendClosed, queue, ...tasks]);
				if (failure) throw failure;
			})();
			return closePromise;
		},
	};
}
