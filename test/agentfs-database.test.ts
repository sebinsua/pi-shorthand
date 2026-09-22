import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { createAgentFsDatabase } from "../agentfs-database.ts";
import type { RunResult } from "../runner.ts";

const binary = process.env.AGENTFS_BIN ?? Bun.which("agentfs");
const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "shorthand-agentfs-template-")));
	temporary.push(root);
	const repo = path.join(root, "repo");
	const cache = path.join(root, "cache");
	await fs.mkdir(repo);
	await fs.mkdir(cache, { mode: 0o700 });
	return { root, repo, cache };
}

test.skipIf(process.platform !== "darwin" || !binary)(
	"AgentFS template gives each transaction an independent database",
	async () => {
		const { root, repo, cache } = await fixture();
		const firstDir = path.join(root, "first");
		const secondDir = path.join(root, "second");
		await fs.mkdir(firstDir);
		await fs.mkdir(secondDir);
		const firstPath = await createAgentFsDatabase(binary!, repo, firstDir, cache);
		const first = new Database(firstPath);
		first.run("CREATE TABLE transaction_only (value TEXT)");
		first.close();
		await fs.writeFile(path.join(repo, "arrived-later.txt"), "new source content");
		const secondPath = await createAgentFsDatabase(binary!, repo, secondDir, cache);
		const second = new Database(secondPath, { readonly: true });
		try {
			expect(second.query("SELECT value FROM fs_overlay_config WHERE key = 'base_path'").get()).toEqual({
				value: repo,
			});
			expect(second.query("SELECT name FROM sqlite_master WHERE name = 'transaction_only'").all()).toEqual([]);
			expect(await fs.readdir(cache)).toHaveLength(1);
		} finally {
			second.close();
		}
	},
);

test.skipIf(process.platform !== "darwin" || !binary)(
	"AgentFS template is keyed to checkout identity and rejects incomplete cache",
	async () => {
		const { root, repo, cache } = await fixture();
		const other = path.join(root, "other");
		const firstDir = path.join(root, "first");
		const secondDir = path.join(root, "second");
		const damagedDir = path.join(root, "damaged");
		for (const directory of [other, firstDir, secondDir, damagedDir]) await fs.mkdir(directory);
		await createAgentFsDatabase(binary!, repo, firstDir, cache);
		const otherPath = await createAgentFsDatabase(binary!, other, secondDir, cache);
		const otherDb = new Database(otherPath, { readonly: true });
		try {
			expect(otherDb.query("SELECT value FROM fs_overlay_config WHERE key = 'base_path'").get()).toEqual({
				value: other,
			});
		} finally {
			otherDb.close();
		}
		const templates = await fs.readdir(cache);
		expect(templates).toHaveLength(2);
		for (const template of templates) {
			const database = new Database(path.join(cache, template, "run.db"), { readonly: true });
			const base = database.query("SELECT value FROM fs_overlay_config WHERE key = 'base_path'").get() as {
				value: string;
			};
			database.close();
			if (base.value === repo) await fs.rm(path.join(cache, template, "run.db"));
		}
		await expect(createAgentFsDatabase(binary!, repo, damagedDir, cache)).rejects.toThrow(
			"Incomplete AgentFS database template",
		);
	},
);

test.skipIf(process.platform !== "darwin" || !binary)(
	"failed initialization leaves no published template",
	async () => {
		const { root, repo, cache } = await fixture();
		const executable = path.join(root, "failing-agentfs");
		const destination = path.join(root, "transaction");
		await fs.writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		await fs.mkdir(destination);
		await expect(createAgentFsDatabase(executable, repo, destination, cache)).rejects.toThrow();
		expect(await fs.readdir(cache)).toEqual([]);
	},
);

test.skipIf(process.platform !== "darwin" || !binary)("symlinked template is rejected", async () => {
	const { root, repo, cache } = await fixture();
	const first = path.join(root, "first");
	const next = path.join(root, "next");
	await fs.mkdir(first);
	await fs.mkdir(next);
	await createAgentFsDatabase(binary!, repo, first, cache);
	const [key] = await fs.readdir(cache);
	const template = path.join(cache, key!);
	await fs.rm(template, { recursive: true });
	await fs.symlink(path.join(first, ".agentfs"), template);
	await expect(createAgentFsDatabase(binary!, repo, next, cache)).rejects.toThrow("Unsafe AgentFS database template");
});

