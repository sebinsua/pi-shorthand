/**
 * Preloaded into every `code` program. On top of ordinary Bun and Node it adds these globals:
 * $ (Bun shell), edit, glob, grep, sg (ast-grep), grit (GritQL) and refactor (renames and file moves).
 *
 * sg is ast-grep's own JavaScript API plus file-backed search, rewrite and placement helpers.
 * Programs can also import "@ast-grep/napi" directly.
 *
 * Most helpers are synchronous; semantic TypeScript refactors return promises.
 * File lists come from git (tracked, plus untracked files that aren't ignored), so node_modules
 * and build output are left out on every platform.
 *
 * Each $ command and helper call is reported to the runner while the program is active.
 */

import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as astGrep from "@ast-grep/napi";
import { type Edit, Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { $ as bunShell, Glob } from "bun";
import { editingFiles, executionRoot, installFileOutcomeTracking } from "./file-outcomes.ts";
import {
	file as selectFile,
	moveDeclaration,
	getMatchSnapshot,
	insert,
	isFileTarget,
	move,
	remember,
	remove,
	type FileTarget,
} from "./placement.ts";
import type { RenameFileOptions, RenameOptions } from "./typescript-refactors.ts";

installFileOutcomeTracking();

const progressDescriptor = process.env.PI_SHORTHAND_PROGRESS_FD;
// Subprocesses do not inherit this descriptor by default, so do not advertise it to them.
delete process.env.PI_SHORTHAND_PROGRESS_FD;

function report(event: Record<string, unknown>) {
	if (!progressDescriptor) return;
	try {
		writeSync(Number(progressDescriptor), JSON.stringify(event) + "\n");
	} catch {
		// Progress is advisory and must never change the program's result.
	}
}

let helperCalls = 0;
let activeHelper: { helper: string; id: number } | undefined;

/**
 * Runs the program's own code from inside a helper, such as an sg.rewrite callback. That time counts
 * toward the timeout again, so an endless loop in a callback still times out promptly.
 */
function programCode<T>(run: () => T): T {
	const helper = activeHelper;
	if (!helper) return run();
	report({ type: "helper-yield", ...helper });
	activeHelper = undefined;
	try {
		return run();
	} finally {
		activeHelper = helper;
		report({ type: "helper-resume", ...helper });
	}
}

/**
 * Runs a helper, logging when it starts, how long it took and how many results it returned. The runner
 * pauses the program's timeout while helpers run, so every start is matched by a finish, even on failure.
 */
function logged<T>(helper: string, _args: unknown[], run: () => T): T {
	const id = ++helperCalls;
	const startedAt = performance.now();
	report({ type: "helper-start", helper, id });
	const outer = activeHelper;
	activeHelper = { helper, id };
	const done = (value?: unknown) => {
		const results = Array.isArray(value) ? value.length : typeof value === "number" ? value : undefined;
		report({
			type: "helper",
			helper,
			id,
			ms: Math.round(performance.now() - startedAt),
			results,
		});
	};
	let result: T;
	try {
		result = run();
	} catch (error) {
		done();
		throw error;
	} finally {
		activeHelper = outer;
	}
	if (result instanceof Promise)
		return result.then(
			(value) => {
				done(value);
				return value;
			},
			(error) => {
				done();
				throw error;
			},
		) as T;
	done(result);
	return result;
}

/** Bun's shell, logging each command as it starts. */
const $ = new Proxy(bunShell, {
	apply(target, thisArg, args: Parameters<typeof bunShell>) {
		const [strings] = args;
		const words = strings.raw[0].trim().split(/\s+/);
		report({ type: "command", command: words.find((word) => !word.includes("=")) ?? "" });
		return Reflect.apply(target, thisArg, args);
	},
});

/**
 * Files git sees under a directory that match a glob pattern, relative to the working directory,
 * sorted. The directory can also be given as { cwd }, as with Bun's Glob.
 */
function glob(pattern: string, where: string | { cwd?: string } = "."): string[] {
	const dir = typeof where === "string" ? where : (where.cwd ?? ".");
	return selectFiles(resolve(dir, pattern));
}

/**
 * Search files git sees. A string is matched literally; a RegExp is matched as a Perl-compatible
 * regular expression, which is close to JavaScript's syntax.
 */
function grep(pattern: string | RegExp, scope: string | string[] = ".") {
	const paths = [scope].flat().map((path) => pathArgument("grep", path));
	let flags: string[];
	if (typeof pattern === "string") {
		flags = ["-F", "-e", pattern];
	} else {
		flags = ["-P", "-e", pattern.source];
		if (pattern.flags.includes("i")) flags.push("-i");
	}
	const output = git(["grep", "-n", "--null", "--untracked", "-I", ...flags, "--", ...paths], [1]);

	const matches = [];
	let offset = 0;
	while (offset < output.length) {
		const fileEnd = output.indexOf("\0", offset);
		const lineEnd = fileEnd < 0 ? -1 : output.indexOf("\0", fileEnd + 1);
		const textEnd = lineEnd < 0 ? -1 : output.indexOf("\n", lineEnd + 1);
		const file = fileEnd < 0 ? "" : output.slice(offset, fileEnd);
		const lineNumber = lineEnd < 0 ? "" : output.slice(fileEnd + 1, lineEnd);
		if (!file || !/^\d+$/.test(lineNumber) || textEnd < 0) {
			throw new Error(`git grep returned malformed output: ${JSON.stringify(output.slice(offset, offset + 200))}`);
		}
		const text = output.slice(lineEnd + 1, textEnd);
		matches.push({ file, line: Number(lineNumber), text });
		offset = textEnd + 1;
	}
	return matches;
}

function git(args: string[], allowedExitCodes: number[] = []): string {
	const result = Bun.spawnSync(["git", ...args], { env: process.env });
	if (result.exitCode !== 0 && !allowedExitCodes.includes(result.exitCode)) {
		const diagnostic = result.stderr.toString().trim() || result.stdout.toString().trim();
		throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${diagnostic || "no diagnostics"}`);
	}
	return result.stdout.toString();
}

// The runner already resolved this before starting the sandbox. Standalone preloads
// still ask Git, preserving the existing direct-use behavior.
const repositoryRoot = executionRoot || git(["rev-parse", "--show-toplevel"]).trim();

/** Normalize an invocation path or glob to the path form emitted by `git ls-files --full-name`. */
function gitPath(input: string): string {
	const normalized = relative(repositoryRoot, resolve(input)).replaceAll("\\", "/");
	if (normalized === "") return ".";
	if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new Error(`path is outside the repository: ${JSON.stringify(input)}`);
	}
	return normalized;
}

/** Tracked or non-ignored untracked files, as Git lists them, relative to the repository root. */
function listGitFiles(pathspec = "."): string[] {
	const output = git(["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", pathspec]);
	return [...new Set(output.split("\0"))].filter(Boolean);
}

/** Git still lists a tracked file the program has deleted, so check the final filesystem too. */
function existing(files: string[]): string[] {
	return files.filter((file) => lstatSync(resolve(repositoryRoot, file), { throwIfNoEntry: false })).toSorted();
}

/** Existing tracked or non-ignored untracked files, always named relative to the repository root. */
function gitFiles(pathspec = "."): string[] {
	return existing(listGitFiles(pathspec));
}

// Starting git costs tens of milliseconds inside the sandbox. While set, one listing serves every
// input of a selection, so a list of 80 paths runs git once rather than 80 times.
let sharedListing: { files?: string[] } | undefined;

function withSharedListing<T>(select: () => T): T {
	if (sharedListing) return select();
	sharedListing = {};
	try {
		return select();
	} finally {
		sharedListing = undefined;
	}
}

let tracked: { stamp: string; files: Set<string> } | undefined;
let indexPath: string | undefined;

/** Files Git tracks, listed once and again only after the index changes, e.g. from `git add` in the program. */
function trackedFiles(): Set<string> {
	indexPath ??= resolve(repositoryRoot, git(["-C", repositoryRoot, "rev-parse", "--git-path", "index"]).trim());
	const index = statSync(indexPath, { throwIfNoEntry: false });
	const stamp = index ? `${index.ino}:${index.size}:${index.mtimeMs}` : "";
	if (tracked?.stamp !== stamp) {
		const listed = git(["-C", repositoryRoot, "ls-files", "-z", "--cached"]).split("\0").filter(Boolean);
		tracked = { stamp, files: new Set(listed) };
	}
	return tracked.files;
}

/** Select a Git-visible file, directory, or glob and return repository-relative paths. */
function selectFiles(input: string): string[] {
	const normalized = gitPath(input);
	const stats = statSync(resolve(repositoryRoot, normalized), { throwIfNoEntry: false });
	const pathspec = stats?.isFile() || stats?.isDirectory();
	if (!sharedListing) {
		// A program often names files one at a time; a tracked one needs no git process to be selected.
		if (stats?.isFile() && trackedFiles().has(normalized)) return [normalized];
		if (pathspec) return gitFiles(normalized);
		const matcher = new Glob(normalized);
		return gitFiles().filter((file) => matcher.match(file));
	}
	const files = (sharedListing.files ??= listGitFiles());
	if (pathspec)
		// A pathspec matches the path itself and everything beneath it.
		return existing(
			normalized === "." ? files : files.filter((file) => file === normalized || file.startsWith(`${normalized}/`)),
		);
	const matcher = new Glob(normalized);
	return existing(files.filter((file) => matcher.match(file)));
}

// ── ast-grep ──────────────────────────────────────────────────────────────────────
// Patterns use ast-grep syntax: $X matches one node, $$$X matches zero or more.

const LANGUAGES: Record<string, Lang> = {
	ts: Lang.TypeScript,
	mts: Lang.TypeScript,
	cts: Lang.TypeScript,
	tsx: Lang.Tsx,
	jsx: Lang.Tsx,
	js: Lang.JavaScript,
	mjs: Lang.JavaScript,
	cjs: Lang.JavaScript,
	html: Lang.Html,
	css: Lang.Css,
};

/**
 * A match. Its captures are in `vars` and also directly on it (capture names are uppercase, so they
 * can't clash with the other fields): both `m.vars.ARGS` and `m.ARGS` work.
 */
export type SgMatch = {
	file: string;
	line: number;
	text: string;
	vars: Record<string, string>; // captured metavariables, e.g. vars.ARGS for $$$ARGS
	node: SgNode;
} & Record<Uppercase<string>, string>;

export type FileScope = string | FileTarget | (string | FileTarget)[];

/** File targets opt into explicit files; strings retain the helper's existing selection semantics. */
function scopeFiles(helper: string, files: FileScope, select: (input: string) => string[]): string[] {
	const inputs = Array.isArray(files) ? files : [files];
	const selectAll = () => selectScope(helper, inputs, select);
	return inputs.length > 1 ? withSharedListing(selectAll) : selectAll();
}

function selectScope(helper: string, inputs: (string | FileTarget)[], select: (input: string) => string[]): string[] {
	return [
		...new Set(
			inputs.flatMap((input) => {
				if (typeof input === "string") return select(input);
				if (!isFileTarget(input))
					throw new TypeError(`${helper}: files must be paths, sg.file() targets, or an array of either`);
				const absolute = explicitPath(input.file);
				if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
					throw new Error(
						`${helper}: file target does not exist or is not a file: ${JSON.stringify(gitPath(absolute))}`,
					);
				return [gitPath(absolute)];
			}),
		),
	];
}

/** JS/TS files Git sees that contain any of these names as a word, for updating their imports. */
function filesMentioning(names: string[]): string[] {
	if (!names.length) return [];
	const output = git(
		[
			"-C",
			repositoryRoot,
			"grep",
			"-l",
			"-z",
			"-w",
			"-F",
			"--untracked",
			...names.flatMap((name) => ["-e", name]),
			"--",
			"*.ts",
			"*.tsx",
			"*.mts",
			"*.cts",
			"*.js",
			"*.jsx",
			"*.mjs",
			"*.cjs",
		],
		[1],
	);
	return output
		.split("\0")
		.filter(Boolean)
		.map((file) => resolve(repositoryRoot, file));
}

/** JS/TS files Git sees that call import() or require(). */
function filesLoadingModules(): string[] {
	const output = git(
		[
			"-C",
			repositoryRoot,
			"grep",
			"-l",
			"-z",
			"-E",
			"--untracked",
			"-e",
			// The call may continue on the next line or after a comment: `import\n("./a")`.
			"(^|[^[:alnum:]_$])(import|require)[[:space:]]*(\\(|/[*/]|$)",
			"--",
			"*.ts",
			"*.tsx",
			"*.mts",
			"*.cts",
			"*.js",
			"*.jsx",
			"*.mjs",
			"*.cjs",
		],
		[1],
	);
	return output
		.split("\0")
		.filter(Boolean)
		.map((file) => resolve(repositoryRoot, file));
}

/** A scope for a warning: short scopes in full, long ones as a count and the first few paths. */
function describeScope(scope: FileScope): string {
	const paths = (Array.isArray(scope) ? scope : [scope]).map((entry) =>
		typeof entry === "string" ? entry : gitPath(entry.file),
	);
	if (paths.length <= 3) return JSON.stringify(paths);
	return `${paths.length} paths (${paths
		.slice(0, 3)
		.map((path) => JSON.stringify(path))
		.join(", ")}, …)`;
}

/**
 * The supported syntax files to search. `files` is a Git-visible file, directory, glob, or a list
 * of any of those. Warns if there are none, since that's almost always a mistake.
 */
function sourceFiles(helper: string, files: FileScope): string[] {
	const found = scopeFiles(helper, files, selectFiles);
	const parseable = found.filter(
		(file) =>
			LANGUAGES[file.split(".").pop()!] && statSync(resolve(repositoryRoot, file), { throwIfNoEntry: false })?.isFile(),
	);
	if (parseable.length === 0) console.error(`warning: ${helper} found no supported files in ${describeScope(files)}`);
	return parseable;
}

/**
 * A file path argument. Helpers are documented and typed as taking paths, but also accept an sg.file()
 * target in their place, since that is an easy mistake to make and its meaning is unambiguous.
 */
function pathArgument(helper: string, path: unknown): string {
	if (typeof path === "string") return path;
	if (isFileTarget(path)) return getMatchSnapshot(path).file;
	throw new TypeError(`${helper}: expected a file path string`);
}

function find(pattern: string | NapiConfig, files: FileScope = "."): SgMatch[] {
	return findMatches("sg.find", pattern, files);
}

function findMatches(helper: string, pattern: string | NapiConfig, files: FileScope): SgMatch[] {
	const matches: SgMatch[] = [];
	for (const file of sourceFiles(helper, files)) {
		const parsed = parseFile(file);
		if (!parsed) continue;
		for (const node of findNodes(helper, parsed.root, pattern))
			matches.push(toMatch(file, node, parsed.source, pattern));
	}
	return matches;
}

function one(pattern: string | NapiConfig, files: FileScope = "."): SgMatch {
	const matches = findMatches("sg.one", pattern, files);
	if (matches.length !== 1)
		throw new Error(`sg.one expected exactly one match, found ${matches.length} for ${JSON.stringify(pattern)}`);
	return matches[0];
}

/**
 * A class method written on its own ("name($$$ARGS) { $$$BODY }") does not parse as one node, so it is
 * matched as a method of a class instead. Other fragments keep the parse failure, with how to fix it.
 */
function findNodes(helper: string, root: SgNode, pattern: string | NapiConfig): SgNode[] {
	try {
		return root.findAll(pattern);
	} catch (error) {
		if (typeof pattern !== "string" || !(error instanceof Error) || !error.message.includes("Multiple AST nodes"))
			throw error;
		try {
			return root.findAll({
				rule: { pattern: { context: `class C { ${pattern} }`, selector: "method_definition" } },
			});
		} catch {
			// Not a class member either. Preserve the original failure below.
		}
		error.message = `${helper}: ${error.message}\nPatterns must parse as one syntax node. For a fragment, use { rule: { pattern: { context: "complete surrounding code", selector: "node_kind" } } }.`;
		throw error;
	}
}

/** Explicit destinations may be ignored or missing, but cannot resolve outside the repository. */
function placementFile(path: string) {
	return selectFile(explicitPath(path));
}

function explicitPath(path: string): string {
	let ancestor = resolve(repositoryRoot, gitPath(path));
	const missing: string[] = [];
	while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
		missing.unshift(basename(ancestor));
		ancestor = dirname(ancestor);
	}
	const target = resolve(realpathSync(ancestor), ...missing);
	const relativeTarget = relative(realpathSync(repositoryRoot), target);
	if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
		throw new Error(`path is outside the repository: ${JSON.stringify(path)}`);
	}
	return target;
}

/** Text replaces the whole match; native edits replace nodes within it. Other listed values skip. */
export type RewriteResult = string | Edit | readonly Edit[] | null | undefined | false;

function replacementEdits(result: unknown, node: SgNode, file: string): Edit[] {
	if (result === null || result === undefined || result === false) return [];
	if (typeof result === "string") return [node.replace(result)];
	const location = `${JSON.stringify(file)}:${node.range().start.line + 1}`;
	const invalid = (detail: string): never => {
		throw new Error(
			`sg.rewrite at ${location}: ${detail}. Return text, a node.replace(...) edit, an array of edits, or null/undefined/false to skip.`,
		);
	};
	if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") {
		return invalid("Received a Promise/thenable; rewrite callbacks are synchronous");
	}
	const edits = Array.isArray(result) ? result : [result];
	const bounds = node.replace("");
	return Array.from(edits, (edit): Edit => {
		if (
			typeof edit !== "object" ||
			edit === null ||
			!Number.isSafeInteger(edit.startPos) ||
			!Number.isSafeInteger(edit.endPos) ||
			typeof edit.insertedText !== "string"
		) {
			return invalid(`Unsupported callback result (${edit === null ? "null in edit array" : typeof edit})`);
		}
		if (edit.startPos < bounds.startPos || edit.endPos > bounds.endPos || edit.endPos < edit.startPos) {
			return invalid(
				`Edit range [${edit.startPos}, ${edit.endPos}) is outside match [${bounds.startPos}, ${bounds.endPos}) or reversed`,
			);
		}
		return { startPos: edit.startPos, endPos: edit.endPos, insertedText: edit.insertedText };
	});
}

const rewriteStaleAdvice =
	"this match predates a change to its file. For independent edits from one selection, rerun with sg.rewrite(matches, callback) to apply them together. Otherwise, select again after editing.";

type Replacement = string | ((match: SgMatch) => RewriteResult);
type RewriteArgs =
	| [pattern: string | NapiConfig, replacement: Replacement, files?: FileScope]
	| [matches: SgMatch | readonly SgMatch[], replacement: Replacement];

function applyRewrites(matches: readonly SgMatch[], replacement: Replacement, file: string): number {
	const edits: Edit[] = [];
	let count = 0;
	for (const match of matches) {
		const result =
			typeof replacement === "function"
				? programCode(() => replacement(match))
				: replacement.replace(/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g, (text, _, name) => match.vars[name] ?? text);
		const changes = replacementEdits(result, match.node, file);
		if (changes.length > 0) {
			edits.push(...changes);
			count++;
		}
	}
	if (edits.length === 0) return 0;
	const ordered = edits.toSorted((a, b) => a.startPos - b.startPos || b.endPos - a.endPos);
	for (let i = 1; i < ordered.length; i++) {
		const previous = ordered[i - 1],
			current = ordered[i];
		if (current.startPos < previous.endPos || current.startPos === previous.startPos) {
			throw new Error(
				`sg.rewrite produced overlapping edits in ${JSON.stringify(file)}: [${previous.startPos}, ${previous.endPos}) and [${current.startPos}, ${current.endPos})`,
			);
		}
	}
	// A callback can run arbitrary code, including writes: don't overwrite changes made after selection.
	const sources = new Map<string, string | null>();
	for (const match of matches) getMatchSnapshot(match, sources, rewriteStaleAdvice);
	const source = matches[0].node.getRoot().root().text();
	const output = matches[0].node.getRoot().root().commitEdits(edits);
	recordRewriteOutput(file, source, output, ordered);
	writeFileSync(file, output);
	return count;
}

// Where earlier sg.rewrite calls put their replacements, per file, while the file still holds exactly what
// the last rewrite wrote. Rewrites apply one after another, so a later pattern can match an earlier result:
// rewriting request(u, undefined, t) to request(u, { timeoutMs: t }) creates a new two-argument call.
// Pattern rewrites skip such places; selections the program makes itself are always rewritten.
let explainedSkips = false;
const rewriteOutputs = new Map<string, { text: string; ranges: [number, number][] }>();

function recordRewriteOutput(file: string, before: string, after: string, all: readonly Edit[]): void {
	// A replacement identical to what it replaced produced nothing, so later rewrites may still match there.
	const edits = all.filter((edit) => edit.insertedText !== before.slice(edit.startPos, edit.endPos));
	const key = resolve(repositoryRoot, file);
	const previous = rewriteOutputs.get(key);
	const ranges: [number, number][] = [];
	let shift = 0;
	let next = 0;
	const earlier = previous?.text === before ? previous.ranges : [];
	for (const edit of edits) {
		// Keep earlier ranges this edit leaves alone, moved by the edits before them.
		for (; next < earlier.length && earlier[next]![1] <= edit.startPos; next++)
			ranges.push([earlier[next]![0] + shift, earlier[next]![1] + shift]);
		while (next < earlier.length && earlier[next]![0] < edit.endPos) next++;
		const start = edit.startPos + shift;
		ranges.push([start, start + edit.insertedText.length]);
		shift += edit.insertedText.length - (edit.endPos - edit.startPos);
	}
	for (; next < earlier.length; next++) ranges.push([earlier[next]![0] + shift, earlier[next]![1] + shift]);
	rewriteOutputs.set(key, { text: after, ranges });
}

/** Pattern matches that lie inside text an earlier sg.rewrite produced in this file, which is still unchanged. */
function insideEarlierOutput(file: string, source: string, matches: readonly SgMatch[]): Set<SgMatch> {
	const recorded = rewriteOutputs.get(resolve(repositoryRoot, file));
	if (!recorded || recorded.text !== source) return new Set();
	return new Set(
		matches.filter((match) => {
			const { start, end } = match.node.range();
			return recorded.ranges.some(([from, to]) => start.index >= from && end.index <= to);
		}),
	);
}

/** Rewrites patterns or existing selections; returns matches producing edits, not individual edits. */
function rewrite(...[target, replacement, files]: RewriteArgs): number {
	const selected = Array.isArray(target) || (typeof target === "object" && target !== null && "node" in target);
	if (selected) {
		if (files !== undefined)
			throw new Error("sg.rewrite: selected matches already specify their files; omit the file scope");
		const groups = new Map<string, SgMatch[]>();
		const sources = new Map<string, string | null>();
		for (const match of (Array.isArray(target) ? target : [target]) as SgMatch[]) {
			const saved = editingFiles([match.file], () => getMatchSnapshot(match, sources, rewriteStaleAdvice));
			if (!match.vars || typeof match.line !== "number")
				throw new Error("sg.rewrite expects matches from sg.one or sg.find");
			const file = explicitPath(match.file);
			if (file !== saved.file) throw new Error("sg.rewrite: selected file changed; select it again");
			const group = groups.get(file) ?? [];
			group.push(match);
			groups.set(file, group);
		}
		let count = 0;
		for (const [file, matches] of groups) {
			count += editingFiles([file], () => {
				const currentSources = new Map<string, string | null>();
				for (const match of matches) getMatchSnapshot(match, currentSources, rewriteStaleAdvice);
				return applyRewrites(matches, replacement, file);
			});
		}
		return count;
	}
	const pattern = target as string | NapiConfig;
	const scope = files ?? ".";
	let count = 0,
		matched = 0;
	const skipped: SgMatch[] = [];
	for (const file of sourceFiles("sg.rewrite", scope)) {
		count += editingFiles([file], () => {
			const parsed = parseFile(file);
			if (!parsed) return 0;
			const matches = findNodes("sg.rewrite", parsed.root, pattern).map((node) =>
				toMatch(file, node, parsed.source, pattern),
			);
			matched += matches.length;
			const earlier = insideEarlierOutput(file, parsed.source, matches);
			skipped.push(...earlier);
			return applyRewrites(
				matches.filter((match) => !earlier.has(match)),
				replacement,
				file,
			);
		});
	}
	if (matched === 0) {
		console.error(`warning: sg.rewrite matched nothing for ${JSON.stringify(pattern)} in ${describeScope(scope)}`);
	}
	// The explanation applies to every later rewrite too, so it is given once per program.
	if (skipped.length > 0 && !explainedSkips) {
		explainedSkips = true;
		const example = skipped[0]!;
		console.error(
			`warning: sg.rewrite skipped ${skipped.length} place${skipped.length === 1 ? "" : "s"} inside text an earlier sg.rewrite produced, e.g. ${gitPath(resolve(repositoryRoot, example.file))}:${example.line} ${example.text.split("\n")[0]}. Rewrites apply one after another, so this pattern would have rewritten that output a second time. To rewrite those places anyway, select them with sg.find and pass the matches to sg.rewrite.`,
		);
	}
	return count;
}

/** A JS/TS/HTML/CSS file's source and syntax tree, or null for other files. */
function parseFile(file: string) {
	const lang = LANGUAGES[file.split(".").pop()!];
	if (!lang) return null;
	const source = readFileSync(file, "utf8");
	return { source, root: parse(lang, source).root() };
}

function toMatch(file: string, node: SgNode, source: string, pattern: string | NapiConfig): SgMatch {
	const vars: Record<string, string> = {};
	for (const [, dollars, name] of JSON.stringify(pattern).matchAll(/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g)) {
		if (dollars === "$$$") {
			// Slice the original source so separators and formatting are kept ("a, b" rather than "a,b").
			const nodes = node.getMultipleMatches(name);
			const first = nodes[0];
			const last = nodes[nodes.length - 1];
			vars[name] = first && last ? source.slice(first.range().start.index, last.range().end.index) : "";
		} else {
			const captured = node.getMatch(name);
			if (captured) vars[name] = captured.text();
		}
	}
	return remember({ ...vars, file, line: node.range().start.line + 1, text: node.text(), vars, node }, source);
}

// ── GritQL ────────────────────────────────────────────────────────────────────────

/**
 * Apply a GritQL pattern in place (or only match it, with dryRun). Returns the files it matched.
 * e.g. grit("`console.log($x)` => `logger.info($x)`", "src")
 */
function grit(pattern: string, paths: FileScope = ".", options: { lang?: string; dryRun?: boolean } = {}) {
	const selected = scopeFiles("grit", paths, (input) => {
		const normalized = gitPath(input);
		return statSync(resolve(repositoryRoot, normalized), { throwIfNoEntry: false }) ? [normalized] : selectFiles(input);
	});
	if (selected.length === 0) {
		console.error(`warning: grit found no files in ${describeScope(paths)}`);
		return [];
	}
	const flags = ["--force", "--jsonl"];
	if (options.dryRun) flags.push("--dry-run");
	if (options.lang) flags.push("--language", options.lang);

	const targets = selected.map((file) => resolve(repositoryRoot, file));

	if (options.dryRun) return applyGrit(pattern, flags, targets);
	const affected = targets.flatMap((file) =>
		statSync(file).isDirectory() ? selectFiles(file).map((entry) => resolve(repositoryRoot, entry)) : [file],
	);
	return editingFiles(affected, () => applyGrit(pattern, flags, targets));
}

function applyGrit(pattern: string, flags: string[], targets: string[]) {
	const result = Bun.spawnSync(["grit", "apply", ...flags, pattern, ...targets], { env: process.env });
	if (result.exitCode !== 0) {
		const diagnostic = result.stderr.toString().trim() || result.stdout.toString().trim();
		throw new Error(`grit failed (exit ${result.exitCode}): ${diagnostic || "no diagnostics"}`);
	}

	const files = [];
	for (const line of result.stdout.toString().split("\n").filter(Boolean)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`grit returned malformed JSONL: ${JSON.stringify(line.slice(0, 200))}`);
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error(`grit returned malformed match data: ${JSON.stringify(line.slice(0, 200))}`);
		}
		const record = parsed as Record<string, unknown>;
		const matched = record.original ?? record; // rewrites nest the match under "original"
		if (typeof matched !== "object" || matched === null) {
			throw new Error(`grit returned malformed match data: ${JSON.stringify(line.slice(0, 200))}`);
		}
		const match = matched as Record<string, unknown>;
		if (match.sourceFile !== undefined) {
			if (typeof match.sourceFile !== "string" || !Array.isArray(match.ranges)) {
				throw new Error(`grit returned malformed match data: ${JSON.stringify(line.slice(0, 200))}`);
			}
			files.push({ file: match.sourceFile, matches: match.ranges.length });
		}
	}
	return files;
}

function normalizeEditLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Replace exactly one literal occurrence, tolerating line endings. Synchronous; await is safe. */
function editText(options: { path: string; oldText: string; newText: string }): void {
	const { oldText, newText } = options;
	const path = pathArgument("edit", options.path);
	if (typeof oldText !== "string" || typeof newText !== "string")
		throw new Error("edit expects { path, oldText, newText } strings");
	if (!oldText) throw new Error("edit: oldText must not be empty; use Bun.write to create a file");
	const source = readFileSync(path, "utf8");
	const searchable = normalizeEditLineEndings(source);
	const needle = normalizeEditLineEndings(oldText);
	const start = searchable.indexOf(needle);
	if (start === -1)
		throw new Error(`edit ${JSON.stringify(path)}: oldText not found; read the file and use its exact text`);
	if (searchable.indexOf(needle, start + 1) !== -1)
		throw new Error(`edit ${JSON.stringify(path)}: oldText matches more than once; include more surrounding text`);
	// Translate normalized offsets back so untouched bytes (including BOMs and mixed endings) survive.
	const originalOffset = (offset: number) => {
		let original = 0;
		for (let normalized = 0; normalized < offset; normalized++, original++) {
			if (source[original] === "\r" && source[original + 1] === "\n") original++;
		}
		return original;
	};
	writeFileSync(
		path,
		source.slice(0, originalOffset(start)) + newText + source.slice(originalOffset(start + needle.length)),
	);
}

const globals = {
	$,
	edit: (...args: Parameters<typeof editText>) =>
		logged("edit", args, () =>
			editingFiles(typeof args[0]?.path === "string" ? [args[0].path] : [], () => editText(...args)),
		),
	glob: (...args: Parameters<typeof glob>) => logged("glob", args, () => glob(...args)),
	grep: (...args: Parameters<typeof grep>) => logged("grep", args, () => grep(...args)),
	sg: {
		...astGrep,
		find: (...args: Parameters<typeof find>) => logged("sg.find", args, () => find(...args)),
		one: (...args: Parameters<typeof one>) => logged("sg.one", args, () => one(...args)),
		file: (...args: Parameters<typeof placementFile>) => logged("sg.file", args, () => placementFile(...args)),
		insert: (...args: Parameters<typeof insert>) => logged("sg.insert", args, () => insert(...args)),
		move: (...args: Parameters<typeof move>) => {
			const [match, destination, transform] = args;
			const own = transform && ((text: string) => programCode(() => transform(text)));
			return logged("sg.move", args, () => move(match, destination, own));
		},
		remove: (...args: Parameters<typeof remove>) => logged("sg.remove", args, () => remove(...args)),
		rewrite: (...args: Parameters<typeof rewrite>) => logged("sg.rewrite", args, () => rewrite(...args)),
	},
	grit: (...args: Parameters<typeof grit>) => logged("grit", args, () => grit(...args)),
	refactor: {
		rename: (options: RenameOptions) =>
			logged("refactor.rename", [options], () => {
				const prepared = {
					...options,
					file: pathArgument("refactor.rename", options.file),
				};
				return import("./typescript-refactors.ts").then(({ rename }) => rename(repositoryRoot, prepared));
			}),
		move: (options: { file: string; symbol: string; to: string }) =>
			logged("refactor.move", [options], async () => {
				const from = explicitPath(pathArgument("refactor.move", options.file));
				const to = explicitPath(pathArgument("refactor.move", options.to));
				if (typeof options.symbol !== "string" || !options.symbol)
					throw new TypeError("refactor.move expects { file, symbol, to } with a symbol name");
				moveDeclaration(from, options.symbol, to, { mentioning: filesMentioning, loadingModules: filesLoadingModules });
			}),
		renameFile: (options: RenameFileOptions) =>
			logged("refactor.renameFile", [options], () => {
				const prepared = {
					from: pathArgument("refactor.renameFile", options.from),
					to: pathArgument("refactor.renameFile", options.to),
				};
				return import("./typescript-refactors.ts").then(({ renameFile }) => renameFile(repositoryRoot, prepared));
			}),
	},
};

export type ShorthandGlobals = typeof globals;
Object.assign(globalThis, globals);
