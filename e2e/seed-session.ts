/** Construct controlled recovery context without copying private reasoning from prior sessions. */
import { randomUUID } from "node:crypto";
import type { JsonEvent } from "./harness.ts";

export function seedSession(
	messages: JsonEvent[],
	cwd: string,
	extension: string,
): { header: JsonEvent; entries: JsonEvent[] } {
	if (!Array.isArray(messages) || !messages.length) throw new Error("Recovery seed must contain messages");
	const substitute = (value: unknown): any => {
		if (typeof value === "string") return value.replaceAll("{{fixture}}", cwd).replaceAll("{{extension}}", extension);
		if (Array.isArray(value)) return value.map(substitute);
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
		return value;
	};
	const pending = new Set<string>();
	let parentId: string | null = null;
	const entries = messages.map((message): JsonEvent => {
		if (!["user", "assistant", "toolResult"].includes(message.role)) throw new Error("Unsupported seed message role");
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!["text", "toolCall"].includes(block.type)) throw new Error("Seed content must be text or tool calls");
				if (block.type === "toolCall") {
					if (message.role !== "assistant" || !block.id || pending.has(block.id))
						throw new Error("Invalid seed tool call");
					pending.add(block.id);
				}
			}
		}
		if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("Unmatched seed tool result");
		}
		const id = randomUUID().slice(0, 8);
		const entry = { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message: substitute(message) };
		parentId = id;
		return entry;
	});
	if (pending.size) throw new Error("Seed contains unresolved tool calls");
	if (messages.at(-1)?.role !== "toolResult" || !messages.at(-1)?.isError)
		throw new Error("Recovery seed must end with a failed tool result");
	return {
		header: { type: "session", version: 3, id: randomUUID(), timestamp: new Date(0).toISOString(), cwd },
		entries,
	};
}