test.skipIf(process.platform !== "darwin" || !binary)(
	"wrong-base and nonempty templates cannot start a transaction",
	async () => {
		const { root, repo, cache } = await fixture();
		const first = path.join(root, "first");
		await fs.mkdir(first);
		await createAgentFsDatabase(binary!, repo, first, cache);
		const [key] = await fs.readdir(cache);
		const templateDb = path.join(cache, key!, "run.db");
		const corrupt = new Database(templateDb);
		corrupt.run("UPDATE fs_overlay_config SET value = ? WHERE key = 'base_path'", [path.join(root, "other")]);
		corrupt.close();
		await fs.rm(`${templateDb}-shm`, { force: true });
		const wrongBase = path.join(root, "wrong-base");
		await fs.mkdir(wrongBase);
		await expect(createAgentFsDatabase(binary!, repo, wrongBase, cache)).rejects.toThrow(
			"AgentFS template has the wrong base",
		);
		const dirty = new Database(templateDb);
		dirty.run("UPDATE fs_overlay_config SET value = ? WHERE key = 'base_path'", [repo]);
		dirty.run("INSERT INTO fs_whiteout (path, created_at) VALUES ('/hidden', 0)");
		dirty.close();
		await fs.rm(`${templateDb}-shm`, { force: true });
		const privateState = path.join(root, "private-state");
		await fs.mkdir(privateState);
		await expect(createAgentFsDatabase(binary!, repo, privateState, cache)).rejects.toThrow(
			"AgentFS template contains private fs_whiteout state",
		);
	},
);

test.skipIf(process.platform !== "darwin" || !binary)("unexpected AgentFS sidecars are rejected", async () => {
	const { root, repo, cache } = await fixture();
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	await fs.mkdir(first);
	await fs.mkdir(second);
	await createAgentFsDatabase(binary!, repo, first, cache);
	const [key] = await fs.readdir(cache);
	await fs.writeFile(path.join(cache, key!, "run.db-info"), "remote marker", { mode: 0o600 });
	await expect(createAgentFsDatabase(binary!, repo, second, cache)).rejects.toThrow(
		"Unsafe AgentFS database template entry",
	);
});

test.skipIf(process.platform !== "darwin" || !binary)(
	"replacing executable or checkout creates a new template",
	async () => {
		const { root, repo, cache } = await fixture();
		const executable = path.join(root, "agentfs-wrapper");
		const wrapper = `#!/bin/sh\nexec ${JSON.stringify(binary)} "$@"\n`;
		await fs.writeFile(executable, wrapper, { mode: 0o700 });
		for (let attempt = 0; attempt < 3; attempt++) {
			const destination = path.join(root, `transaction-${attempt}`);
			await fs.mkdir(destination);
			await createAgentFsDatabase(executable, repo, destination, cache);
			if (attempt === 0) {
				await fs.writeFile(executable, `${wrapper}\n`);
			} else if (attempt === 1) {
				await fs.rename(repo, path.join(root, "old-repo"));
				await fs.mkdir(repo);
			}
		}
		expect(await fs.readdir(cache)).toHaveLength(3);
	},
);

test.skipIf(process.platform !== "darwin" || !binary)(
	"cached AgentFS reads current checkout content and permissions",
	async () => {
		const { repo } = await fixture();
		const runner = path.resolve(import.meta.dir, "../runner.ts");
		await fs.writeFile(path.join(repo, "input.txt"), "first");
		await fs.writeFile(path.join(repo, "output.txt"), "0");
		const init = Bun.spawn(["git", "init", "-q"], { cwd: repo });
		expect(await init.exited).toBe(0);
		const first = async (expected: string, mode: number, output: string) => {
			const program = `const fs = await import("node:fs/promises");
if (await Bun.file("input.txt").text() !== ${JSON.stringify(expected)}) throw new Error("stale content");
if (((await fs.stat("input.txt")).mode & 0o777) !== ${mode}) throw new Error("stale mode");
await Bun.write("output.txt", ${JSON.stringify(output)});`;
			const child = Bun.spawn([process.execPath, runner], {
				stdin: new Response(JSON.stringify({ cwd: repo, program, rollback: "all", timeoutMs: 5000 })),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, stderr).toBe(0);
			const result = JSON.parse(stdout) as RunResult;
			expect(result.exitCode).toBe(0);
			expect(result.applied).toContain("output.txt");
		};
		await first("first", 0o644, "1");
		await fs.writeFile(path.join(repo, "input.txt"), "second");
		await fs.chmod(path.join(repo, "input.txt"), 0o600);
		await fs.writeFile(path.join(repo, "added.txt"), "new");
		await first("second", 0o600, "2");
		await fs.rm(path.join(repo, "added.txt"));
		await first("second", 0o600, "3");
		expect(await Bun.file(path.join(repo, "output.txt")).text()).toBe("3");
	},
);
