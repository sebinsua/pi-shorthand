import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";

interface TypeScriptServer {
	root: string;
	process: ChildProcessWithoutNullStreams;
	connection: MessageConnection;
	files: Map<string, string>;
}

let current: TypeScriptServer | undefined;
let operations = Promise.resolve();
process.once("exit", disposeCurrent);

export async function withTypeScriptServer<T>(
	root: string,
	use: (connection: MessageConnection) => Promise<T>,
): Promise<T> {
	const result = operations.then(async () => {
		const projectRoot = realpathSync(root);
		if (current?.root === projectRoot) {
			if (!sameFiles(current.files, projectFiles(projectRoot))) disposeCurrent();
		} else {
			disposeCurrent();
		}
		if (!current) {
			current = await startTypeScriptServer(projectRoot);
		}
		const server = current;
		setReferenced(server, true);
		try {
			return await use(server.connection);
		} finally {
			if (current === server) setReferenced(server, false);
		}
	});
	operations = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** Keep a reused server current; a failed notification only forfeits reuse of that server. */
export async function notifyTypeScriptServer(
	connection: MessageConnection,
	method: string,
	params: unknown,
): Promise<void> {
	try {
		await connection.sendNotification(method, params);
	} catch {
		if (current?.connection === connection) disposeCurrent();
	}
}

export function recordTypeScriptFiles(connection: MessageConnection, files: string[]): void {
	if (current?.connection !== connection) return;
	for (const file of files) {
		const value = fingerprint(file);
		if (value) current.files.set(file, value);
		else current.files.delete(file);
	}
}

async function startTypeScriptServer(root: string): Promise<TypeScriptServer> {
	const server = spawn(typeScriptExecutable(), ["--lsp", "--stdio"], { cwd: root, env: process.env });
	await new Promise<void>((ready, reject) => {
		server.once("spawn", ready);
		server.once("error", reject);
	});
	const connection = createMessageConnection(
		new StreamMessageReader(server.stdout),
		new StreamMessageWriter(server.stdin),
	);
	connection.listen();
	try {
		await connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			capabilities: {
				workspace: {
					workspaceEdit: { documentChanges: true },
					fileOperations: { didRename: true, willRename: true },
				},
				textDocument: { rename: { prepareSupport: true } },
			},
		});
		await connection.sendNotification("initialized", {});
	} catch (error) {
		connection.dispose();
		if (server.exitCode === null) server.kill("SIGKILL");
		throw error;
	}
	server.stderr.resume();
	const started = { root, process: server, connection, files: projectFiles(root) };
	server.once("exit", () => {
		if (current?.process !== server) return;
		connection.dispose();
		current = undefined;
	});
	setReferenced(started, false);
	return started;
}

function sameFiles(left: Map<string, string>, right: Map<string, string>): boolean {
	return left.size === right.size && [...left].every(([file, signature]) => right.get(file) === signature);
}

function projectFiles(root: string): Map<string, string> {
	// The runner only applies Git-visible files, so ignored build output cannot make reuse stale.
	const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	});
	if (listed.status === 0) {
		return new Map(
			listed.stdout
				.split("\0")
				.filter((file) => file && /\.(?:[cm]?[jt]sx?|json)$/.test(file))
				.flatMap((file) => {
					const absolute = resolvePath(root, file);
					const value = fingerprint(absolute);
					return value ? [[absolute, value] as const] : [];
				}),
		);
	}

	const files = new Map<string, string>();
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const file = resolvePath(directory, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) {
				files.set(file, fingerprint(file)!);
			}
		}
	};
	visit(root);
	return files;
}

function fingerprint(file: string): string | undefined {
	const stats = statSync(file, { bigint: true, throwIfNoEntry: false });
	return stats?.isFile() ? `${stats.mtimeNs}:${stats.size}` : undefined;
}

function setReferenced(server: TypeScriptServer, referenced: boolean): void {
	const method = referenced ? "ref" : "unref";
	server.process[method]();
	for (const stream of [server.process.stdin, server.process.stdout, server.process.stderr])
		(stream as unknown as Record<typeof method, () => void>)[method]?.();
	process.removeListener("beforeExit", disposeCurrent);
	if (!referenced) process.once("beforeExit", disposeCurrent);
}

function disposeCurrent(): void {
	if (!current) return;
	const { connection, process: server } = current;
	current = undefined;
	connection.dispose();
	if (server.exitCode === null) server.kill("SIGKILL");
	server.unref();
}

function typeScriptExecutable(): string {
	const require = createRequire(import.meta.url);
	const typescriptPackage = require.resolve("typescript/package.json");
	const requireTypeScriptDependency = createRequire(typescriptPackage);
	const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
	const packageFile = requireTypeScriptDependency.resolve(nativePackage);
	return resolvePath(dirname(packageFile), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
}
