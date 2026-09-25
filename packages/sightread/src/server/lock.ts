// Serialize server starts with a directory lock and remove locks left by dead holders.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function withStartLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
	const until = Date.now() + 15_000;
	await mkdir(join(directory, ".."), { recursive: true });
	while (true) {
		try {
			await mkdir(directory);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let pid = 0;
			try {
				pid = Number(await readFile(join(directory, "pid"), "utf8"));
			} catch {
				// A competing process may still be writing the holder file.
			}
			const age = Date.now() - (await stat(directory)).mtimeMs;
			if ((pid > 0 && !running(pid)) || (pid === 0 && age > 1_000)) {
				await rm(directory, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= until) throw new Error("server start lock timed out; retry", { cause: error });
			await pause(100);
		}
	}
	try {
		await writeFile(join(directory, "pid"), String(process.pid));
		return await action();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
