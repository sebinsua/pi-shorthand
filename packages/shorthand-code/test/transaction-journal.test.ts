import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { TransactionJournal } from "../src/transaction/transaction-journal.ts";

const temporary: string[] = [];
afterEach(async () => {
	for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(tmpdir(), "shorthand-journal-"));
	temporary.push(root);
	await Bun.write(path.join(root, "input"), "original\n");
	return { root, journal: new TransactionJournal(root) };
}

test("journal retains an immutable original and validates unchanged content", async () => {
	const { journal } = await fixture();
	await journal.observe("input");
	const first = await journal.original("input");
	if (first?.type !== "file") throw new Error("missing file baseline");
	expect(Buffer.from(first.contents).toString()).toBe("original\n");
	first.contents.fill(0);
	const second = await journal.original("input");
	expect(second?.type === "file" && Buffer.from(second.contents).toString()).toBe("original\n");
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("read-only inputs are conflicts even when they are not destinations", async () => {
	const { root, journal } = await fixture();
	await journal.observe("input");
	await Bun.write(path.join(root, "input"), "external\n");
	await journal.seal();
	expect(await journal.conflicts()).toEqual(["input"]);
});

test("renaming a staged directory retains originals for newly created destination descendants", async () => {
	const { journal } = await fixture();
	await journal.observe("staged/new/file");
	await journal.observeRename("staged", "destination");
	expect(await journal.original("destination/new/file")).toBeNull();
	await journal.observeRename("destination", "again");
	expect(await journal.original("again/new/file")).toBeNull();
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("append and replacement cannot pass a prefix checksum", async () => {
	const { root, journal } = await fixture();
	await journal.observe("input");
	await fs.appendFile(path.join(root, "input"), "extra\n");
	await journal.seal();
	expect(await journal.conflicts()).toEqual(["input"]);
});

test("change-and-restore detects replacement identity despite identical contents", async () => {
	const { root, journal } = await fixture();
	await journal.observe("input");
	await fs.rename(path.join(root, "input"), path.join(root, "old"));
	await Bun.write(path.join(root, "input"), "original\n");
	await journal.seal();
	expect(await journal.conflicts()).toEqual(["input"]);
});

test("missing paths and directory listings participate in validation", async () => {
	const { root, journal } = await fixture();
	await journal.observe("missing");
	await journal.observe(".", "directory");
	expect(await journal.original("missing")).toBeNull();
	await Bun.write(path.join(root, "missing"), "present");
	await journal.seal();
	expect(await journal.conflicts()).toEqual([".", "missing"]);
});

test("unobserved siblings do not require a tree scan or cause conflicts", async () => {
	const { root, journal } = await fixture();
	await fs.mkdir(path.join(root, "untouched"));
	await fs.symlink("unresolvable", path.join(root, "untouched", "link"));
	await journal.observe("input");
	await Bun.write(path.join(root, "unrelated"), "new sibling");
	await journal.seal();
	expect(journal.entryCount).toBe(1);
	expect(await journal.conflicts()).toEqual([]);
});

test("metadata can upgrade to contents only while the original is unchanged", async () => {
	const { root, journal } = await fixture();
	await journal.observe("input", "metadata");
	await journal.observe("input", "contents");
	expect((await journal.original("input"))?.type).toBe("file");
	await Bun.write(path.join(root, "input"), "changed");
	await expect(journal.observe("input")).rejects.toThrow("source changed");
	await expect(journal.seal()).rejects.toThrow();
});

test("missing before-images permanently reject, rather than reading a late baseline", async () => {
	const { journal } = await fixture();
	await expect(journal.original("input")).rejects.toThrow("no original entry");
	await expect(journal.observe("input")).rejects.toThrow();
	await expect(journal.seal()).rejects.toThrow();
});

test("lost observation and accesses after sealing permanently invalidate", async () => {
	const { journal } = await fixture();
	await journal.observe("input");
	await journal.seal();
	await expect(journal.observe("input")).rejects.toThrow("after the journal was sealed");
	await expect(journal.conflicts()).rejects.toThrow();
	const other = new TransactionJournal("/unused");
	other.invalidate("observer disconnected");
	await expect(other.seal()).rejects.toThrow("observer disconnected");
});

test("symlink entries retain targets; unresolved symlink parents reject", async () => {
	const { root, journal } = await fixture();
	await fs.symlink("input", path.join(root, "link"));
	await journal.observe("link");
	expect(await journal.original("link")).toEqual({ type: "symlink", target: "input" });
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
	const other = new TransactionJournal(root);
	await expect(other.observe("link/child")).rejects.toThrow("non-directory parent");
});

test("path escapes and ancestor replacements reject", async () => {
	const { root, journal } = await fixture();
	await expect(journal.observe("../escape")).rejects.toThrow("invalid repository-relative path");
	const other = new TransactionJournal(root);
	await fs.mkdir(path.join(root, "nested"));
	await Bun.write(path.join(root, "nested", "input"), "value");
	await other.observe("nested/input");
	await fs.rename(path.join(root, "nested"), path.join(root, "moved"));
	await fs.symlink("moved", path.join(root, "nested"));
	await other.seal();
	expect(await other.conflicts()).toContain("nested");
});

test("validation cannot run against an unsealed journal", async () => {
	const { journal } = await fixture();
	await expect(journal.conflicts()).rejects.toThrow("before sealing");
});
