/**
 * Preloaded into every `code` program. On top of ordinary Bun and Node it adds these globals:
 * $ (Bun shell), glob, grep, sg (ast-grep) and grit (GritQL).
 *
 * Everything except $ is synchronous: models often call helpers like these without await.
 * File lists come from git (tracked, plus untracked files that aren't ignored), so node_modules
 * and build output are left out on every platform.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { $, Glob } from "bun";

/** Files git sees under dir that match a glob pattern, relative to the working directory, sorted. */
function glob(pattern: string, dir = "."): string[] {
	const output = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir]);
	const matcher = new Glob(dir === "." ? pattern : `${dir.replace(/\/$/, "")}/${pattern}`);
	return [...new Set(output.split("\0"))].filter((file) => file && matcher.match(file)).toSorted();
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
	const output = git(["grep", "-n", "--null", "--untracked", "-I", ...flags, "--", ...[paths].flat()]);

	const matches = [];
	for (const line of output.split("\n")) {
		if (line === "") continue;
		const [file, lineNumber, text] = line.split("\0");
		matches.push({ file, line: Number(lineNumber), text });
	}
	return matches;
}

function git(args: string[]): string {
	return Bun.spawnSync(["git", ...args], { stderr: "ignore" }).stdout.toString();
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

/** `files` may be a list of files, a single file, a directory (the JS/TS files in it) or a glob. */
function sourceFiles(files: string | string[]): string[] {
	if (Array.isArray(files)) return files;
	const stats = statSync(files, { throwIfNoEntry: false });
	if (stats?.isFile()) return [files];
	if (stats?.isDirectory()) return glob("**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}", files);
	return glob(files);
}

function find(pattern: string | NapiConfig, files: string | string[] = "."): SgMatch[] {
	const matches: SgMatch[] = [];
	for (const file of sourceFiles(files)) {
		const parsed = parseFile(file);
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
function rewrite(
	pattern: string | NapiConfig,
	replacement: string | ((match: SgMatch) => string | undefined),
	files: string | string[] = ".",
): number {
	let count = 0;
	for (const file of sourceFiles(files)) {
		const parsed = parseFile(file);
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
	return { file, line: node.range().start.line + 1, text: node.text(), vars, node };
}

const sg = { find, rewrite };

// ── GritQL ────────────────────────────────────────────────────────────────────────

/**
 * Apply a GritQL pattern in place (or only match it, with dryRun). Returns the files it matched.
 * e.g. grit("`console.log($x)` => `logger.info($x)`", "src")
 */
function grit(pattern: string, paths: string | string[] = ".", options: { lang?: string; dryRun?: boolean } = {}) {
	const flags = ["--force", "--jsonl"];
	if (options.dryRun) flags.push("--dry-run");
	if (options.lang) flags.push("--language", options.lang);

	const result = Bun.spawnSync(["grit", "apply", ...flags, pattern, ...[paths].flat()]);

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
