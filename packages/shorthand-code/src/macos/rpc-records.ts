/** Incremental RPC-over-TCP record marking (RFC 5531 section 11). */
import { IncompleteObservationError } from "../transaction/transaction-journal.ts";

export class RpcRecords {
	private readonly header = Buffer.alloc(4);
	private headerBytes = 0;
	private remaining = 0;
	private last = false;
	private fragments = 0;
	private bytes = 0;
	private payload: Buffer = Buffer.alloc(0);
	private pieces: Buffer[] = [];
	private failed = false;
	private ended = false;

	get incomplete(): boolean {
		return this.headerBytes !== 0 || this.fragments !== 0;
	}

	constructor(
		private readonly maxBytes = 8 * 1024 * 1024,
		private readonly maxFragments = 1024,
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFragments) || maxFragments < 1)
			throw new Error("Invalid RPC record limits");
	}

	/** Returned records own their bytes; callers may reuse incoming socket buffers. */
	push(chunk: Buffer): Buffer[] {
		if (this.failed || this.ended) throw new IncompleteObservationError("RPC decoder is closed");
		const records: Buffer[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			if (this.headerBytes < 4) {
				const count = Math.min(4 - this.headerBytes, chunk.length - offset);
				chunk.copy(this.header, this.headerBytes, offset, offset + count);
				this.headerBytes += count;
				offset += count;
				if (this.headerBytes < 4) break;
				const marker = this.header.readUInt32BE();
				this.last = (marker & 0x80000000) !== 0;
				this.remaining = marker & 0x7fffffff;
				this.fragments++;
				if (this.fragments > this.maxFragments || this.remaining > this.maxBytes - this.bytes)
					this.reject("RPC record exceeds observation limits");
				this.payload = Buffer.allocUnsafe(this.remaining);
			}
			const count = Math.min(this.remaining, chunk.length - offset);
			if (count) {
				chunk.copy(this.payload, this.payload.length - this.remaining, offset, offset + count);
				this.bytes += count;
				this.remaining -= count;
				offset += count;
			}
			if (this.remaining === 0) {
				if (this.payload.length) this.pieces.push(this.payload);
				this.payload = Buffer.alloc(0);
				this.headerBytes = 0;
				if (this.last) {
					records.push(Buffer.concat(this.pieces, this.bytes));
					this.pieces = [];
					this.bytes = 0;
					this.fragments = 0;
				}
			}
		}
		return records;
	}

	finish(): void {
		if (this.failed) throw new IncompleteObservationError("RPC decoder failed");
		this.ended = true;
		if (this.headerBytes || this.fragments) this.reject("truncated RPC stream");
	}

	private reject(reason: string): never {
		this.failed = true;
		this.pieces = [];
		throw new IncompleteObservationError(reason);
	}
}

export function encodeRpcRecord(record: Buffer): Buffer {
	if (record.length > 0x7fffffff) throw new IncompleteObservationError("oversized RPC record");
	const header = Buffer.alloc(4);
	header.writeUInt32BE((record.length | 0x80000000) >>> 0);
	return Buffer.concat([header, record]);
}
