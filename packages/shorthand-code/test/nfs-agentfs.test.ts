/** Opt-in real kernel NFS mount; uses only a disposable fixture, never the checkout. */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { openNfsObservation, type NfsObservation } from "../src/macos/nfs-worker.ts";

test.skipIf(process.platform !== "darwin" || process.env.SHORTHAND_NFS_INTEGRATION !== "1")(
	"real AgentFS mount observes ordinary reads and private writes without a repository copy",
	async () => {
		const agentfs = process.env.AGENTFS_BIN ?? Bun.which("agentfs");
		if (!agentfs) throw new Error("Set AGENTFS_BIN for the opt-in mount test");
		const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "shorthand-nfs-integration-")));
		const source = path.join(temporary, "source");
		const mount = path.join(temporary, "mount");
		await fs.mkdir(source);
		await fs.mkdir(mount);
		await Bun.write(path.join(source, "input"), "original\n");
		await $`${agentfs} init run --base ${source}`.cwd(temporary).quiet();
		const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const port = listener.port;
		listener.stop(true);
		const server = Bun.spawn([agentfs, "nfs", path.join(temporary, ".agentfs", "run.db"), "--port", String(port)], {
			stdout: "ignore",
			stderr: "pipe",
		});
		let proxy: NfsObservation | undefined;
		let mounted = false;
		let safeToRemove = true;
		try {
			let ready = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
					socket.end();
					ready = true;
					break;
				} catch {
					await Bun.sleep(20);
				}
			}
			if (!ready) throw new Error("AgentFS server did not start");
			proxy = await openNfsObservation({ root: source, backendPort: port, requestTimeoutMs: 5000 });
			const options = `locallocks,vers=3,tcp,port=${proxy.port},mountport=${proxy.port},soft,timeo=10,retrans=1,acdirmin=0,acdirmax=0`;
			await $`/sbin/mount_nfs -o ${options} 127.0.0.1:/ ${mount}`.quiet();
			mounted = true;
			// The worker must remain responsive even when the runner performs mounted I/O.
			expect(await Bun.file(path.join(mount, "input")).text()).toBe("original\n");
			const program = `console.log(JSON.stringify(await Bun.file("input").text()));
				await Bun.write("input", "private\\n"); await Bun.write("new", "created\\n");`;
			const child = Bun.spawn([process.execPath, "-e", program], { cwd: mount, stdout: "pipe", stderr: "pipe" });
			const output = await new Response(child.stdout).text();
			const errorOutput = await new Response(child.stderr).text();
			expect(errorOutput).toBe("");
			expect(await child.exited).toBe(0);
			expect(JSON.parse(output)).toBe("original\n");
			expect(await Bun.file(path.join(source, "input")).text()).toBe("original\n");
			expect(await Bun.file(path.join(source, "new")).exists()).toBe(false);
			await $`/sbin/umount ${mount}`.quiet();
			mounted = false;
			const original = await proxy.original("input");
			expect(original?.type === "file" && Buffer.from(original.contents).toString()).toBe("original\n");
			expect(await proxy.original("new")).toBeNull();
			expect(await proxy.finish()).toEqual([]);
		} finally {
			if (mounted) {
				const result = await $`/sbin/umount -f ${mount}`.nothrow().quiet();
				safeToRemove = result.exitCode === 0;
			}
			await proxy?.abort();
			server.kill();
			await server.exited;
			if (safeToRemove) await fs.rm(temporary, { recursive: true, force: true });
			else console.error(`Could not unmount test fixture; retained ${temporary}`);
		}
		expect(safeToRemove).toBe(true);
	},
	30000,
);
