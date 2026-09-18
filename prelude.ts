/**
 * Preloaded into every `code` program. On top of ordinary Bun and Node it adds these globals:
 * $ (Bun shell), glob, grep, sg (ast-grep) and grit (GritQL).
 */

import { Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { $, Glob } from "bun";

/** Files matching a glob pattern, relative to the working directory, sorted. */
async function glob(pattern: string): Promise<string[]> {
	const files = await Array.fromAsync(new Glob(pattern).scan({ onlyFiles: true }));
	return files.sort();
}

/**
 * Search tracked and untracked (not ignored) files. A string is matched literally; a RegExp is
 * matched as a Perl-compatible regular expression, which is close to JavaScript's syntax.
 */
async function grep(pattern: string | RegExp, paths: string | string[] = ".") {
	let flags: string[];
	if (typeof pattern === "string") {
		flags = ["-F", "-e", pattern];
	} else {
		flags = ["-P", "-e", pattern.source];
		if (pattern.flags.includes("i")) flags.push("-i");
	}

	const output = await $`git grep -n --null --untracked -I ${flags} -- ${paths}`.nothrow().quiet().text();

	const matches = [];
	for (const line of output.split("\n")) {
		if (line === "") continue;
		const [file, lineNumber, text] = line.split("\0");
		matches.push({ file, line: Number(lineNumber), text });
	}
	return matches;
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

interface SgMatch {
	file: string;
	line: number;
	text: string;
	vars: Record<string, string>; // captured metavariables, e.g. vars.ARGS for $$$ARGS
	node: SgNode;
}

/** `files` may be a list of files, a single file, a directory (all JS/TS files in it) or a glob. */
async function sourceFiles(files: string | string[]): Promise<string[]> {
	if (Array.isArray(files)) return files;
	const stats = await Bun.file(files).stat().catch(() => null);
	if (stats?.isFile()) return [files];
	if (stats?.isDirectory()) return glob(`${files}/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}`);
	return glob(files);
}

async function find(pattern: string | NapiConfig, files: string | string[] = "."): Promise<SgMatch[]> {
	const matches: SgMatch[] = [];
	for (const file of await sourceFiles(files)) {
		const parsed = await parseFile(file);
		if (!parsed) continue;
		for (const node of parsed.root.findAll(pattern)) matches.push(toMatch(file, node, parsed.source, pattern));
	}
	return matches;
}

/**
 * Rewrite matches in place. `replacement` is either a template using the same $X / $$$X
 * metavariables, or a function returning the new text (or undefined to leave the match alone).
 * Returns the number of matches rewritten.
 */
async function rewrite(
	pattern: string | NapiConfig,
	replacement: string | ((match: SgMatch) => string | undefined),
	files: string | string[] = ".",
): Promise<number> {
	let count = 0;
	for (const file of await sourceFiles(files)) {
		const parsed = await parseFile(file);
		if (!parsed) continue;

		const edits = [];
		for (const node of parsed.root.findAll(pattern)) {
			const match = toMatch(file, node, parsed.source, pattern);
			const newText =
				typeof replacement === "function"
					? replacement(match)
					: replacement.replace(/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g, (text, _, name) => match.vars[name] ?? text);
			if (newText !== undefined) edits.push(node.replace(newText));
		}
		if (edits.length === 0) continue;

		await Bun.write(file, parsed.root.commitEdits(edits));
		count += edits.length;
	}
	return count;
}

/** A JS/TS/HTML/CSS file's source and syntax tree, or null for other files. */
async function parseFile(file: string) {
	const lang = LANGUAGES[file.split(".").pop()!];
	if (!lang) return null;
	const source = await Bun.file(file).text();
	return { source, root: parse(lang, source).root() };
}

function toMatch(file: string, node: SgNode, source: string, pattern: string | NapiConfig): SgMatch {
	const vars: Record<string, string> = {};
	for (const [, dollars, name] of JSON.stringify(pattern).matchAll(/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g)) {
		const nodes = dollars === "$$$" ? node.getMultipleMatches(name) : [node.getMatch(name)];
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		// Slice the original source so separators and formatting are kept ("a, b" rather than "a,b").
		if (first && last) vars[name] = source.slice(first.range().start.index, last.range().end.index);
	}
	return { file, line: node.range().start.line + 1, text: node.text(), vars, node };
}

const sg = { find, rewrite };

// ── GritQL ────────────────────────────────────────────────────────────────────────

/**
 * Apply a GritQL pattern in place (or only match it, with dryRun). Returns the files it matched.
 * e.g. await grit("`console.log($x)` => `logger.info($x)`", "src")
 */
async function grit(pattern: string, paths: string | string[] = ".", options: { lang?: string; dryRun?: boolean } = {}) {
	const flags = ["--force", "--jsonl"];
	if (options.dryRun) flags.push("--dry-run");
	if (options.lang) flags.push("--language", options.lang);

	const result = await $`grit apply ${flags} ${pattern} ${paths}`.nothrow().quiet();

	const files = [];
	for (const line of result.stdout.toString().split("\n")) {
		if (!line.startsWith("{")) continue;
		const record = JSON.parse(line);
		const matched = record.original ?? record; // rewrites nest the match under "original"
		if (matched.sourceFile) files.push({ file: matched.sourceFile, matches: matched.ranges.length });
	}
	if (result.exitCode !== 0 && files.length === 0) {
		throw new Error(`grit failed: ${result.stderr.toString().trim()}`);
	}
	return files;
}

Object.assign(globalThis, { $, glob, grep, sg, grit });
