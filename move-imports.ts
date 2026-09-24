/**
 * Import and export updates for moving a top-level JS/TS declaration to another file. This is module and
 * scope bookkeeping, done from syntax: which names the declaration uses, which files import it, and what the
 * source file still needs. Cases syntax cannot settle soundly are refused before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import { scriptLanguage } from "./placement.ts";

export interface TextEdit {
	start: number;
	end: number;
	text: string;
}

export interface FileEdits {
	file: string;
	source: string;
	root: SgNode;
	edits: TextEdit[];
}

export interface ImportPlan {
	source: TextEdit[];
	target: TextEdit[];
	importers: FileEdits[];
	/** The moved declaration is not exported but the source still uses it, so the target must export it. */
	exportMoved: boolean;
}

export interface MoveInput {
	sourceFile: string;
	node: SgNode;
	targetFile: string;
	targetRoot: SgNode;
	/** Files that may mention any of these names: every JS/TS file Git sees would also do. */
	filesMentioning: (names: string[]) => string[];
	/** Files that may load modules dynamically, with import() or require(). */
	filesLoadingModules: () => string[];
}

const DECLARATIONS = new Set([
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"lexical_declaration",
	"variable_declaration",
]);
const TYPE_DECLARATIONS = new Set(["interface_declaration", "type_alias_declaration"]);
/** Statements that declare a name without being a movable declaration: overloads and ambient or merged declarations. */
const OTHER_DECLARATIONS = new Set(["function_signature", "ambient_declaration", "module", "internal_module"]);
const REFERENCES = new Set(["identifier", "type_identifier", "shorthand_property_identifier"]);

class MoveError extends Error {
	constructor(message: string) {
		super(`refactor.move: ${message}`);
	}
}

interface Declaration {
	names: string[];
	types: Set<string>;
	exported: boolean;
}

/** The names a top-level statement declares, or null when it is not a movable declaration. */
function declaration(statement: SgNode): Declaration | null {
	let inner = statement;
	let exported = false;
	if (statement.kind() === "export_statement") {
		const declared = statement.field("declaration");
		if (!declared) return null;
		if (statement.children().some((child) => child.kind() === "default"))
			throw new MoveError("moving a default export is not supported yet");
		inner = declared;
		exported = true;
	}
	if (!DECLARATIONS.has(String(inner.kind()))) return null;
	const names =
		inner.kind() === "lexical_declaration" || inner.kind() === "variable_declaration"
			? inner
					.children()
					.filter((child) => child.kind() === "variable_declarator")
					.flatMap((declarator) => patternNames(declarator.field("name")))
			: [inner.field("name")?.text()].filter((name): name is string => Boolean(name));
	const types = new Set(TYPE_DECLARATIONS.has(String(inner.kind())) ? names : []);
	return { names, types, exported };
}

/** The one top-level statement of a file that declares `symbol`, for moving it by name. */
export function topLevelDeclaration(root: SgNode, symbol: string, file: string): SgNode {
	const found = root.children().filter((statement) => {
		try {
			return declaration(statement)?.names.includes(symbol);
		} catch {
			return statement.field("declaration")?.field("name")?.text() === symbol;
		}
	});
	if (found.length === 0) throw new MoveError(`found no top-level declaration of ${symbol} in ${file}`);
	if (found.length > 1) throw new MoveError(`${symbol} has overloads or merged declarations in ${file}`);
	return found[0]!;
}

/** Names bound by a declaration pattern, leaving out default values and property keys. */
function patternNames(pattern: SgNode | null): string[] {
	if (!pattern) return [];
	const kind = pattern.kind();
	if (kind === "identifier" || kind === "shorthand_property_identifier_pattern") return [pattern.text()];
	if (kind === "assignment_pattern" || kind === "object_assignment_pattern")
		return patternNames(pattern.field("left") ?? pattern.namedChildren()[0] ?? null);
	if (kind === "pair_pattern") return patternNames(pattern.field("value"));
	return pattern.namedChildren().flatMap((child) => patternNames(child));
}

const FUNCTIONS = new Set([
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"generator_function",
	"arrow_function",
	"method_definition",
]);
const DECLARED_BY_NAME = new Set([
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
]);

