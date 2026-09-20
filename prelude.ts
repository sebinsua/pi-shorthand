/**
 * Preloaded into every `code` program. On top of ordinary Bun and Node it adds these globals:
 * $ (Bun shell), glob, grep, sg (ast-grep) and grit (GritQL).
 *
 * sg is ast-grep's own JavaScript API (@ast-grep/napi: sg.parse, sg.Lang, sg.findInFiles, …) plus two
 * shortcuts, sg.find and sg.rewrite. Programs can also import "@ast-grep/napi" directly.
 *
 * Everything except $ is synchronous: models often call helpers like these without await.
 * File lists come from git (tracked, plus untracked files that aren't ignored), so node_modules
 * and build output are left out on every platform.
 *
 * Each $ command and helper call is logged to the runner's log (~/.cache/pi-shorthand/runs.jsonl) as it
 * happens, so `tail -f` shows what a program is doing, including which command it's stuck on.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import * as astGrep from "@ast-grep/napi";
import { Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { $ as bunShell, Glob } from "bun";
import { appendRunHistory } from "./history.ts";

function log(event: string, details: Record<string, unknown>) {
	const { PI_SHORTHAND_LOG, PI_SHORTHAND_RUN } = process.env;
	if (!PI_SHORTHAND_LOG) return;
	appendRunHistory(event, { run: PI_SHORTHAND_RUN, ...details }, PI_SHORTHAND_LOG);
}

/** Runs a helper, logging how long it took and how many results it returned. */
function logged<T>(helper: string, _args: unknown[], run: () => T): T {
	const startedAt = performance.now();
	const result = run();
	const results = Array.isArray(result) ? result.length : typeof result === "number" ? result : undefined;
	log("helper", {
		helper,
		ms: Math.round(performance.now() - startedAt),
		results,
	});
	return result;
}

