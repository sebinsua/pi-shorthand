import { afterEach, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { openNfsObservation } from "../src/macos/nfs-worker.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture() {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	const observer = await openNfsObservation({
		root: "/unused-worker-test",
		backendPort: address.port,
		requestTimeoutMs: 1000,
	});
	cleanups.push(() => observer.abort());
	return observer;
}

test("worker finish shares completion and refuses later original requests", async () => {
	const observer = await fixture();
	const first = observer.finish();
	expect(observer.finish()).toBe(first);
	await expect(observer.original("later")).rejects.toThrow();
	expect(await first).toEqual([]);
});

test("worker cancellation cannot produce a validated candidate", async () => {
	const observer = await fixture();
	await observer.abort();
	await expect(observer.finish()).rejects.toThrow("cancelled");
	await expect(observer.original("input")).rejects.toThrow("cancelled");
});

test("worker missing before-image invalidates subsequent validation", async () => {
	const observer = await fixture();
	// Await IPC before entering Bun's rejection matcher; the matcher can starve
	// worker message delivery while waiting for a not-yet-settled rejection.
	const failure = await observer.original("uncaptured").catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toContain("no original");
	await expect(observer.finish()).rejects.toThrow("no original");
});

test("cancellation during worker teardown cannot resolve finish successfully", async () => {
	const observer = await fixture();
	const terminate = Worker.prototype.terminate;
	let entered!: () => void;
	let release!: () => void;
	const terminating = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let intercepted = false;
	const mock = spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
		const stopped = terminate.call(this);
		if (intercepted) return stopped;
		intercepted = true;
		entered();
		return stopped.then(async (code) => {
			await released;
			return code;
		});
	});
	try {
		const finishing = observer.finish().catch((error: unknown) => error);
		await terminating;
		await observer.abort();
		release();
		const failure = await finishing;
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("cancelled");
	} finally {
		release();
		mock.mockRestore();
	}
});
