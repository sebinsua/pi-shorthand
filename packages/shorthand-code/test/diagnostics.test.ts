import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Diagnostics,
	completeDiagnostics,
	diagnosticCounter,
	diagnosticFailure,
	diagnosticLines,
	diagnosticPhase,
	measure,
	withDiagnostics,
} from "../src/runner/diagnostics.ts";
import { TransactionJournal } from "../src/transaction/transaction-journal.ts";
import { runWithBun } from "../src/runner/client.ts";

const publish = () => {
	throw Error("broken diagnostics");
};

test("diagnostic publication cannot prevent success or replace the original failure", async () => {
	const result = await withDiagnostics(async () => {
		diagnosticPhase("work");
		diagnosticCounter("count", 1);
		return measure("operation", async () => 42);
	}, publish);
	expect(result.value).toBe(42);
	const original = Error("original failure");
	await expect(
		withDiagnostics(
			() =>
				measure("operation", async () => {
					throw original;
				}),
			publish,
		),
	).rejects.toBe(original);
});

test("concurrent measurements are isolated and failure phase survives cleanup", async () => {
	let failed: Diagnostics | undefined;
	const [good, bad] = await Promise.allSettled([
		withDiagnostics(
			async () => {
				diagnosticPhase("good");
				await Bun.sleep(10);
				diagnosticCounter("good", 1);
			},
			() => {},
		),
		withDiagnostics(
			async () => {
				diagnosticPhase("copy");
				try {
					await measure("copy attempt", async () => {
						throw Error("copy failed");
					});
				} catch (error) {
					diagnosticFailure();
					throw error;
				} finally {
					diagnosticPhase("cleanup");
				}
			},
			(diagnostics) => {
				failed = diagnostics;
			},
		),
	]);
	expect(good.status).toBe("fulfilled");
	expect(bad.status).toBe("rejected");
	expect(failed!.failurePhase).toBe("copy");
	expect(failed!.counters).toEqual({});
	expect(failed!.spans.find((span) => span.name === "copy attempt")?.failed).toBe(true);
});

test("dependency diagnostics count retained originals without a repository inventory", async () => {
	const root = await mkdtemp(join(tmpdir(), "shorthand-diagnostics-"));
	try {
		await writeFile(join(root, "file"), "hello");
		const journal = new TransactionJournal(root);
		const { diagnostics } = await withDiagnostics(
			async () => {
				await measure("capturing dependency", () => journal.observe("file"));
				await journal.observe("file");
				diagnosticCounter("observed entries", journal.entryCount);
				diagnosticCounter("content captures", journal.contentCaptureCount);
			},
			() => {},
		);
		expect(diagnostics.spans.map((span) => span.name)).toEqual(["capturing dependency"]);
		expect(diagnostics.counters).toEqual({ "observed entries": 1, "content captures": 1 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a missing completion event reports incomplete execution rather than response overhead", () => {
	const diagnostics = completeDiagnostics({ spans: [{ name: "copy", startMs: 0 }], counters: {} }, 500, 20);
	expect(diagnostics.runnerMs).toBe(480);
	expect(diagnostics.responseMs).toBe(0);
	expect(diagnostics.incomplete).toBe(true);
	expect(diagnosticLines(diagnostics).join("\n")).toContain("copy: incomplete");
});

test("infrastructure failure retains diagnostics without duplicating them in stderr", async () => {
	const root = await mkdtemp(join(tmpdir(), "shorthand-failure-"));
	try {
		let caught: unknown;
		try {
			await runWithBun({ cwd: join(root, "missing"), program: "", timeoutMs: 2000, rollback: "all" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error & { diagnostics: Diagnostics };
		expect(error.diagnostics.failurePhase).toBe("resolving repository");
		expect(error.diagnostics.wallMs).toBeGreaterThanOrEqual(error.diagnostics.runnerMs!);
		expect(error.message).not.toContain("phase detail");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a missing Bun is reported as such", async () => {
	const path = process.env.PATH;
	const empty = await mkdtemp(join(tmpdir(), "shorthand-no-bun-"));
	process.env.PATH = empty;
	try {
		const run = runWithBun({ cwd: empty, program: "", timeoutMs: 2000, rollback: "all" });
		await expect(run).rejects.toThrow("Bun was not found on PATH");
	} finally {
		process.env.PATH = path;
		await rm(empty, { recursive: true, force: true });
	}
});