/** Names a scope node declares for itself: parameters, type parameters, and declarations directly in a block. */
function scopeNames(scope: SgNode): Set<string> {
	const names = new Set<string>();
	const kind = String(scope.kind());
	if (FUNCTIONS.has(kind) || kind === "class" || kind === "class_declaration" || DECLARED_BY_NAME.has(kind)) {
		const parameters = scope.field("parameters");
		for (const parameter of parameters?.namedChildren() ?? [])
			for (const name of patternNames(parameter.field("pattern") ?? parameter.namedChildren()[0] ?? null))
				names.add(name);
		if (scope.field("parameter")) for (const name of patternNames(scope.field("parameter"))) names.add(name);
		for (const parameter of scope.field("type_parameters")?.namedChildren() ?? [])
			if (parameter.field("name")) names.add(parameter.field("name")!.text());
		// A function or class expression can refer to its own name.
		if ((kind === "function_expression" || kind === "class") && scope.field("name"))
			names.add(scope.field("name")!.text());
	}
	if (kind === "catch_clause") for (const name of patternNames(scope.field("parameter"))) names.add(name);
	if (kind === "for_in_statement") for (const name of patternNames(scope.field("left"))) names.add(name);
	const statements =
		kind === "statement_block" || kind === "class_body"
			? scope.namedChildren()
			: kind === "for_statement"
				? [scope.field("initializer")]
				: [];
	for (const statement of statements) {
		if (!statement) continue;
		const inner = statement.kind() === "export_statement" ? statement.field("declaration") : statement;
		if (!inner) continue;
		if (inner.kind() === "lexical_declaration" || inner.kind() === "variable_declaration")
			for (const declarator of inner.namedChildren())
				if (declarator.kind() === "variable_declarator")
					for (const name of patternNames(declarator.field("name"))) names.add(name);
		if (DECLARED_BY_NAME.has(String(inner.kind())) && inner.field("name")) names.add(inner.field("name")!.text());
	}
	return names;
}

/**
 * Names a node refers to that no enclosing scope inside it declares: its dependencies, and globals. Each
 * reference is checked against its own enclosing scopes, so a nested local that shares a name with an
 * import does not hide the import's other uses.
 */
function freeNames(node: SgNode): string[] {
	const scopes = new Map<string, Set<string>>();
	const declaredBy = (scope: SgNode) => {
		const key = `${scope.kind()}:${scope.range().start.index}:${scope.range().end.index}`;
		if (!scopes.has(key)) scopes.set(key, scopeNames(scope));
		return scopes.get(key)!;
	};
	const { start, end } = node.range();
	const names = new Set<string>();
	for (const reference of node.findAll({ rule: { any: [...REFERENCES].map((kind) => ({ kind })) } })) {
		const name = reference.text();
		let local = false;
		for (const ancestor of reference.ancestors()) {
			const range = ancestor.range();
			if (range.start.index < start.index || range.end.index > end.index) break;
			if (declaredBy(ancestor).has(name)) {
				local = true;
				break;
			}
		}
		if (!local) names.add(name);
	}
	return [...names];
}

interface Binding {
	local: string;
	/** The exported name the binding refers to; empty for default and namespace imports. */
	imported: string;
	statement: SgNode;
	/** The specifier as written, e.g. "b as c", "type T", "* as ns" or a default name. */
	text: string;
	kind: "default" | "namespace" | "named";
	typeOnly: boolean;
	module: string;
}

function moduleName(statement: SgNode): string | undefined {
	const source = statement.field("source");
	return source?.text().slice(1, -1);
}

function quoteOf(statement: SgNode): string {
	return statement.field("source")?.text()[0] ?? '"';
}

function typeOnlyStatement(statement: SgNode): boolean {
	return statement.children().some((child) => child.kind() === "type");
}

