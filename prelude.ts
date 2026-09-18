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

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as astGrep from "@ast-grep/napi";
import { Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { $ as bunShell, Glob } from "bun";

function log(event: string, details: Record<string, unknown>) {
	const { PI_SHORTHAND_LOG, PI_SHORTHAND_RUN } = process.env;
	if (!PI_SHORTHAND_LOG) return;
	appendFileSync(
		PI_SHORTHAND_LOG,
		`${JSON.stringify({ time: new Date().toISOString(), run: PI_SHORTHAND_RUN, event, ...details })}\n`,
	);
}

/** Runs a helper, logging how long it took and how many results it returned. */
function logged<T>(helper: string, args: unknown[], run: () => T): T {
	const startedAt = performance.now();
	const result = run();
	const results = Array.isArray(result) ? result.length : result;
	log("helper", {
		helper,
		args: JSON.stringify(args).slice(0, 200),
		ms: Math.round(performance.now() - startedAt),
		results,
	});
	return result;
}

/** Bun's shell, logging each command as it starts. */
const $ = new Proxy(bunShell, {
	apply(target, thisArg, args: Parameters<typeof bunShell>) {
		const [strings, ...values] = args;
		log("command", { command: String.raw({ raw: strings.raw }, ...values).slice(0, 200) });
		return Reflect.apply(target, thisArg, args);
	},
});

/**
 * Files git sees under a directory that match a glob pattern, relative to the working directory,
 * sorted. The directory can also be given as { cwd }, as with Bun's Glob.
 */
function glob(pattern: string, where: string | { cwd?: string } = "."): string[] {
	const dir = typeof where === "string" ? where : (where.cwd ?? ".");
	const output = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir]);
	const matcher = new Glob(dir === "." ? pattern : `${dir.replace(/\/$/, "")}/${pattern}`);
	// git still lists a tracked file the program has deleted, so check it's there.
	const files = [...new Set(output.split("\0"))].filter((file) => file && matcher.match(file) && existsSync(file));
	return files.toSorted();
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
 * The JS/TS files to search. `files` is a file, a directory (the JS/TS files in it), a glob, or a list
 * of any of those. Warns if there are none, since that's almost always a mistake.
 */
function sourceFiles(helper: string, files: string | string[]): string[] {
	const found = [files].flat().flatMap((entry) => {
		const stats = statSync(entry, { throwIfNoEntry: false });
		if (stats?.isFile()) return [entry];
		if (stats?.isDirectory()) return glob("**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}", entry);
		return glob(entry);
	});
	const parseable = found.filter((file) => LANGUAGES[file.split(".").pop()!]);
	if (parseable.length === 0) console.error(`warning: ${helper} found no JS/TS files in ${JSON.stringify(files)}`);
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
