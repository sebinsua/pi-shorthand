/** Reuse only pristine, never-mounted AgentFS databases; each run gets independent copies. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { Database } from "bun:sqlite";

async function ownedDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
		throw new Error(`Unsafe AgentFS template directory: ${directory}`);
}

async function templateKey(agentfs: string, repo: string): Promise<string> {
	const executable = await fs.stat(agentfs, { bigint: true });
	const repository = await fs.stat(repo, { bigint: true });
	// Do not tie the template to checkout contents: it contains schema and the base
	// path, not source files. Replacing either the executable or root invalidates it.
	return createHash("sha256")
		.update(
			JSON.stringify(
				[
					1,
					process.getuid?.(),
					process.getgid?.(),
					agentfs,
					executable.dev,
					executable.ino,
					executable.size,
					executable.mtimeNs,
					executable.ctimeNs,
					repo,
					repository.dev,
					repository.ino,
				],
				(_, value) => (typeof value === "bigint" ? String(value) : value),
			),
		)
		.digest("hex");
}

async function copyTemplate(template: string, destination: string): Promise<void> {
	const directory = await fs.lstat(template);
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		directory.uid !== process.getuid?.() ||
		directory.mode & 0o077
	)
		throw new Error("Unsafe AgentFS database template");
	const names = await fs.readdir(template);
	if (!names.includes("run.db")) throw new Error("Incomplete AgentFS database template");
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });
	for (const name of names) {
		const source = path.join(template, name);
		const stat = await fs.lstat(source);
		if (
			!(name === "run.db" || name === "run.db-wal") ||
			!stat.isFile() ||
			stat.uid !== process.getuid?.() ||
			stat.mode & 0o077 ||
			stat.nlink !== 1
		)
			throw new Error("Unsafe AgentFS database template entry");
		// No hardlinks: serving a transaction must never mutate the template.
		await fs.copyFile(source, path.join(destination, name), constants.COPYFILE_EXCL);
	}
}

/** Inspect the private copy, so SQLite never opens or modifies the shared template. */
function validateEmptyDatabase(file: string, repo: string): void {
	const db = new Database(file, { readonly: true, strict: true });
	try {
		const base = db.query("SELECT value FROM fs_overlay_config WHERE key = 'base_path'").get() as
			| { value: string }
			| undefined;
		const root = db.query("SELECT mode, uid, gid FROM fs_inode WHERE ino = 1").get() as
			| { mode: number; uid: number; gid: number }
			| undefined;
		if (
			base?.value !== repo ||
			!root ||
			(root.mode & 0o170000) !== 0o040000 ||
			root.uid !== process.getuid?.() ||
			root.gid !== process.getgid?.()
		)
			throw new Error("AgentFS template has the wrong base or root identity");
		for (const table of ["fs_dentry", "fs_whiteout", "fs_origin", "fs_data", "fs_symlink", "kv_store", "tool_calls"]) {
			const count = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
			if (count.count !== 0) throw new Error(`AgentFS template contains private ${table} state`);
		}
		const inodes = db.query("SELECT COUNT(*) AS count FROM fs_inode").get() as { count: number };
		if (inodes.count !== 1) throw new Error("AgentFS template contains private inode state");
	} finally {
		db.close();
	}
}

export async function createAgentFsDatabase(
	agentfs: string,
	base: string,
	tempDir: string,
	cache = path.join(homedir(), ".cache", "pi-shorthand", "agentfs-templates"),
): Promise<string> {
	const executable = await fs.realpath(Bun.which(agentfs) ?? agentfs);
	const repo = await fs.realpath(base);
	await ownedDirectory(cache);
	const key = await templateKey(executable, repo);
	const template = path.join(cache, key);
	const existing = await fs.lstat(template).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return null;
	});
	if (!existing) {
		const staging = await fs.mkdtemp(path.join(cache, ".initializing-"));
		try {
			await $`${executable} init run --base ${repo}`.cwd(staging).quiet();
			if (key !== (await templateKey(executable, repo)))
				throw new Error("AgentFS or repository changed during initialization");
			const database = path.join(staging, ".agentfs");
			await fs.chmod(database, 0o700);
			for (const name of await fs.readdir(database)) await fs.chmod(path.join(database, name), 0o600);
			// Publish only after the initializing process has exited, including its
			// database sidecars. Concurrent creators can safely use the winner.
			await fs.rename(database, template).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
			});
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	}
	const destination = path.join(tempDir, ".agentfs");
	await copyTemplate(template, destination);
	validateEmptyDatabase(path.join(destination, "run.db"), repo);
	if (key !== (await templateKey(executable, repo)))
		throw new Error("AgentFS or repository changed while preparing the transaction database");
	return path.join(destination, "run.db");
}