function importBindings(root: SgNode): Binding[] {
	const bindings: Binding[] = [];
	for (const statement of root.children()) {
		if (statement.kind() !== "import_statement") continue;
		const module = moduleName(statement)!;
		const all = typeOnlyStatement(statement);
		const clause = statement.children().find((child) => child.kind() === "import_clause");
		for (const part of clause?.namedChildren() ?? []) {
			if (part.kind() === "identifier")
				bindings.push({
					local: part.text(),
					imported: "",
					statement,
					text: part.text(),
					kind: "default",
					typeOnly: all,
					module,
				});
			if (part.kind() === "namespace_import") {
				const local = part.namedChildren().at(-1)!.text();
				bindings.push({
					local,
					imported: "",
					statement,
					text: `* as ${local}`,
					kind: "namespace",
					typeOnly: all,
					module,
				});
			}
			if (part.kind() === "named_imports")
				for (const specifier of part.namedChildren()) {
					if (specifier.kind() !== "import_specifier") continue;
					const local = (specifier.field("alias") ?? specifier.field("name"))!.text();
					const typeOnly = all || specifier.children().some((child) => child.kind() === "type");
					const imported = specifier.field("name")!.text();
					bindings.push({ local, imported, statement, text: specifier.text(), kind: "named", typeOnly, module });
				}
		}
	}
	return bindings;
}

interface TopLevel {
	declarations: Map<string, { statement: SgNode; exported: boolean; type: boolean }[]>;
	/** Names exported by a local list such as `export { a, b as c }`. */
	listed: Set<string>;
}

function topLevel(root: SgNode): TopLevel {
	const declarations = new Map<string, { statement: SgNode; exported: boolean; type: boolean }[]>();
	const listed = new Set<string>();
	const add = (name: string, entry: { statement: SgNode; exported: boolean; type: boolean }) =>
		declarations.set(name, [...(declarations.get(name) ?? []), entry]);
	for (const statement of root.children()) {
		const declared = declaration(statement);
		if (declared)
			for (const name of declared.names)
				add(name, { statement, exported: declared.exported, type: declared.types.has(name) });
		const inner = statement.kind() === "export_statement" ? statement.field("declaration") : statement;
		if (inner && OTHER_DECLARATIONS.has(String(inner.kind()))) {
			const name =
				inner.field("name") ??
				inner
					.namedChildren()
					.find((child) => child.field("name"))
					?.field("name");
			if (name) add(name.text(), { statement, exported: statement.kind() === "export_statement", type: false });
		}
		if (statement.kind() === "export_statement" && !statement.field("source")) {
			const clause = statement.children().find((child) => child.kind() === "export_clause");
			for (const specifier of clause?.namedChildren() ?? []) listed.add(specifier.field("name")!.text());
		}
	}
	return { declarations, listed };
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_FOR_JS: Record<string, string[]> = {
	".js": [".ts", ".tsx"],
	".jsx": [".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
};

/**
 * The file a specifier resolves to. Relative specifiers are resolved here, including TypeScript's `.js`
 * spelling of a `.ts` file; others go through Bun's resolver, which follows tsconfig `paths` and packages
 * in node_modules, including workspace packages linked into the repository.
 */
export function resolveModule(from: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) {
		try {
			return realpathSync(Bun.resolveSync(specifier, dirname(from)));
		} catch {
			return undefined;
		}
	}
	const base = resolve(dirname(from), specifier);
	const extension = extname(base);
	const candidates = [
		base,
		...(SOURCE_FOR_JS[extension] ?? []).map((replacement) => base.slice(0, -extension.length) + replacement),
		...EXTENSIONS.map((suffix) => base + suffix),
		...EXTENSIONS.map((suffix) => resolve(base, `index${suffix}`)),
	];
	for (const candidate of candidates)
		if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
	return undefined;
}

type Style = "none" | "js" | "ts";

function styleOf(specifier: string): Style {
	if (/\.[mc]?tsx?$/.test(specifier)) return "ts";
	if (/\.[mc]?jsx?$/.test(specifier)) return "js";
	return "none";
}

/** The specifier style a file already uses for relative imports. */
function fileStyle(root: SgNode): Style {
	for (const statement of root.children()) {
		const module = ["import_statement", "export_statement"].includes(String(statement.kind()))
			? moduleName(statement)
			: undefined;
		if (module?.startsWith(".")) return styleOf(module);
	}
	return "none";
}

const JS_FOR_SOURCE: Record<string, string> = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };

