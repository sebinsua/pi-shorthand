import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appendRunHistory, historyEnabled } from "../history.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function historyFile(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-shorthand-history-test-"));
	roots.push(root);
	return path.join(root, "private", "runs.jsonl");
}

test("run history uses private permissions", async () => {
	const file = await historyFile();
	appendRunHistory("started", { run: "test", timeoutMs: 2000, rollback: "all" }, file);

	expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);
	expect((await lstat(file)).mode & 0o777).toBe(0o600);
});

test("PI_SHORTHAND_HISTORY disables persistence", async () => {
	const file = await historyFile();
	expect(historyEnabled({ PI_SHORTHAND_HISTORY: "0" })).toBe(false);
	appendRunHistory("started", { run: "test" }, file, { env: { PI_SHORTHAND_HISTORY: "0" } });
	expect(await Bun.file(file).exists()).toBe(false);
});

test("run history rotates by size and expires by age", async () => {
	const file = await historyFile();
	const now = Date.now();
	for (let index = 0; index < 8; index++) {
		appendRunHistory("started", { run: `run-${index}`, timeoutMs: index, rollback: "all" }, file, {
			maxBytes: 220,
			now,
		});
	}
	expect((await lstat(file)).size).toBeLessThanOrEqual(220);
	expect((await lstat(`${file}.1`)).size).toBeLessThanOrEqual(220);
	expect((await lstat(`${file}.1`)).mode & 0o777).toBe(0o600);

	appendRunHistory("started", { run: "fresh", timeoutMs: 1, rollback: "all" }, file, {
		maxBytes: 220,
		maxAgeMs: 100,
		now: now + 1_000,
	});
	const current = await readFile(file, "utf8");
	expect(current).toContain('"run":"fresh"');
	expect(current).not.toContain('"run":"run-');
	expect(await Bun.file(`${file}.1`).exists()).toBe(false);
});

test("new activity cannot extend an old cohort's retention deadline", async () => {
	const file = await historyFile();
	const now = Date.now();
	appendRunHistory("started", { run: "old", timeoutMs: 1, rollback: "all" }, file, {
		maxBytes: 10_000,
		maxAgeMs: 100,
		now,
	});
	appendRunHistory("finished", { run: "active", changed: 1, applied: 1, conflicts: 0 }, file, {
		maxBytes: 10_000,
		maxAgeMs: 100,
		now: now + 50,
	});
	appendRunHistory("started", { run: "fresh", timeoutMs: 1, rollback: "all" }, file, {
		maxBytes: 10_000,
		maxAgeMs: 100,
		now: now + 101,
	});

	const current = await readFile(file, "utf8");
	expect(current).toContain('"run":"fresh"');
	expect(current).not.toContain('"run":"old"');
	expect(current).not.toContain('"run":"active"');
});

test("run history never persists source data or representative credentials", async () => {
	const file = await historyFile();
	const secret = "ghp_1234567890abcdefghijklmnop";
	appendRunHistory(
		"started",
		{ run: "safe-run", repo: `/private/${secret}`, cwd: "/secret/project", program: `token=${secret}` },
		file,
	);
	appendRunHistory("command", { run: "safe-run", command: "curl", args: `Authorization: Bearer ${secret}` }, file);
	appendRunHistory("failed", { run: "safe-run", error: `AWS_SECRET_ACCESS_KEY=${secret}` }, file);
	appendRunHistory(`unknown-${secret}`, { run: "safe-run" }, file);

	const persisted = await readFile(file, "utf8");
	expect(persisted).not.toContain(secret);
	expect(persisted).not.toContain("/secret/project");
	expect(persisted).not.toContain("Authorization");
	expect(persisted).not.toContain("AWS_SECRET_ACCESS_KEY");
	expect(persisted).toContain('"command":"curl"');
});

test("concurrent writers rotate without exceeding the configured bound", async () => {
	const file = await historyFile();
	const module = path.join(import.meta.dir, "..", "history.ts");
	const script = `
		import { appendRunHistory } from ${JSON.stringify(module)};
		for (let index = 0; index < 40; index++) {
			appendRunHistory("started", { run: process.argv[1] + "-" + index, timeoutMs: index, rollback: "all" }, ${JSON.stringify(file)}, { maxBytes: 512 });
		}`;
	const writers = Array.from({ length: 6 }, (_, index) =>
		Bun.spawn([process.execPath, "-e", script, `writer-${index}`], {
			stdout: "ignore",
			stderr: "pipe",
			env: { ...process.env, PI_SHORTHAND_HISTORY: "1" },
		}),
	);
	for (const writer of writers) {
		const stderr = await new Response(writer.stderr).text();
		expect(await writer.exited, stderr).toBe(0);
	}

	for (const candidate of [file, `${file}.1`]) {
		const contents = await readFile(candidate, "utf8");
		expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(512);
		for (const line of contents.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
	}
});
