import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export const RUN_HISTORY_FILE = path.join(homedir(), ".cache", "pi-shorthand", "runs.jsonl");
export const RUN_HISTORY_LOCK_DIR = `${RUN_HISTORY_FILE}.locks`;
export const RUN_HISTORY_MAX_BYTES = 1024 * 1024;
export const RUN_HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_EVENTS = new Set([
	"started",
	"overlay opened",
	"program started",
	"program exited",
	"finished",
	"command",
	"helper",
	"cleanup warning",
	"failed",
]);

interface HistoryOptions {
	maxBytes?: number;
	maxAgeMs?: number;
	now?: number;
	env?: NodeJS.ProcessEnv;
}

export function historyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !["0", "false", "off"].includes((env.PI_SHORTHAND_HISTORY ?? "").toLowerCase());
}

/** Persist a bounded event containing only the allowlisted, non-source fields used for diagnostics. */
export function appendRunHistory(
	event: string,
	details: Record<string, unknown> = {},
	file = RUN_HISTORY_FILE,
	options: HistoryOptions = {},
) {
	if (!historyEnabled(options.env)) return;
	if (!HISTORY_EVENTS.has(event)) return;
	const record = JSON.stringify({
		time: new Date(options.now ?? Date.now()).toISOString(),
		event,
		...safeDetails(event, details),
	});
	const env = options.env ?? process.env;
	const sandboxed = env.PI_SHORTHAND_HISTORY_SANDBOX === "1";
	withHistoryLock(file, sandboxed, () => appendBounded(file, `${record}\n`, options, sandboxed));
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function withHistoryLock(file: string, sandboxed: boolean, run: () => void) {
	const directory = `${file}.locks`;
	if (!sandboxed) mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStats = lstatSync(directory);
	if (
		!directoryStats.isDirectory() ||
		directoryStats.isSymbolicLink() ||
		(process.getuid && directoryStats.uid !== process.getuid())
	) {
		throw new Error(`Unsafe run history lock directory: ${directory}`);
	}
	if (!sandboxed) chmodSync(directory, 0o700);

	const lock = path.join(directory, "append");
	let acquired = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			acquired = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stats = lstatSync(lock, { throwIfNoEntry: false });
			if (stats && Date.now() - stats.mtimeMs > 10_000) {
				rmSync(lock, { recursive: true, force: true });
				continue;
			}
			Atomics.wait(lockWait, 0, 0, 5);
		}
	}
	if (!acquired) return; // history must never hold up the transaction itself
	try {
		run();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function safeDetails(event: string, details: Record<string, unknown>): Record<string, unknown> {
	const number = (key: string) => (typeof details[key] === "number" ? details[key] : undefined);
	const boolean = (key: string) => (typeof details[key] === "boolean" ? details[key] : undefined);
	const text = (key: string, allowed: readonly string[]) =>
		typeof details[key] === "string" && allowed.includes(details[key]) ? details[key] : undefined;

	switch (event) {
		case "started":
			return compact({
				run: safeIdentifier(details.run),
				timeoutMs: number("timeoutMs"),
				rollback: text("rollback", ["all", "file"]),
			});
		case "program started":
			return compact({ run: safeIdentifier(details.run), timeoutMs: number("timeoutMs") });
		case "program exited":
			return compact({
				run: safeIdentifier(details.run),
				exitCode: details.exitCode === null ? null : number("exitCode"),
				timedOut: boolean("timedOut"),
				aborted: boolean("aborted"),
				stillRunning: number("stillRunning"),
			});
		case "finished":
			return compact({
				run: safeIdentifier(details.run),
				changed: number("changed"),
				applied: number("applied"),
				conflicts: number("conflicts"),
			});
		case "command":
			return compact({ run: safeIdentifier(details.run), command: safeCommand(details.command) });
		case "helper":
			return compact({
				run: safeIdentifier(details.run),
				helper: text("helper", [
					"glob",
					"grep",
					"sg.find",
					"sg.one",
					"sg.file",
					"sg.insert",
					"sg.move",
					"sg.remove",
					"sg.rewrite",
					"grit",
				]),
				ms: number("ms"),
				results: number("results"),
			});
		default:
			return compact({ run: safeIdentifier(details.run) });
	}
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function safeIdentifier(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

function safeCommand(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const command = path.basename(value);
	return /^[a-zA-Z0-9_.-]{1,64}$/.test(command) ? command : undefined;
}

function appendBounded(file: string, line: string, options: HistoryOptions, sandboxed: boolean) {
	const maxBytes = options.maxBytes ?? RUN_HISTORY_MAX_BYTES;
	const maxAgeMs = options.maxAgeMs ?? RUN_HISTORY_MAX_AGE_MS;
	const now = options.now ?? Date.now();
	const directory = path.dirname(file);
	const rotated = `${file}.1`;
	if (!sandboxed) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const directoryStats = lstatSync(directory);
		if (
			!directoryStats.isDirectory() ||
			directoryStats.isSymbolicLink() ||
			(process.getuid && directoryStats.uid !== process.getuid())
		) {
			throw new Error(`Unsafe run history directory: ${directory}`);
		}
		chmodSync(directory, 0o700);
	}

	let existing: Stats | undefined;
	try {
		existing = lstatSync(file) as Stats;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
		throw new Error(`Unsafe run history file: ${file}`);
	if (!sandboxed) {
		const rotatedStats = lstatSync(rotated, { throwIfNoEntry: false });
		if (rotatedStats?.isSymbolicLink() || (rotatedStats && !rotatedStats.isFile())) {
			rmSync(rotated, { recursive: true, force: true });
		} else if (rotatedStats && now - cohortStartedAt(rotated, rotatedStats) > maxAgeMs) {
			rmSync(rotated, { force: true });
		}
	}
	if (!sandboxed && existing && now - cohortStartedAt(file, existing) > maxAgeMs) {
		rmSync(file, { force: true });
		existing = undefined;
	} else if (!sandboxed && existing && existing.size + Buffer.byteLength(line) > maxBytes) {
		rmSync(rotated, { force: true });
		renameSync(file, rotated);
		existing = undefined;
	}

	const descriptor = openSync(
		file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile() || (process.getuid && stats.uid !== process.getuid()))
			throw new Error(`Unsafe run history file: ${file}`);
		if (sandboxed) {
			if ((stats.mode & 0o077) !== 0) throw new Error(`Unsafe run history permissions: ${file}`);
		} else {
			fchmodSync(descriptor, 0o600);
		}
		if (stats.size + Buffer.byteLength(line) <= maxBytes) writeSync(descriptor, line);
	} finally {
		closeSync(descriptor);
	}
}

/** The first record starts a cohort; later appends cannot extend that cohort's retention deadline. */
function cohortStartedAt(file: string, stats: Stats): number {
	const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const buffer = Buffer.alloc(2048);
		const length = readSync(descriptor, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, length).toString("utf8").split("\n", 1)[0];
		const time = Date.parse(JSON.parse(firstLine).time);
		return Number.isFinite(time) ? time : stats.birthtimeMs;
	} catch {
		return stats.birthtimeMs;
	} finally {
		closeSync(descriptor);
	}
}