function specifierFor(from: string, to: string, style: Style): string {
	let path = relative(dirname(from), to).replaceAll("\\", "/");
	if (!path.startsWith(".")) path = `./${path}`;
	const extension = extname(to);
	if (style === "ts") return path;
	const stem = path.slice(0, -extension.length);
	return style === "js" ? stem + (JS_FOR_SOURCE[extension] ?? extension) : stem;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stem = (file: string) => file.slice(0, file.length - extname(file).length);

/**
 * A specifier for `target`, written like `old`, which pointed at `source`. A relative specifier stays
 * relative. An alias or package specifier maps its ending onto the source path: "@app/api" for src/api.ts
 * means "@app/" stands for src/, so src/users/parse.ts becomes "@app/users/parse". A candidate is used only
 * if it resolves to the target; otherwise the relative path is used, which always does.
 */
function repoint(from: string, old: string, source: string, target: string): string {
	const relativeSpecifier = specifierFor(from, target, styleOf(old));
	if (old.startsWith(".")) return relativeSpecifier;
	const words = stem(old).split("/");
	const directories = stem(source).split("/");
	let shared = 0;
	while (
		shared < words.length - 1 &&
		shared < directories.length - 1 &&
		words.at(-1 - shared) === directories.at(-1 - shared)
	)
		shared++;
	if (shared === 0) return relativeSpecifier;
	const prefix = words.slice(0, -shared).join("/");
	const root = directories.slice(0, -shared).join("/");
	const within = relative(root, stem(target)).replaceAll("\\", "/");
	if (within.startsWith("..")) return relativeSpecifier;
	const extension = styleOf(old) === "none" ? "" : extname(specifierFor(from, target, styleOf(old)));
	const candidate = `${prefix}/${within}${extension}`;
	// The resolver needs the file to exist; a new target is created empty for the check and removed again.
	const created = !existsSync(target);
	try {
		if (created) {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, "");
		}
		return resolveModule(from, candidate) === (created ? realpathSync(target) : target) ? candidate : relativeSpecifier;
	} finally {
		if (created) rmSync(target, { force: true });
	}
}

function sameFile(a: string | undefined, b: string): boolean {
	return a !== undefined && (existsSync(b) ? realpathSync(b) : resolve(b)) === a;
}

function namedClause(specifiers: string[], typeOnly: boolean): string {
	return `${typeOnly ? "type " : ""}{ ${specifiers.join(", ")} }`;
}

/** One statement importing named specifiers, typed only when all of them are. */
function importStatement(
	keyword: "import" | "export",
	specifiers: { text: string; typeOnly: boolean }[],
	module: string,
	quote: string,
): string {
	const allTypes = specifiers.every((specifier) => specifier.typeOnly);
	const texts = specifiers.map((specifier) => {
		const bare = specifier.text.replace(/^type\s+/, "");
		return !allTypes && specifier.typeOnly ? `type ${bare}` : bare;
	});
	return `${keyword} ${namedClause(texts, allTypes)} from ${quote}${module}${quote};`;
}

/** Rebuild an import or re-export without some named specifiers; empty when nothing is left. */
function withoutSpecifiers(statement: SgNode, remove: Set<string>): string {
	const keyword = statement.kind() === "import_statement" ? "import" : "export";
	const allTypes = typeOnlyStatement(statement);
	const clause = statement
		.children()
		.find((child) => ["import_clause", "export_clause"].includes(String(child.kind())));
	const parts: string[] = [];
	const named: string[] = [];
	const collect = (list: SgNode) => {
		for (const specifier of list.namedChildren())
			if (!remove.has(specifier.field("name")!.text())) named.push(specifier.text());
	};
	if (clause?.kind() === "export_clause") collect(clause);
	for (const part of clause?.kind() === "import_clause" ? clause.namedChildren() : []) {
		if (part.kind() === "named_imports") collect(part);
		else parts.push(part.text());
	}
	if (named.length) parts.push(`{ ${named.join(", ")} }`);
	if (!parts.length) return "";
	return `${keyword} ${allTypes ? "type " : ""}${parts.join(", ")} from ${statement.field("source")!.text()};`;
}

