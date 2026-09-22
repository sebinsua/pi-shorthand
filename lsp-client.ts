import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";

export async function withTypeScriptServer<T>(
	root: string,
	use: (connection: MessageConnection) => Promise<T>,
): Promise<T> {
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
				workspace: { workspaceEdit: { documentChanges: true } },
				textDocument: { rename: { prepareSupport: true } },
			},
		});
		connection.sendNotification("initialized", {});
		return await use(connection);
	} finally {
		connection.dispose();
		if (server.exitCode === null) {
			// The server is private to this operation. TypeScript 7 closes its stream during a
			// graceful LSP shutdown, so terminate it directly instead.
			server.kill("SIGKILL");
			server.unref();
		}
	}
}

function typeScriptExecutable(): string {
	const require = createRequire(import.meta.url);
	const typescriptPackage = require.resolve("typescript/package.json");
	const requireTypeScriptDependency = createRequire(typescriptPackage);
	const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
	const packageFile = requireTypeScriptDependency.resolve(nativePackage);
	return resolvePath(dirname(packageFile), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
}