/** Bun's shell, logging each command as it starts. */
const $ = new Proxy(bunShell, {
	apply(target, thisArg, args: Parameters<typeof bunShell>) {
		const [strings] = args;
		const words = strings.raw[0].trim().split(/\s+/);
		log("command", { command: words.find((word) => !word.includes("=")) ?? "" });
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
function grep(pattern: string | RegExp, paths: string | string[] = ".") {
	let flags: string[];
	if (typeof pattern === "string") {
		flags = ["-F", "-e", pattern];
	} else {
		flags = ["-P", "-e", pattern.source];
		if (pattern.flags.includes("i")) flags.push("-i");
	}
	const output = git(["grep", "-n", "--null", "--untracked", "-I", ...flags, "--", ...[paths].flat()], [1]);

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

const repositoryRoot = git(["rev-parse", "--show-toplevel"]).trim();

/** Normalize an invocation path or glob to the path form emitted by `git ls-files --full-name`. */
function gitPath(input: string): string {
	const normalized = relative(repositoryRoot, resolve(input)).replaceAll("\\", "/");
	if (normalized === "") return ".";
	if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new Error(`path is outside the repository: ${JSON.stringify(input)}`);
	}
	return normalized;
}

/** Existing tracked or non-ignored untracked files, always named relative to the repository root. */
function gitFiles(pathspec = "."): string[] {
	const output = git(["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", pathspec]);
	// Git still lists a tracked file the program has deleted, so check the final filesystem too.
	return [...new Set(output.split("\0"))]
		.filter((file) => file && existsSync(resolve(repositoryRoot, file)))
		.toSorted();
}

/** Select a Git-visible file, directory, or glob and return repository-relative paths. */
function selectFiles(input: string): string[] {
	const normalized = gitPath(input);
	const stats = statSync(resolve(repositoryRoot, normalized), { throwIfNoEntry: false });
	if (stats?.isFile() || stats?.isDirectory()) return gitFiles(normalized);
	const matcher = new Glob(normalized);
	return gitFiles().filter((file) => matcher.match(file));
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
type SgMatch = {
	file: string;
	line: number;
	text: string;
	vars: Record<string, string>; // captured metavariables, e.g. vars.ARGS for $$$ARGS
	node: SgNode;
} & Record<string, unknown>;

/**
 * The supported syntax files to search. `files` is a Git-visible file, directory, glob, or a list
 * of any of those. Warns if there are none, since that's almost always a mistake.
 */
function sourceFiles(helper: string, files: string | string[]): string[] {
	const found = [...new Set([files].flat().flatMap(selectFiles))];
	const parseable = found.filter((file) => LANGUAGES[file.split(".").pop()!]);
	if (parseable.length === 0) console.error(`warning: ${helper} found no supported files in ${JSON.stringify(files)}`);
	return parseable;
}

function find(pattern: string | NapiConfig, files: string | string[] = "."): SgMatch[] {
	const matches: SgMatch[] = [];
	for (const file of sourceFiles("sg.find", files)) {
		const parsed = parseFile(file);
		if (!parsed) continue;
		for (const node of parsed.root.findAll(pattern)) matches.push(toMatch(file, node, parsed.source, pattern));
	}
	return matches;
}

/**
 * Rewrite matches in place. `replacement` is either a template using the same $X / $$$X
 * metavariables, or a function returning the new text. A function returning anything other than a
 * string (undefined, null, false) leaves that match alone, so `(m) => cond && \`…\`` works.
 * Returns the number of matches rewritten.
 */
function rewrite(
	pattern: string | NapiConfig,
	replacement: string | ((match: SgMatch) => unknown),
	files: string | string[] = ".",
): number {
	let count = 0;
	for (const file of sourceFiles("sg.rewrite", files)) {
		const parsed = parseFile(file);
		if (!parsed) continue;

		const edits = [];
		for (const node of parsed.root.findAll(pattern)) {
			const match = toMatch(file, node, parsed.source, pattern);
			const newText =
				typeof replacement === "function"
					? replacement(match)
					: replacement.replace(/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g, (text, _, name) => match.vars[name] ?? text);
			if (typeof newText === "string") edits.push(node.replace(newText)); // anything else (undefined, null, false) leaves it
		}
		if (edits.length === 0) continue;
		const ordered = edits.toSorted((left, right) => left.startPos - right.startPos || right.endPos - left.endPos);
		for (let index = 1; index < ordered.length; index++) {
			if (ordered[index].startPos < ordered[index - 1].endPos) {
				throw new Error(`sg.rewrite produced overlapping edits in ${JSON.stringify(file)}`);
			}
		}

		writeFileSync(file, parsed.root.commitEdits(edits));
		count += edits.length;
	}
	// Almost always a mistake, e.g. a bare name as the pattern only matches plain identifiers, not properties.
	if (count === 0) console.error(`warning: sg.rewrite matched nothing for ${JSON.stringify(pattern)}`);
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
	return { ...vars, file, line: node.range().start.line + 1, text: node.text(), vars, node };
}

// ── GritQL ────────────────────────────────────────────────────────────────────────

/**
 * Apply a GritQL pattern in place (or only match it, with dryRun). Returns the files it matched.
 * e.g. grit("`console.log($x)` => `logger.info($x)`", "src")
 */
function grit(pattern: string, paths: string | string[] = ".", options: { lang?: string; dryRun?: boolean } = {}) {
	const flags = ["--force", "--jsonl"];
	if (options.dryRun) flags.push("--dry-run");
	if (options.lang) flags.push("--language", options.lang);

	const result = Bun.spawnSync(["grit", "apply", ...flags, pattern, ...[paths].flat()], { env: process.env });
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

Object.assign(globalThis, {
	$,
	glob: (...args: Parameters<typeof glob>) => logged("glob", args, () => glob(...args)),
	grep: (...args: Parameters<typeof grep>) => logged("grep", args, () => grep(...args)),
	sg: {
		...astGrep,
		find: (...args: Parameters<typeof find>) => logged("sg.find", args, () => find(...args)),
		rewrite: (...args: Parameters<typeof rewrite>) => logged("sg.rewrite", args, () => rewrite(...args)),
	},
	grit: (...args: Parameters<typeof grit>) => logged("grit", args, () => grit(...args)),
});
