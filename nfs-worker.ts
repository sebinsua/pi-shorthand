/** Keep the NFS service off the runner's event loop: mount I/O can block that loop. */
/* eslint-disable unicorn/require-post-message-target-origin -- node worker_threads has no browser targetOrigin. */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FilesystemEntry } from "./runner.ts";
import { openNfsProxy } from "./nfs-proxy.ts";
import { TransactionJournal } from "./transaction-journal.ts";
import { diagnosticCounter, measure } from "./diagnostics.ts";

interface FinishedObservation {
	conflicts: string[];
	entries: number;
	captures: number;
}

interface Options {
	root: string;
	backendPort: number;
	requestTimeoutMs: number;
}
type Request =
	| { id: number; method: "original" | "originalKind" | "originalFiles"; file: string }
	| { id: number; method: "finish" };
type Response = { id: number; value?: unknown; failureReason?: string };

export interface NfsObservation {
	port: number;
	original(file: string): Promise<FilesystemEntry | null>;
	originalKind(file: string): ReturnType<TransactionJournal["originalKind"]>;
	originalFiles(file: string): Promise<string[]>;
	/** Unmount first. Closes observation, validates baselines, and stops the worker. */
	finish(): Promise<string[]>;
	/** Cancellation permanently discards observation; never permits an apply. */
	abort(): Promise<void>;
}

export async function openNfsObservation(options: Options): Promise<NfsObservation> {
	const worker = new Worker(new URL(import.meta.url), { workerData: options });
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let nextId = 1;
	let stopped = false;
	let finishing = false;
	let failure: Error | undefined;
	let finishPromise: Promise<string[]> | undefined;
	let readyResolve!: (port: number) => void;
	let readyReject!: (error: Error) => void;
	const ready = new Promise<number>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const fail = (error: Error) => {
		failure ??= error;
		readyReject(failure);
		for (const operation of pending.values()) operation.reject(failure);
		pending.clear();
	};
	worker.on("error", fail);
	worker.on("exit", () => {
		if (!stopped) fail(new Error("NFS observation worker exited unexpectedly"));
	});
	worker.on("message", (response: Response) => {
		if (response.id === 0) {
			if (response.failureReason) fail(new Error(response.failureReason));
			else if (typeof response.value === "number") readyResolve(response.value);
			else fail(new Error("Invalid NFS worker startup response"));
			return;
		}
		const operation = pending.get(response.id);
		if (!operation) {
			fail(new Error("Unmatched NFS worker response"));
			return;
		}
		pending.delete(response.id);
		if (response.failureReason) {
			const error = new Error(response.failureReason);
			operation.reject(error);
			fail(error);
		} else operation.resolve(response.value);
	});
	const request = (message: Omit<Request, "id"> & { file?: string }): Promise<unknown> => {
		if (failure) return Promise.reject(failure);
		if (stopped) return Promise.reject(new Error("NFS observer is stopped"));
		if (finishing && message.method !== "finish") return Promise.reject(new Error("NFS observer is finishing"));
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			worker.postMessage({ ...message, id });
		});
	};
	let port: number;
	try {
		port = await ready;
	} catch (error) {
		await worker.terminate();
		throw error;
	}
	const finishAndStop = async (): Promise<string[]> => {
		let conflicts: string[];
		try {
			const result = (await measure("finishing NFS observation and validating dependencies", () =>
				request({ method: "finish" }),
			)) as FinishedObservation;
			diagnosticCounter("observed entries", result.entries);
			diagnosticCounter("content captures", result.captures);
			conflicts = result.conflicts;
		} finally {
			stopped = true;
			await worker.terminate();
		}
		// Abort can arrive while termination is in progress, after validation replied.
		if (failure) throw failure;
		return conflicts;
	};
	return {
		port,
		async original(file) {
			return (await request({ method: "original", file })) as FilesystemEntry | null;
		},
		async originalKind(file) {
			return (await request({ method: "originalKind", file })) as Awaited<
				ReturnType<TransactionJournal["originalKind"]>
			>;
		},
		async originalFiles(file) {
			return (await request({ method: "originalFiles", file })) as string[];
		},
		finish() {
			finishing = true;
			finishPromise ??= finishAndStop();
			return finishPromise;
		},
		async abort() {
			fail(new Error("NFS observation was cancelled"));
			stopped = true;
			await worker.terminate();
		},
	};
}

if (!isMainThread) {
	const options = workerData as Options;
	const journal = new TransactionJournal(options.root);
	try {
		const proxy = await openNfsProxy(options.backendPort, journal, { requestTimeoutMs: options.requestTimeoutMs });
		let queue = Promise.resolve();
		parentPort!.on("message", (request: Request) => {
			queue = queue.then(async () => {
				try {
					let value: unknown;
					if (request.method === "original") value = await journal.original(request.file);
					else if (request.method === "originalKind") value = await journal.originalKind(request.file);
					else if (request.method === "originalFiles") value = await journal.originalFiles(request.file);
					else if (request.method === "finish") {
						await proxy.close();
						await journal.seal();
						value = {
							conflicts: await journal.conflicts(),
							entries: journal.entryCount,
							captures: journal.contentCaptureCount,
						} satisfies FinishedObservation;
					} else throw new Error("Unknown NFS observer operation");
					parentPort!.postMessage({ id: request.id, value });
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					journal.invalidate(reason);
					parentPort!.postMessage({ id: request.id, value: null, failureReason: reason });
				}
			});
		});
		parentPort!.postMessage({ id: 0, value: proxy.port });
	} catch (error) {
		parentPort!.postMessage({ id: 0, failureReason: error instanceof Error ? error.message : String(error) });
	}
}
