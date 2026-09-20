import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { agentFsChangeRecords } from "../overlay-macos.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("AgentFS change records preserve newline, tab, and Unicode paths", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "shorthand-agentfs-records-"));
	temporary.push(directory);
	const file = path.join(directory, "run.db");
	const sqlite = new Database(file, { create: true, strict: true });
	sqlite.run("CREATE TABLE fs_inode (ino INTEGER PRIMARY KEY, mode INTEGER NOT NULL)");
	sqlite.run("CREATE TABLE fs_dentry (name TEXT NOT NULL, parent_ino INTEGER NOT NULL, ino INTEGER NOT NULL)");
	sqlite.run("CREATE TABLE fs_whiteout (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
	sqlite.run("INSERT INTO fs_inode (ino, mode) VALUES (?, ?)", [2, 0o040755]);
	sqlite.run("INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)", ["src", 1, 2]);
	for (const [inode, name, mode] of [
		[3, "line\nbreak.ts", 0o100644],
		[4, "tab\tname.ts", 0o100755],
		[5, "雪.ts", 0o100644],
		[6, "link\nname", 0o120777],
	] as const) {
		sqlite.run("INSERT INTO fs_inode (ino, mode) VALUES (?, ?)", [inode, mode]);
		sqlite.run("INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)", [name, 2, inode]);
	}
	sqlite.run("INSERT INTO fs_whiteout (path, created_at) VALUES (?, 0)", ["/deleted\nname.ts"]);
	sqlite.close();

	const records = agentFsChangeRecords(file);
	expect(records).toContainEqual({ file: "src/line\nbreak.ts", type: "f", deleted: false });
	expect(records).toContainEqual({ file: "src/tab\tname.ts", type: "f", deleted: false });
	expect(records).toContainEqual({ file: "src/雪.ts", type: "f", deleted: false });
	expect(records).toContainEqual({ file: "src/link\nname", type: "l", deleted: false });
	expect(records).toContainEqual({ file: "deleted\nname.ts", deleted: true });
});
