/**
 * macOS has no mount namespaces, so for the length of a run:
 * 1. the repository is renamed to <repo>.pi-base, and an empty directory takes its place;
 * 2. .git and large ignored directories (node_modules, …) are moved to <repo>.pi-shared and
 *    symlinked back, so reading them bypasses the overlay (AgentFS copies every file it opens);
 * 3. AgentFS serves an overlay of the base over NFS, mounted at the repository's path;
 * 4. the program runs under sandbox-exec, which stops it writing to the base or to .git.
 * close() puts everything back. <repo>.pi-shared doubles as a lock: another run on the same repository
 * waits for this one, and if a run crashed part-way, the next one puts everything back first.
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { Overlay } from "./runner.ts";

interface Dirs {
	repo: string;
	base: string; // the real files, while the overlay is mounted
	shared: string; // .git and large ignored directories, while the overlay is mounted
}

export async function openMacOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const agentfs = process.env.AGENTFS_BIN ?? Bun.which("agentfs");
	if (!agentfs) throw new Error("The code tool needs AgentFS: curl -fsSL https://agentfs.ai/install | bash");

	const dirs = { repo, base: `${repo}.pi-base`, shared: `${repo}.pi-shared` };
	await takeLock(dirs);
	try {
		const shared = await moveAside(dirs);
		const database = await createDatabase(agentfs, dirs.base, tempDir);
		await serveAndMount(agentfs, database, dirs);

		return {
			originalDir: dirs.base,
			writableDir: repo,
			// The shared entries are symlinks now, which patterns like "node_modules/" don't match.
			// ._* are the AppleDouble files macOS writes on NFS, where it can't store extended attributes.
			gitExcludes: ["._*", ...shared.map((entry) => `/${entry}`)],
			wrap: (command) => ["/usr/bin/sandbox-exec", "-p", sandboxProfile(dirs), ...command],
			changes: () => changesInDatabase(agentfs, database, dirs),
			close: () => restore(dirs),
		};
	} catch (error) {
		await restore(dirs);
		throw error;
	}
}

/**
 * Creating a directory is atomic, so whoever creates <repo>.pi-shared owns the repository until
 * restore() removes it. Waits while another run is alive; repairs a run that crashed.
 */
