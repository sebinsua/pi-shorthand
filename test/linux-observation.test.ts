import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openLinuxObservation } from "../linux-observation.ts";

const temporary: string[] = [];
afterEach(async () => {
	for (const directory of temporary.splice(0)) {
		await fs.chmod(path.join(directory, "work/work"), 0o700).catch(() => {});
		await fs.rm(directory, { recursive: true, force: true });
	}
});

const linux = test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"));
async function fixture() {
	const root = await fs.mkdtemp(path.join(tmpdir(), "shorthand-native-observer-"));
	temporary.push(root);
	const repo = path.join(root, "repo"),
		upper = path.join(root, "upper"),
		work = path.join(root, "work");
	for (const directory of [repo, upper, work]) await fs.mkdir(directory);
	await Bun.write(path.join(repo, "input"), "original\n");
	const observation = await openLinuxObservation(repo, root);
	const wrap = (command: string[]) =>
		observation.wrap([
			Bun.which("bwrap")!,
			"--die-with-parent",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--unshare-pid",
			"--proc",
			"/proc",
			"--overlay-src",
			repo,
			"--overlay",
			upper,
			work,
			repo,
			"--chdir",
			repo,
			"--",
			...command,
		]);
	return { root, repo, upper, observation, wrap };
}

linux(
	"native observer captures reads and private writes through bubblewrap",
	async () => {
		const { repo, upper, observation, wrap } = await fixture();
		try {
			const child = Bun.spawn(
				wrap([process.execPath, "-e", 'await Bun.write("output", await Bun.file("input").text());']),
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = await new Response(child.stderr).text();
			expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
			expect(await Bun.file(path.join(upper, "output")).text()).toBe("original\n");
			expect(await Bun.file(path.join(repo, "output")).exists()).toBe(false);
			expect((await observation.journal.original("input"))?.type).toBe("file");
			expect(await observation.journal.original("output")).toBeNull();
			expect(await observation.finish()).toEqual([]);
		} catch (error) {
			await observation.finish().catch(() => {});
			throw error;
		}
	},
	30000,
);

linux("native observer rejects a wrapper that was never executed", async () => {
	const { observation, wrap } = await fixture();
	wrap(["true"]);
	const failure = await observation.finish().catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toContain("expected observer");
});

for (const alias of ["/proc/self/cwd/input", "/proc/thread-self/cwd/input", "link"]) {
	linux(
		`native observer resolves tracee repository alias ${alias}`,
		async () => {
			const { repo, observation, wrap } = await fixture();
			await fs.symlink("input", path.join(repo, "link"));
			try {
				const child = Bun.spawn(
					wrap([process.execPath, "-e", `console.log(await Bun.file(${JSON.stringify(alias)}).text());`]),
					{ stdout: "pipe", stderr: "pipe" },
				);
				const [output, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(output).toContain("original");
				expect((await observation.journal.original("input"))?.type).toBe("file");
				expect(await observation.finish()).toEqual([]);
			} catch (error) {
				await observation.finish().catch(() => {});
				throw error;
			}
		},
		30000,
	);
}

linux(
	"initial repository executable is observed before execution",
	async () => {
		const { repo, observation, wrap } = await fixture();
		await fs.writeFile(path.join(repo, "program"), "#!/bin/sh\nprintf captured\\n\n", { mode: 0o755 });
		try {
			const child = Bun.spawn(wrap(["./program"]), { stdout: "pipe", stderr: "pipe" });
			const stderr = await new Response(child.stderr).text();
			expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
			expect((await observation.journal.original("program"))?.type).toBe("file");
			expect(await observation.finish()).toEqual([]);
		} catch (error) {
			await observation.finish().catch(() => {});
			throw error;
		}
	},
	30000,
);

linux(
	"a staged script captures its repository interpreter through a symlink",
	async () => {
		const { repo, observation, wrap } = await fixture();
		await fs.copyFile("/bin/sh", path.join(repo, "interpreter"));
		await fs.chmod(path.join(repo, "interpreter"), 0o755);
		await fs.symlink("interpreter", path.join(repo, "interpreter-link"));
		try {
			const program = `
			await Bun.write("new-script", ${JSON.stringify(`#!${repo}/interpreter-link\nprintf captured\\n\n`)});
			await (await import("node:fs/promises")).chmod("new-script", 0o755);
			const child = Bun.spawn(["./new-script"], {stdout:"inherit", stderr:"inherit"});
			process.exitCode = await child.exited;
		`;
			const child = Bun.spawn(wrap([process.execPath, "-e", program]), { stdout: "pipe", stderr: "pipe" });
			const stderr = await new Response(child.stderr).text();
			expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
			expect((await observation.journal.original("interpreter"))?.type).toBe("file");
			expect((await observation.journal.original("interpreter-link"))?.type).toBe("symlink");
			expect(await observation.journal.original("new-script")).toBeNull();
			expect(await observation.finish()).toEqual([]);
		} catch (error) {
			await observation.finish().catch(() => {});
			throw error;
		}
	},
	30000,
);

linux(
	"openat2 special resolution rejects the whole observation before an open-only decision",
	async () => {
		const { root, repo, observation, wrap } = await fixture();
		const source = path.join(root, "openat2.c");
		const executable = path.join(root, "openat2");
		await fs.writeFile(
			source,
			`
		#define _GNU_SOURCE
		#include <fcntl.h>
		#include <linux/openat2.h>
		#include <sys/syscall.h>
		#include <unistd.h>
		int main(void) {
			int dir = open(${JSON.stringify(repo)}, O_DIRECTORY);
			struct open_how how = {.flags = O_RDONLY, .resolve = RESOLVE_IN_ROOT};
			return syscall(SYS_openat2, dir, "/input", &how, sizeof(how)) < 0;
		}
	`,
		);
		const compiler = Bun.spawn(["cc", source, "-o", executable], { stderr: "pipe" });
		expect(await compiler.exited).toBe(0);
		const child = Bun.spawn(wrap([executable]), { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).not.toBe(0);
		expect(stderr).toContain("openat2 resolve modes are unsupported");
		const failure = await observation.finish().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
	},
	30000,
);

linux(
	"an external ELF executable captures its repository-local dynamic interpreter",
	async () => {
		const { root, repo, observation, wrap } = await fixture();
		const shell = await fs.readFile("/bin/sh");
		const headers = Number(shell.readBigUInt64LE(32));
		const size = shell.readUInt16LE(54),
			count = shell.readUInt16LE(56);
		let loader = "";
		for (let i = 0; i < count; i++) {
			const offset = headers + i * size;
			if (shell.readUInt32LE(offset) !== 3) continue;
			const start = Number(shell.readBigUInt64LE(offset + 8));
			const length = Number(shell.readBigUInt64LE(offset + 32));
			loader = shell.subarray(start, start + length - 1).toString();
		}
		expect(loader.startsWith("/")).toBe(true);
		await fs.copyFile(loader, path.join(repo, "loader"));
		await fs.chmod(path.join(repo, "loader"), 0o755);
		await fs.symlink("loader", path.join(repo, "loader-link"));
		const source = path.join(root, "program.c"),
			executable = path.join(root, "program");
		await fs.writeFile(source, "int main(void) { return 0; }\n");
		const compiler = Bun.spawn(["cc", source, "-o", executable, `-Wl,--dynamic-linker,${repo}/loader-link`], {
			stderr: "pipe",
		});
		expect(await compiler.exited).toBe(0);
		try {
			const child = Bun.spawn(wrap([executable]), { stdout: "pipe", stderr: "pipe" });
			const stderr = await new Response(child.stderr).text();
			expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
			expect((await observation.journal.original("loader"))?.type).toBe("file");
			expect((await observation.journal.original("loader-link"))?.type).toBe("symlink");
			expect(await observation.finish()).toEqual([]);
		} catch (error) {
			await observation.finish().catch(() => {});
			throw error;
		}
	},
	30000,
);
