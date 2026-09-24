/** Disposable real-backend regression: untouched tree size must not expand observation.
 * Run with Bun; set AGENTFS_BIN on macOS. Fixture creation is excluded from timings.
 * Defaults reproduce the reported 115k-entry / ~1.3GB logical repository size.
 */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { RunResult } from "../packages/shorthand-code/src/runner/runner.ts";

const entries = Number(process.env.SHORTHAND_SCALING_ENTRIES ?? 115000);
const bytes = Number(process.env.SHORTHAND_SCALING_BYTES ?? 11133);
const repetitions = Number(process.env.SHORTHAND_SCALING_RUNS ?? 5);
if (![entries, bytes, repetitions].every((n) => Number.isSafeInteger(n) && n > 0))
	throw new Error("Scaling fixture parameters must be positive integers");
const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "shorthand-scaling-")));
const repo = path.join(temporary, "repo");
const runner = path.resolve(import.meta.dir, "../packages/shorthand-code/src/runner/runner.ts");
await fs.mkdir(repo);
const samples: Record<string, RunResult[]> = { small: [], large: [] };
const summarize = (runs: RunResult[]) =>
	runs.map((result) => ({
		durationMs: result.durationMs,
		timings: result.timings,
		counters: result.diagnostics?.counters,
		spans: result.diagnostics?.spans,
	}));

async function run(broad = false): Promise<RunResult> {
	const child = Bun.spawn([process.execPath, runner], {
		stdin: new Response(
			JSON.stringify({
				cwd: repo,
				rollback: "all",
				timeoutMs: 30000,
				program: broad
					? 'const fs = await import("node:fs/promises"); const names = await fs.readdir("node_modules/0"); for (const name of names) await fs.stat("node_modules/0/" + name); console.log(names.length);'
					: 'await Bun.write("edited.txt", String(Number(await Bun.file("edited.txt").text()) + 1));',
			}),
		),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw new Error(stderr);
	const result = JSON.parse(stdout) as RunResult;
	if (result.exitCode !== 0 || result.conflicts.length || (!broad && result.applied.join() !== "edited.txt"))
		throw new Error(`Scaling transaction failed: ${JSON.stringify(result)}`);
	return result;
}

try {
	await fs.writeFile(path.join(repo, "edited.txt"), "0");
	await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
	await fs.mkdir(path.join(repo, "node_modules"));
	await $`git init -q && git add -A && git -c user.name=Test -c user.email=test@localhost commit -qm fixture`
		.cwd(repo)
		.quiet();
	for (let i = 0; i < repetitions; i++) samples.small.push(await run());
	const fixtureStart = performance.now();
	// Sparse payloads represent logical bytes, not measured physical disk traffic.
	const groups = Math.ceil(entries / 1000);
	for (let group = 0; group < groups; group++) {
		const directory = path.join(repo, "node_modules", String(group));
		await fs.mkdir(directory, { recursive: true });
		for (let offset = 0; offset < 1000 && group * 1000 + offset < entries; offset += 32) {
			await Promise.all(
				Array.from({ length: Math.min(32, 1000 - offset, entries - group * 1000 - offset) }, async (_, i) => {
					const file = await fs.open(path.join(directory, `${offset + i}.bin`), "wx");
					try {
						await file.truncate(bytes);
					} finally {
						await file.close();
					}
				}),
			);
		}
	}
	const fixtureMs = performance.now() - fixtureStart;
	for (let i = 0; i < repetitions; i++) samples.large.push(await run());
	// Kernel/cache-dependent startup probes may differ between otherwise identical
	// runs. Large-fixture counts must match a count set already seen before growth.
	const small = new Set(samples.small.map((result) => JSON.stringify(result.diagnostics?.counters)));
	for (const result of samples.large) {
		if (!result.diagnostics?.counters || !small.has(JSON.stringify(result.diagnostics.counters)))
			throw new Error(
				`Untouched tree growth changed observation counts: ${JSON.stringify({ small: summarize(samples.small), large: summarize(samples.large) })}`,
			);
	}
	const broad = await run(true);
	console.log(
		JSON.stringify(
			{
				platform: process.platform,
				entries,
				logicalBytes: entries * bytes,
				sparse: true,
				fixtureMs,
				helperCache: "existing cache (no cache eviction)",
				small: summarize(samples.small),
				large: summarize(samples.large),
				broad: summarize([broad]),
			},
			null,
			2,
		),
	);
} finally {
	await fs.rm(temporary, { recursive: true, force: true });
}
