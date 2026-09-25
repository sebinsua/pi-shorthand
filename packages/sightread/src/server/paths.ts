// Choose a safe, short runtime parent and locate the files for one project.
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Project } from "../project.ts";

export interface ServerPaths {
	parent: string;
	directory: string;
	socket: string;
	state: string;
	log: string;
	lock: string;
}

export function stateParent(): string {
	const uid = process.getuid?.() ?? 0;
	const name = `sightread-${uid}`;
	const bases = [process.env.XDG_RUNTIME_DIR, tmpdir(), "/tmp"];
	let fits = false;
	for (const base of bases) {
		if (!base) continue;
		const parent = join(base, name);
		if (Buffer.byteLength(join(parent, "0".repeat(20), "server.sock")) > 100) continue;
		fits = true;
		try {
			try {
				if (lstatSync(parent).isSymbolicLink()) continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
			}
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			const descriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				const stat = fstatSync(descriptor);
				if (!stat.isDirectory() || stat.uid !== uid) continue;
				if (stat.mode & 0o077) fchmodSync(descriptor, 0o700);
				if ((fstatSync(descriptor).mode & 0o077) === 0) return parent;
			} finally {
				closeSync(descriptor);
			}
		} catch {
			// Try the next base when this one cannot be created or inspected.
		}
	}
	if (!fits) throw new Error("server socket path exceeds 100 bytes; set XDG_RUNTIME_DIR to a shorter path");
	throw new Error("no safe sightread state directory available");
}

export function serverPaths(project: Project): ServerPaths {
	const parent = stateParent();
	const hash = createHash("sha256")
		.update(resolve(project.root))
		.update("\0")
		.update(resolve(project.tsconfig))
		.digest("hex")
		.slice(0, 20);
	const directory = join(parent, hash);
	const socket = join(directory, "server.sock");
	return {
		parent,
		directory,
		socket,
		state: join(directory, "state.json"),
		log: join(directory, "server.log"),
		lock: join(directory, "start.lock"),
	};
}
