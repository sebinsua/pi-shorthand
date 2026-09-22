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
} from "../diagnostics.ts";
import { copyStableTree } from "../overlay-linux.ts";
import { runWithBun } from "../index.ts";

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

test("snapshot diagnostics distinguish inventory, copy and verification with repository size", async () => {
	const root = await mkdtemp(join(tmpdir(), "shorthand-diagnostics-"));
	try {
		await writeFile(join(root, "file"), "hello");
		const { diagnostics } = await withDiagnostics(
			() => copyStableTree(root, root + "-copy"),
			() => {},
		);
		expect(diagnostics.spans.map((span) => span.name)).toEqual([
			"snapshot inventory",
			"snapshot reset",
			"snapshot copy",
			"snapshot verification",
		]);
		expect(diagnostics.counters["snapshot attempts"]).toBe(1);
		expect(diagnostics.counters["snapshot entries"]).toBe(2);
		expect(diagnostics.counters["snapshot logical bytes"]).toBe(5);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(root + "-copy", { recursive: true, force: true });
	}
});

test("a missing completion event reports incomplete execution rather than response overhead", () => {
	const diagnostics = completeDiagnostics({ spans: [{ name: "copy", startMs: 0 }], counters: {} }, 500, 20);
	expect(diagnostics.runnerMs).toBe(480);
	expect(diagnostics.responseMs).toBe(0);
	expect(diagnostics.incomplete).toBe(true);
	expect(diagnosticLines(diagnostics).join("\n")).toContain("copy: incomplete");
});

test("exhausted snapshot retries retain every failed attempt", async () => {
	const root = await mkdtemp(join(tmpdir(), "shorthand-retries-"));
	let diagnostics: Diagnostics | undefined;
	try {
		await expect(
			withDiagnostics(
				() => copyStableTree(join(root, "missing"), join(root, "copy")),
				(snapshot) => {
					diagnostics = snapshot;
				},
			),
		).rejects.toThrow("kept changing");
		expect(diagnostics!.counters["snapshot attempts"]).toBe(3);
		expect(diagnostics!.spans).toHaveLength(3);
		expect(diagnostics!.spans.every((span) => span.failed && span.durationMs !== undefined)).toBe(true);
		expect(diagnostics!.runnerMs).toBeDefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
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
