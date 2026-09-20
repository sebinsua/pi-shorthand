import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { seedSession } from "../e2e/seed-session.ts";

const messages = [
	{ role: "user", content: "Original task" },
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "code",
				arguments: { program: "unchanged", path: "{{fixture}}/source.ts" },
			},
		],
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "code",
		content: [{ type: "text", text: "{{extension}}/prelude.ts: error" }],
		isError: true,
	},
];

test("recovery seed loads as ordered Pi context and substitutes paths without changing the source template", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-seed-test-"));
	try {
		const seed = seedSession(messages, root, '/extension with "quotes"');
		const file = path.join(root, "session.jsonl");
		await writeFile(file, [seed.header, ...seed.entries].map((entry) => JSON.stringify(entry)).join("\n"));
		const session = SessionManager.open(file);
		const context = session.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(JSON.stringify(context.messages)).toContain(root + "/source.ts");
		expect(JSON.stringify(messages)).toContain("{{fixture}}");
		expect(seed.entries[2].parentId).toBe(seed.entries[1].id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("recovery seed rejects incomplete or mismatched tool exchanges and private reasoning", () => {
	expect(() => seedSession(messages.slice(0, 2), "/fixture", "/extension")).toThrow("unresolved");
	expect(() => seedSession([messages[0], messages[2]], "/fixture", "/extension")).toThrow("Unmatched");
	expect(() =>
		seedSession(
			[{ role: "assistant", content: [{ type: "thinking", thinking: "not seed material" }] }],
			"/fixture",
			"/extension",
		),
	).toThrow("text or tool calls");
});