async function takeLock(dirs: Dirs) {
	for (let attempt = 0; attempt < 3000; attempt++) {
		try {
			await fs.mkdir(dirs.shared);
			await writeState(dirs, { runnerPid: process.pid, shared: [] });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const state = await readState(dirs).catch(() => null);
		const crashed = state ? !isAlive(state.runnerPid) : await olderThan(dirs.shared, 1000);
		if (crashed) await restore(dirs);
		else await Bun.sleep(20);
	}
	throw new Error("Another code run on this repository didn't finish within a minute.");
}

/** Steps 1 and 2. Records what it did in <repo>.pi-shared/state.json, so restore() can undo it. */
async function moveAside(dirs: Dirs): Promise<string[]> {
	const shared = await listSharedEntries(dirs.repo);
	await writeState(dirs, { ...(await readState(dirs)), shared });

	await fs.rename(dirs.repo, dirs.base);
	await fs.mkdir(dirs.repo);
	for (const entry of shared) {
		await fs.mkdir(path.dirname(path.join(dirs.shared, entry)), { recursive: true });
		await fs.rename(path.join(dirs.base, entry), path.join(dirs.shared, entry));
		await fs.symlink(path.join(dirs.shared, entry), path.join(dirs.base, entry));
	}
	return shared;
}

/** .git, plus ignored directories (the top-most ones) that don't contain tracked files. */
async function listSharedEntries(repo: string): Promise<string[]> {
	const [ignoredOutput, trackedOutput] = await Promise.all([
		$`git ls-files -z --others --ignored --exclude-standard --directory`.cwd(repo).text(),
		$`git ls-files -z`.cwd(repo).text(),
	]);
	const ignoredDirs = ignoredOutput.split("\0").filter((entry) => entry.endsWith("/"));
	const tracked = trackedOutput.split("\0");

	const shared = [".git"];
	for (const dir of ignoredDirs.map((entry) => entry.slice(0, -1)).toSorted()) {
		const insideShared = shared.some((entry) => dir.startsWith(`${entry}/`));
		const containsTracked = tracked.some((file) => file.startsWith(`${dir}/`));
		if (!insideShared && !containsTracked) shared.push(dir);
	}
	return shared;
}

/**
 * An empty overlay database. `agentfs init` takes ~150 ms, so it runs once per repository to make
 * a template, and each run gets an instant copy-on-write clone of that.
 */
async function createDatabase(agentfs: string, base: string, tempDir: string): Promise<string> {
	const templateDir = path.join(homedir(), ".cache", "pi-code", Bun.hash(base).toString(16));
	const templateFiles = path.join(templateDir, ".agentfs"); // where `agentfs init` puts them
	if (!(await Bun.file(path.join(templateFiles, "template.db")).exists())) {
		await fs.mkdir(templateDir, { recursive: true });
		await $`${agentfs} init template --base ${base}`.cwd(templateDir).quiet();
	}

	await cloneDatabase(templateFiles, "template.db", tempDir, "run.db");
	return path.join(tempDir, "run.db");
}

/** Step 3. */
async function serveAndMount(agentfs: string, database: string, dirs: Dirs) {
	const port = freePort();
	const server = Bun.spawn([agentfs, "nfs", database, "--port", String(port)], { stdout: "ignore", stderr: "ignore" });
	await writeState(dirs, { ...(await readState(dirs)), serverPid: server.pid });
	await waitForPort(port);

	const options = `locallocks,vers=3,tcp,port=${port},mountport=${port},soft,timeo=100,retrans=5`;
	await $`/sbin/mount_nfs -o ${options} 127.0.0.1:/ ${dirs.repo}`.quiet();
}

/** Step 4: allow everything except writing to the original files or to .git. */
function sandboxProfile(dirs: Dirs): string {
	return [
		"(version 1)",
		"(allow default)",
		`(deny file-write* (subpath ${JSON.stringify(dirs.base)}))`,
		`(deny file-write* (subpath ${JSON.stringify(path.join(dirs.shared, ".git"))}))`,
	].join("\n");
}

/**
 * `agentfs diff` lists what's in the overlay (including files that were only read). The server
 * keeps the database locked, so this diffs a copy-on-write snapshot of it.
 */
async function changesInDatabase(agentfs: string, database: string, dirs: Dirs) {
	const snapshotDir = path.join(path.dirname(database), "snapshot");
	await cloneDatabase(path.dirname(database), "run.db", snapshotDir, "run.db");
	const output = await $`${agentfs} diff ${path.join(snapshotDir, "run.db")}`.quiet().text();

	const changes: { file: string; contents: Uint8Array | null }[] = [];
	for (const line of output.split("\n")) {
		// e.g. "M f /src/a.ts", "A f /src/new.ts", "D ? /src/old.ts"
		const match = line.match(/^([AMD]) (\S) \/(.+)$/);
		if (!match || path.basename(match[3]).startsWith("._")) continue; // AppleDouble files
		const [, change, type, file] = match;

		if (change !== "D" && type === "f") changes.push({ file, contents: await readFile(path.join(dirs.repo, file)) });
		if (change === "D") {
			for (const deleted of await filesUnder(path.join(dirs.base, file))) {
				changes.push({ file: path.join(file, deleted), contents: null });
			}
		}
	}
	return changes;
}

/** The files under a path relative to it: [""] for a file, everything inside for a directory. */
async function filesUnder(original: string): Promise<string[]> {
	const stats = await fs.lstat(original).catch(() => null);
	if (!stats?.isDirectory()) return [""];
	return fs.readdir(original, { recursive: true });
}

/** Unmounts, stops the server, renames everything back and releases the lock. */
async function restore(dirs: Dirs) {
	if (!(await exists(dirs.shared))) return;
	const state = await readState(dirs).catch((): State => ({ runnerPid: 0, shared: [] }));

	await $`umount -f ${dirs.repo}`.nothrow().quiet(); // -f: a leftover subprocess may still have files open
	if (state.serverPid) {
		try {
			process.kill(state.serverPid);
		} catch {
			// already stopped
		}
	}

	if (await exists(dirs.base)) {
		for (const entry of state.shared) {
			if (!(await exists(path.join(dirs.shared, entry)))) continue;
			await fs.rm(path.join(dirs.base, entry), { force: true }); // the symlink
			await fs.rename(path.join(dirs.shared, entry), path.join(dirs.base, entry));
		}
		await fs.rmdir(dirs.repo).catch(() => {}); // the empty mountpoint
		await fs.rename(dirs.base, dirs.repo);
	}

	// Never delete <repo>.pi-shared recursively: during a run it holds the real node_modules and .git.
	await fs.rm(path.join(dirs.shared, "state.json"), { force: true });
	await removeEmptyDirectories(dirs.shared);
}

// ── Small helpers ─────────────────────────────────────────────────────────────────

interface State {
	runnerPid: number;
	shared: string[];
	serverPid?: number;
}

function readState(dirs: Dirs): Promise<State> {
	return Bun.file(path.join(dirs.shared, "state.json")).json();
}

async function writeState(dirs: Dirs, state: State) {
	await Bun.write(path.join(dirs.shared, "state.json"), JSON.stringify(state));
}

/** Copy-on-write clones a database with its -wal/-shm files, renaming it. */
async function cloneDatabase(fromDir: string, fromName: string, toDir: string, toName: string) {
	await fs.mkdir(toDir, { recursive: true });
	for (const file of await fs.readdir(fromDir)) {
		if (!file.startsWith(fromName)) continue;
		await Bun.write(path.join(toDir, file.replace(fromName, toName)), Bun.file(path.join(fromDir, file)));
	}
}

async function removeEmptyDirectories(dir: string) {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) await removeEmptyDirectories(path.join(dir, entry.name));
	}
	await fs.rmdir(dir); // fails, leaving everything, if it isn't empty
}

/** A regular file's contents, or null if there's no regular file there. */
async function readFile(file: string): Promise<Uint8Array | null> {
	const stats = await fs.lstat(file).catch(() => null);
	return stats?.isFile() ? Bun.file(file).bytes() : null;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // signal 0 only checks the process exists
		return true;
	} catch {
		return false;
	}
}

async function olderThan(file: string, ms: number): Promise<boolean> {
	const stats = await fs.stat(file).catch(() => null);
	return !stats || Date.now() - stats.mtimeMs > ms;
}

async function exists(file: string): Promise<boolean> {
	return (await fs.lstat(file).catch(() => null)) !== null;
}

function freePort(): number {
	const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	listener.stop(true);
	return listener.port;
}

async function waitForPort(port: number) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		try {
			const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
			socket.end();
			return;
		} catch {
			await Bun.sleep(2); // not listening yet
		}
	}
	throw new Error("AgentFS's NFS server didn't start.");
}
