/**
 * macOS has no mount namespaces, so AgentFS is mounted at a private temporary path rather than at
 * the public checkout. The program runs inside that mount while editors and other host processes
 * continue to see the real repository. A stable copy is the lower tree, so neither side can change
 * what the other reads during execution; runner.ts detects destination edits before publishing.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { copyStableTree } from "./overlay-linux.ts";
import type { FilesystemEntry, Overlay } from "./runner.ts";

export async function openMacOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const agentfs = process.env.AGENTFS_BIN ?? Bun.which("agentfs");
	if (!agentfs) throw new Error("The code tool needs AgentFS: curl -fsSL https://agentfs.ai/install | bash");
	const gitMetadata = await gitMetadataDirectories(repo);

	const stateFile = await recoveryFile(repo);
	await recoverCrashedRun(stateFile);
	const base = path.join(tempDir, "base");
	const mountContainer = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "pi-shorthand-workspace-"));
	const mount = path.join(mountContainer, "repo");
	await fs.mkdir(mount);
	const state: RecoveryState = { runnerPid: process.pid, tempDir, mountContainer, mount };
	await writeRecoveryState(stateFile, state);

	try {
		await copyStableTree(repo, base);
		const database = await createDatabase(agentfs, base, tempDir);
		const server = await serveAndMount(agentfs, database, mount, async (serverPid) => {
			state.serverPid = serverPid;
			await writeRecoveryState(stateFile, state);
		});
		let closed = false;

		return {
			originalDir: base,
			writableDir: mount,
			executionDir: mount,
			gitExcludes: ["._*"],
			wrap: (command) => [
				"/usr/bin/sandbox-exec",
				"-p",
				sandboxProfile(repo, tempDir, mount, stateFile, gitMetadata),
				...command,
			],
			changes: () => changesInDatabase(agentfs, database, base, mount),
			close: async () => {
				if (closed) return;
				closed = true;
				let unmountError: unknown;
				try {
					await unmount(mount);
				} catch (error) {
					unmountError = error;
				} finally {
					server.kill();
					await server.exited;
				}
				if (unmountError) throw unmountError;
				await fs.rm(mountContainer, { recursive: true, force: true });
				await fs.rm(stateFile, { force: true });
			},
		};
	} catch (error) {
		await cleanupRecoveredRun(state, stateFile).catch(() => {});
		throw error;
	}
}

interface RecoveryState {
	runnerPid: number;
	tempDir: string;
	mountContainer: string;
	mount: string;
	serverPid?: number;
}

async function recoveryFile(repo: string): Promise<string> {
	const directory = path.join(homedir(), ".cache", "pi-shorthand", "macos-mounts");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await fs.lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid && stats.uid !== process.getuid())) {
		throw new Error(`Unsafe shorthand recovery directory: ${directory}`);
	}
	if ((stats.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
	const checkout = createHash("sha256").update(repo).digest("hex").slice(0, 16);
	return path.join(directory, `${checkout}.json`);
}

async function recoverCrashedRun(stateFile: string) {
	const state = (await Bun.file(stateFile)
		.json()
		.catch(() => null)) as RecoveryState | null;
	if (!state) return;
	await validateRecoveryState(state);
	if (isAlive(state.runnerPid)) throw new Error("Another shorthand macOS workspace is still active.");
	await cleanupRecoveredRun(state, stateFile);
}

async function cleanupRecoveredRun(state: RecoveryState, stateFile: string) {
	await validateRecoveryState(state);
	const serverIsOurs = await isExpectedServer(state);
	await $`umount -f ${state.mount}`.nothrow().quiet();
	if (state.serverPid && serverIsOurs) {
		try {
			process.kill(state.serverPid, "SIGKILL");
		} catch {
			// already stopped
		}
	}
	await fs.rm(state.mountContainer, { recursive: true, force: true });
	await fs.rm(state.tempDir, { recursive: true, force: true });
	await fs.rm(stateFile, { force: true });
}

async function validateRecoveryState(state: RecoveryState) {
	const temporaryRoot = await fs.realpath(tmpdir());
	const isOwnedTemporary = (candidate: unknown, prefix: string) => {
		if (typeof candidate !== "string" || path.resolve(candidate) !== candidate) return false;
		return path.dirname(candidate) === temporaryRoot && path.basename(candidate).startsWith(prefix);
	};
	const valid =
		Number.isSafeInteger(state.runnerPid) &&
		state.runnerPid > 0 &&
		(state.serverPid === undefined || (Number.isSafeInteger(state.serverPid) && state.serverPid > 0)) &&
		isOwnedTemporary(state.tempDir, "pi-shorthand-") &&
		isOwnedTemporary(state.mountContainer, "pi-shorthand-workspace-") &&
		state.mount === path.join(state.mountContainer, "repo");
	if (!valid) throw new Error("Refusing to clean an invalid shorthand macOS recovery record.");
}

/** A stale PID is signalled only if it is still our AgentFS process for this exact database. */
async function isExpectedServer(state: RecoveryState): Promise<boolean> {
	if (!state.serverPid) return false;
	const output = (await $`ps -ww -o uid=,command= -p ${state.serverPid}`.nothrow().quiet().text()).trim();
	if (!output) return false;
	const match = output.match(/^(\d+)\s+(.+)$/s);
	const database = path.join(state.tempDir, ".agentfs", "run.db");
	if (!match || Number(match[1]) !== process.getuid?.() || !match[2].includes(database)) {
		throw new Error("Refusing to signal a process that is not the recorded shorthand AgentFS server.");
	}
	return true;
}

