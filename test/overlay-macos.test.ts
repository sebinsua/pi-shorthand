import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { agentFsChangeRecords, sandboxProfile } from "../overlay-macos.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test.skipIf(process.platform !== "darwin")(
	"macOS denies direct connections to observer and backend ports",
	async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "shorthand-port-policy-")));
		temporary.push(root);
		const blocked = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const allowed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		try {
			const reachable = await Bun.connect({ hostname: "127.0.0.1", port: blocked.port, socket: { data() {} } });
			reachable.end();
			const profile = sandboxProfile(
				path.join(root, "repo"),
				path.join(root, "internal"),
				path.join(root, "mount"),
				path.join(root, "state", "file"),
				[],
				path.join(root, "canary"),
				path.join(root, "helper", "file"),
				path.join(root, "scratch"),
				[blocked.port],
			);
			const code = `const socket = {data(){}};
let rejected = false;
try { const client = await Bun.connect({hostname:"127.0.0.1",port:${blocked.port},socket}); client.end(); }
catch(error) { if (!["EPERM","EACCES","ECONNREFUSED"].includes(error.code)) throw error; rejected = true; }
if (!rejected) throw new Error("protected port accessible");
const client = await Bun.connect({hostname:"127.0.0.1",port:${allowed.port},socket}); client.end();`;
			const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "-e", code], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(child.stderr).text();
			expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
		} finally {
			blocked.stop(true);
			allowed.stop(true);
		}
	},
);

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

// Exercise the actual kernel policy without requiring an AgentFS installation.
test.skipIf(process.platform !== "darwin")("macOS restricts direct and symlink writes to private roots", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "shorthand-seatbelt-")));
	temporary.push(root);
	const [repo, internal, mount, scratch, outside, recovery, helper] = [
		"live",
		"internal",
		"mount",
		"scratch",
		"outside",
		"recovery",
		"helper",
	].map((name) => path.join(root, name));
	for (const directory of [repo!, internal!, mount!, scratch!, outside!, recovery!, helper!]) await mkdir(directory);
	await mkdir(path.join(mount!, ".git"));
	const victim = path.join(outside!, "victim");
	await Bun.write(victim, "original");
	await symlink(outside!, path.join(mount!, "external"));
	await symlink(victim, path.join(mount!, "external-file"));
	await symlink(scratch!, path.join(mount!, "scratch-link"));
	const profile = sandboxProfile(
		repo!,
		internal!,
		mount!,
		path.join(recovery!, "state"),
		[],
		path.join(internal!, "canary"),
		path.join(helper!, "cleanup"),
		scratch!,
	);
	const blocked = [
		victim,
		path.join(outside!, "new"),
		path.join(mount!, "external/victim"),
		path.join(mount!, "external-file"),
		path.join(mount!, ".git/config"),
		path.join(repo!, "file"),
		path.join(internal!, "file"),
		path.join(recovery!, "file"),
		path.join(helper!, "file"),
	];
	const program = `
		const fs = require("node:fs");
		for (const target of ${JSON.stringify(blocked)}) {
			let denied = false;
			try { fs.writeFileSync(target, "modified"); } catch (error) {
				if (!["EPERM", "EACCES"].includes(error.code)) throw error;
				denied = true;
			}
			if (!denied) throw new Error("write allowed: " + target);
		}
		fs.writeFileSync(${JSON.stringify(path.join(mount!, "allowed"))}, "workspace");
		fs.writeFileSync(${JSON.stringify(path.join(mount!, "scratch-link/allowed"))}, "scratch");
		fs.writeFileSync("/dev/null", "discard");
	`;
	const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "-e", program], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = await new Response(child.stderr).text();
	expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
	expect(await Bun.file(victim).text()).toBe("original");
	expect(await Bun.file(path.join(mount!, "allowed")).text()).toBe("workspace");
	expect(await Bun.file(path.join(scratch!, "allowed")).text()).toBe("scratch");
});