/** Where new imports go: after the last import, or at the start after a shebang and directives. */
function importInsertion(root: SgNode, source: string, lines: string[]): TextEdit {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const imports = root.children().filter((child) => child.kind() === "import_statement");
	if (imports.length) {
		const end = imports.at(-1)!.range().end.index;
		return { start: end, end, text: newline + lines.join(newline) };
	}
	let offset = 0;
	for (const child of root.namedChildren()) {
		const directive = child.kind() === "expression_statement" && child.namedChildren()[0]?.kind() === "string";
		if (child.kind() !== "hash_bang_line" && !directive) break;
		const lineEnd = source.indexOf("\n", child.range().end.index);
		offset = lineEnd < 0 ? source.length : lineEnd + 1;
	}
	return { start: offset, end: offset, text: lines.join(newline) + newline };
}

/**
 * Plans every import and export edit for moving `node`, a top-level statement of `sourceFile`, to the top
 * level of `targetFile`. Returns null for statements that are not declarations, which move as plain text.
 */
export function planImports(input: MoveInput): ImportPlan | null {
	const { sourceFile, node, targetFile, targetRoot } = input;
	const moved = declaration(node);
	if (!moved) return null;
	const sourceRoot = node.getRoot().root();
	const sourceText = sourceRoot.text();
	const targetText = targetRoot.text();
	const names = new Set(moved.names);
	const source = topLevel(sourceRoot);
	for (const name of names) {
		if (source.declarations.get(name)!.length > 1)
			throw new MoveError(`${name} has overloads or merged declarations in ${sourceFile}`);
		if (source.listed.has(name))
			throw new MoveError(`${name} is exported by an export list in ${sourceFile}; export the declaration itself`);
	}
	const realTarget = existsSync(targetFile) ? realpathSync(targetFile) : resolve(targetFile);

	const sourceBindings = importBindings(sourceRoot);
	const targetBindings = importBindings(targetRoot);
	const target = topLevel(targetRoot);
	const sourceEdits: TextEdit[] = [];
	const targetEdits: TextEdit[] = [];
	const targetImports = new Map<string, { quote: string; specifiers: { text: string; typeOnly: boolean }[] }>();
	const addTargetImport = (module: string, quote: string, specifier: { text: string; typeOnly: boolean }) => {
		const entry = targetImports.get(module) ?? { quote, specifiers: [] };
		entry.specifiers.push(specifier);
		targetImports.set(module, entry);
	};
	const targetLines: string[] = [];
	const style = (root: SgNode, fallback: SgNode) => {
		const own = fileStyle(root);
		return own === "none" ? fileStyle(fallback) : own;
	};

	// The target's imports of the moved names become local; any other binding of those names conflicts.
	const importedFromSource = (binding: Binding) => sameFile(resolveModule(targetFile, binding.module), sourceFile);
	const nowLocal = new Map<SgNode, Set<string>>();
	for (const binding of targetBindings) {
		if (binding.kind !== "named" || !names.has(binding.imported) || !importedFromSource(binding)) continue;
		if (binding.local !== binding.imported)
			throw new MoveError(`${targetFile} imports ${binding.imported} as ${binding.local}`);
		nowLocal.set(binding.statement, (nowLocal.get(binding.statement) ?? new Set()).add(binding.imported));
	}
	for (const name of names) {
		if (target.declarations.has(name)) throw new MoveError(`${targetFile} already declares ${name}`);
		const binding = targetBindings.find((candidate) => candidate.local === name);
		if (binding && !(binding.kind === "named" && names.has(binding.imported) && importedFromSource(binding)))
			throw new MoveError(`${targetFile} already imports a different ${name}`);
	}
	for (const [statement, removed] of nowLocal) {
		const { start, end } = statement.range();
		targetEdits.push({ start: start.index, end: end.index, text: withoutSpecifiers(statement, removed) });
	}

	// Dependencies: copy the source's imports, and import (exporting if needed) the source's own declarations.
	const fromSource: { text: string; typeOnly: boolean }[] = [];
	const free = new Set(freeNames(node));
	const order = [...sourceBindings.map((binding) => binding.local), ...source.declarations.keys()];
	const ordered = [...order.filter((name) => free.has(name)), ...[...free].filter((name) => !order.includes(name))];
	for (const name of new Set(ordered)) {
		if (names.has(name)) continue;
		const binding = sourceBindings.find((candidate) => candidate.local === name);
		const local = source.declarations.get(name)?.[0];
		const existing = targetBindings.find((candidate) => candidate.local === name);
		if (binding) {
			const resolved = resolveModule(sourceFile, binding.module);
			if (binding.module.startsWith(".") && !resolved)
				throw new MoveError(`cannot resolve ${JSON.stringify(binding.module)} from ${sourceFile}`);
			if (existing || target.declarations.has(name)) {
				const sameBinding =
					existing?.kind === binding.kind &&
					existing.imported === binding.imported &&
					(resolveModule(targetFile, existing.module) ?? existing.module) === (resolved ?? binding.module);
				if (!sameBinding) throw new MoveError(`${targetFile} already has a different ${name}`);
				continue;
			}
			// Relative specifiers are re-pointed from the target; aliases and packages mean the same from anywhere.
			const module =
				resolved && binding.module.startsWith(".")
					? specifierFor(targetFile, resolved, styleOf(binding.module))
					: binding.module;
			const quote = quoteOf(binding.statement);
			if (binding.kind === "named") addTargetImport(module, quote, { text: binding.text, typeOnly: binding.typeOnly });
			else targetLines.push(`import ${binding.typeOnly ? "type " : ""}${binding.text} from ${quote}${module}${quote};`);
		} else if (local) {
			if (existing || target.declarations.has(name)) {
				if (existing?.kind === "named" && existing.imported === name && importedFromSource(existing)) continue;
				throw new MoveError(`${targetFile} already has a different ${name}`);
			}
			if (!local.exported) {
				const { start, end } = local.statement.range();
				sourceEdits.push({ start: start.index, end: end.index, text: `export ${local.statement.text()}` });
			}
			fromSource.push({ text: name, typeOnly: local.type });
		} else if (existing || target.declarations.has(name)) {
			// A global in the source would refer to the target's own binding after the move.
			throw new MoveError(`${name} is a global where it is used, but ${targetFile} declares its own ${name}`);
		}
	}
	if (fromSource.length) {
		const module = specifierFor(targetFile, sourceFile, style(targetRoot, sourceRoot));
		for (const specifier of fromSource) addTargetImport(module, '"', specifier);
	}
	for (const [module, { quote, specifiers }] of targetImports)
		targetLines.push(importStatement("import", specifiers, module, quote));
	if (targetLines.length) targetEdits.push(importInsertion(targetRoot, targetText, targetLines));

	// The source imports the declaration back if code left there still uses it.
	const { start: movedStart, end: movedEnd } = node.range();
	const stillUsed = sourceRoot
		.findAll({ rule: { any: [...REFERENCES].map((kind) => ({ kind })) } })
		.some((reference) => {
			const { start } = reference.range();
			if (start.index >= movedStart.index && start.index < movedEnd.index) return false;
			if (!names.has(reference.text())) return false;
			const statement = reference.ancestors().find((ancestor) => ancestor.parent()?.kind() === "program");
			return statement?.kind() !== "import_statement" && !(statement && moduleName(statement));
		});
	if (stillUsed) {
		const module = specifierFor(sourceFile, targetFile, style(sourceRoot, targetRoot));
		const specifiers = moved.names.map((name) => ({ text: name, typeOnly: moved.types.has(name) }));
		sourceEdits.push(importInsertion(sourceRoot, sourceText, [importStatement("import", specifiers, module, '"')]));
	}

	// Importers of an exported declaration are repointed at the target. A module loaded with import() or
	// require() is used as a whole object, which cannot be repointed name by name.
	const importers: FileEdits[] = [];
	if (moved.exported) {
		for (const file of new Set(input.filesLoadingModules())) {
			const fileLang = scriptLanguage(file);
			if (!fileLang || sameFile(file, sourceFile)) continue;
			for (const call of parse(fileLang, readFileSync(file, "utf8"))
				.root()
				.findAll({ rule: { kind: "call_expression" } })) {
				const callee = call.field("function")?.text();
				if (callee !== "import" && callee !== "require") continue;
				const argument = call.field("arguments")?.namedChildren()[0];
				if (argument?.kind() === "string" && sameFile(resolveModule(file, argument.text().slice(1, -1)), sourceFile))
					throw new MoveError(`${file} loads ${sourceFile} with ${callee}()`);
			}
		}
		for (const file of new Set(input.filesMentioning(moved.names))) {
			if (sameFile(file, sourceFile) || sameFile(file, targetFile)) continue;
			const fileLang = scriptLanguage(file);
			if (!fileLang) continue;
			const text = readFileSync(file, "utf8");
			const root = parse(fileLang, text).root();
			const edits: TextEdit[] = [];
			const imports: { text: string; typeOnly: boolean }[] = [];
			const reexports: { text: string; typeOnly: boolean }[] = [];
			let targetModule: string | undefined;
			let anchorEnd: number | undefined;
			let quote = '"';
			for (const statement of root.children()) {
				const module = moduleName(statement);
				if (!module || !sameFile(resolveModule(file, module), sourceFile)) continue;
				targetModule ??= repoint(file, module, sourceFile, realTarget);
				quote = quoteOf(statement);
				const all = typeOnlyStatement(statement);
				const clause = statement
					.children()
					.find((child) => ["import_clause", "export_clause"].includes(String(child.kind())));
				if (statement.children().some((child) => child.kind() === "namespace_export"))
					throw new MoveError(`${file} re-exports ${sourceFile} as a namespace`);
				if (statement.kind() === "export_statement" && !clause) {
					// `export * from source`: keep its other exports and re-export the moved ones explicitly.
					for (const name of moved.names) reexports.push({ text: name, typeOnly: moved.types.has(name) });
					anchorEnd ??= statement.range().end.index;
					continue;
				}
				const specifiers = (
					clause?.kind() === "export_clause"
						? clause.namedChildren()
						: (clause
								?.namedChildren()
								.find((part) => part.kind() === "named_imports")
								?.namedChildren() ?? [])
				).filter((specifier) => names.has(specifier.field("name")!.text()));
				const namespace = clause?.namedChildren().find((part) => part.kind() === "namespace_import");
				if (namespace) {
					const local = namespace.namedChildren().at(-1)!.text();
					if (
						moved.names.some((name) =>
							new RegExp(`(?<![\\w$])${escape(local)}\\s*\\.\\s*${escape(name)}(?![\\w$])`).test(text),
						)
					)
						throw new MoveError(`${file} uses ${local}.<name> through a namespace import`);
				}
				if (!specifiers.length) continue;
				const list = statement.kind() === "import_statement" ? imports : reexports;
				for (const specifier of specifiers)
					list.push({
						text: specifier.text(),
						typeOnly: all || specifier.children().some((child) => child.kind() === "type"),
					});
				const { start, end } = statement.range();
				edits.push({
					start: start.index,
					end: end.index,
					text: withoutSpecifiers(statement, new Set(specifiers.map((specifier) => specifier.field("name")!.text()))),
				});
			}
			if (!targetModule || (!imports.length && !reexports.length)) continue;
			const lines = [
				...(imports.length ? [importStatement("import", imports, targetModule, quote)] : []),
				...(reexports.length ? [importStatement("export", reexports, targetModule, quote)] : []),
			];
			// New statements take the place of the first statement they came from, keeping its position.
			const newline = text.includes("\r\n") ? "\r\n" : "\n";
			const first = edits[0];
			if (first) first.text = [first.text, ...lines].filter(Boolean).join(newline);
			else edits.push({ start: anchorEnd!, end: anchorEnd!, text: newline + lines.join(newline) });
			importers.push({ file, source: text, root, edits });
		}
	}
	return { source: sourceEdits, target: targetEdits, importers, exportMoved: stillUsed && !moved.exported };
}