async function writeRecoveryState(file: string, state: RecoveryState) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function createDatabase(agentfs: string, base: string, tempDir: string): Promise<string> {
	await $`${agentfs} init run --base ${base}`.cwd(tempDir).quiet();
	return path.join(tempDir, ".agentfs", "run.db");
}

async function serveAndMount(
	agentfs: string,
	database: string,
	mount: string,
	onSpawn: (pid: number) => Promise<void>,
) {
	const port = freePort();
	const server = Bun.spawn([agentfs, "nfs", database, "--port", String(port)], {
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		await onSpawn(server.pid);
		await waitForPort(port);
		const options = `locallocks,vers=3,tcp,port=${port},mountport=${port},soft,timeo=100,retrans=5`;
		await $`/sbin/mount_nfs -o ${options} 127.0.0.1:/ ${mount}`.quiet();
		return server;
	} catch (error) {
		server.kill();
		await server.exited;
		throw error;
	}
}

/** The program may write only to its private mount, excluding the real checkout and Git metadata. */
function sandboxProfile(
	repo: string,
	tempDir: string,
	mount: string,
	stateFile: string,
	gitMetadata: string[],
): string {
	return [
		"(version 1)",
		"(allow default)",
		`(deny file-read* (subpath ${JSON.stringify(repo)}))`,
		`(deny file-write* (subpath ${JSON.stringify(repo)}))`,
		`(deny file-write* (subpath ${JSON.stringify(tempDir)}))`,
		`(deny file-write* (subpath ${JSON.stringify(path.dirname(stateFile))}))`,
		`(deny file-write* (subpath ${JSON.stringify(path.join(mount, ".git"))}))`,
		...gitMetadata.map((directory) => `(deny file-write* (subpath ${JSON.stringify(directory)}))`),
	].join("\n");
}

/** Resolve both per-worktree and common Git storage before entering the private checkout. */
async function gitMetadataDirectories(repo: string): Promise<string[]> {
	const [gitDirOutput, commonDirOutput] = await Promise.all([
		$`git rev-parse --absolute-git-dir`.cwd(repo).text(),
		$`git rev-parse --git-common-dir`.cwd(repo).text(),
	]);
	const directories = [gitDirOutput, commonDirOutput]
		.map((output) => path.resolve(repo, output.trim()))
		.map((directory) => fs.realpath(directory));
	return [...new Set(await Promise.all(directories))];
}

/** Snapshot the AgentFS database while its server owns the live database lock. */
async function changesInDatabase(agentfs: string, database: string, base: string, mount: string) {
	const snapshotDir = path.join(path.dirname(path.dirname(database)), "database-snapshot");
	await cloneDatabase(path.dirname(database), "run.db", snapshotDir, "run.db");
	const output = await $`${agentfs} diff ${path.join(snapshotDir, "run.db")}`.quiet().text();

	const changes: { file: string; entry: FilesystemEntry | null }[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^([AMD]) (\S) \/(.+)$/);
		if (!match || path.basename(match[3]).startsWith("._")) continue;
		const [, change, type, file] = match;
		if (file === ".git" || file.startsWith(".git/")) continue;

		if (change !== "D" && (type === "f" || type === "l")) {
			changes.push({ file, entry: await readEntry(path.join(mount, file)) });
		}
		if (change !== "D" && type === "d") {
			const original = await fs.lstat(path.join(base, file)).catch(() => null);
			if (original && !original.isDirectory()) {
				throw new Error(`Unsupported directory replacement at ${JSON.stringify(file)}.`);
			}
		}
		if (change !== "D" && !["f", "l", "d"].includes(type)) {
			throw new Error(`Unsupported AgentFS entry type ${JSON.stringify(type)} at ${JSON.stringify(file)}.`);
		}
		if (change === "D") {
			for (const deleted of await filesUnder(path.join(base, file))) {
				changes.push({ file: path.join(file, deleted), entry: null });
			}
		}
	}
	return changes;
}

async function filesUnder(original: string): Promise<string[]> {
	const stats = await fs.lstat(original).catch(() => null);
	if (!stats) return [""];
	if (stats.isFile() || stats.isSymbolicLink()) return [""];
	if (!stats.isDirectory()) throw new Error(`Unsupported filesystem entry at ${JSON.stringify(original)}.`);
	const files: string[] = [];
	for (const entry of await fs.readdir(original, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() || entry.isSymbolicLink()) {
			files.push(path.relative(original, path.join(entry.parentPath, entry.name)));
		} else if (!entry.isDirectory()) {
			throw new Error(`Unsupported filesystem entry at ${JSON.stringify(path.join(entry.parentPath, entry.name))}.`);
		}
	}
	return files;
}

async function cloneDatabase(fromDir: string, fromName: string, toDir: string, toName: string) {
	await fs.mkdir(toDir, { recursive: true });
	for (const file of await fs.readdir(fromDir)) {
		if (!file.startsWith(fromName)) continue;
		await Bun.write(path.join(toDir, file.replace(fromName, toName)), Bun.file(path.join(fromDir, file)));
	}
}

async function readEntry(file: string): Promise<FilesystemEntry> {
	const stats = await fs.lstat(file);
	if (stats.isFile()) return { type: "file", contents: await Bun.file(file).bytes(), mode: stats.mode & 0o7777 };
	if (stats.isSymbolicLink()) return { type: "symlink", target: await fs.readlink(file) };
	throw new Error(`Unsupported filesystem entry at ${JSON.stringify(file)}.`);
}

async function unmount(mount: string) {
	const result = await $`umount -f ${mount}`.nothrow().quiet();
	if (result.exitCode !== 0)
		throw new Error(`Could not unmount the shorthand workspace: ${result.stderr.toString().trim()}`);
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
			await Bun.sleep(2);
		}
	}
	throw new Error("AgentFS's NFS server didn't start.");
}
