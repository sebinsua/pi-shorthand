// Parse syntax ranges for graph symbols without loading the target project.
import { readFile, realpath, stat } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { API } from "typescript/unstable/async";
import {
	SyntaxKind,
	isClassDeclaration,
	isConstructorDeclaration,
	isEnumDeclaration,
	isFunctionDeclaration,
	isGetAccessorDeclaration,
	isIdentifier,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isSetAccessorDeclaration,
	isTypeAliasDeclaration,
	isVariableStatement,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import type { FileSystem } from "typescript/unstable/fs";

export type DeclarationKind = "function" | "class" | "method" | "property" | "variable" | "interface" | "type" | "enum";

export interface Declaration {
	name: string;
	kind: DeclarationKind;
	start: number;
	end: number;
	codeStart: number;
}

/** Use the graph's kind for a parsed declaration. */
export function graphKind(kind: DeclarationKind): DeclarationKind {
	return kind === "property" ? "variable" : kind;
}

export function handleFor(file: string, declaration: Declaration): string {
	return `${file}#${declaration.name}:${graphKind(declaration.kind)}`;
}

/** A function-local variable is parsed for ranges but is not a graph symbol. */
export function indexedDeclarations(items: Declaration[]): Declaration[] {
	const functions = new Set(items.filter((item) => item.kind === "function").map((item) => item.name));
	return items.filter((item) => ![...functions].some((name) => item.name.startsWith(`${name}.`)));
}

export interface SymbolRef {
	file: string;
	name: string;
	kind: string;
	line?: number;
}

export interface RangeIndex {
	declarations(file: string): Promise<Declaration[] | undefined>;
	rangesFor(ref: SymbolRef): Promise<Array<{ start: number; end: number }> | undefined>;
	close(): Promise<void>;
}

export interface DeclarationParser {
	parse(fileName: string, text: string): Promise<Declaration[]>;
	close(): Promise<void>;
}

let nextVirtualRoot = 0;

/** One TypeScript API process reused across parses. Close it when done. */
export function createDeclarationParser(): DeclarationParser {
	const root = `/__sightread_ranges_${process.pid}_${++nextVirtualRoot}`;
	const config = `${root}/tsconfig.json`;
	const files = new Map<string, string>([[config, '{"compilerOptions":{"allowJs":true},"include":["*"]}']]);
	const fs: FileSystem = {
		readFile: (file) => files.get(file) ?? (file.startsWith(`${root}/`) ? null : undefined),
		fileExists: (file) => files.has(file),
		directoryExists: (directory) => directory === root || directory === "/",
		getAccessibleEntries: (directory) =>
			directory === root
				? { files: [...files.keys()].map((file) => file.slice(root.length + 1)), directories: [] }
				: undefined,
		realpath: (file) => file,
	};
	let api = new API({ cwd: root, fs });
	let configured = false;
	let exited = false;
	let watched: ChildProcess | undefined;
	let sequence: Promise<unknown> = Promise.resolve();
	let closed = false;

	const parse = (fileName: string, text: string): Promise<Declaration[]> => {
		const task = sequence.then(async () => {
			if (closed) throw new Error("Range index is closed");
			if (exited) {
				await api.close();
				api = new API({ cwd: root, fs });
				configured = false;
				watched = undefined;
				exited = false;
				throw new Error("TypeScript parser process exited");
			}
			const extension = extname(fileName) || ".ts";
			const file = `${root}/source${extension}`;
			const existing = files.has(file);
			files.set(file, text);
			const snapshot = await api.updateSnapshot({
				...(configured ? {} : { openProjects: [config] }),
				...(existing ? {} : { openFiles: [file] }),
				fileChanges: existing ? { changed: [file] } : { created: [file] },
			});
			const child = (api as unknown as { client: { process?: ChildProcess } }).client.process;
			if (child && child !== watched) {
				watched = child;
				child.once("exit", () => {
					exited = true;
				});
			}
			api.clearSourceFileCache();
			configured = true;
			try {
				const project = await snapshot.getDefaultProjectForFile(file);
				const sourceFile = await project?.program.getSourceFile(file);
				return sourceFile ? collectDeclarations(sourceFile) : [];
			} finally {
				await snapshot.dispose();
			}
		});
		sequence = task.catch(() => undefined);
		return task;
	};

	return {
		parse,
		async close() {
			closed = true;
			await sequence;
			await api.close();
		},
	};
}

function isDefault(node: Node): boolean {
	return (
		"modifiers" in node &&
		Array.isArray(node.modifiers) &&
		node.modifiers.some((modifier: Node) => modifier.kind === SyntaxKind.DefaultKeyword)
	);
}

function collectDeclarations(sourceFile: SourceFile): Declaration[] {
	const declarations: Declaration[] = [];
	const line = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
	const add = (name: string, kind: DeclarationKind, node: Node) => {
		declarations.push({
			name,
			kind,
			start: line(node.getStart(sourceFile, true)),
			end: line(Math.max(node.getStart(sourceFile), node.end - 1)),
			codeStart: line(node.getStart(sourceFile)),
		});
	};
	const addVariables = (statement: Node, prefix = "") => {
		if (!isVariableStatement(statement)) return;
		for (const variable of statement.declarationList.declarations) {
			if (isIdentifier(variable.name)) add(`${prefix}${variable.name.text}`, "variable", statement);
		}
	};
	for (const statement of sourceFile.statements) {
		if (isFunctionDeclaration(statement) && (statement.name || isDefault(statement))) {
			const name = statement.name?.text ?? "default";
			add(name, "function", statement);
			for (const inner of statement.body?.statements ?? []) addVariables(inner, `${name}.`);
		} else if (isClassDeclaration(statement) && (statement.name || isDefault(statement))) {
			const name = statement.name?.text ?? "default";
			add(name, "class", statement);
			for (const member of statement.members) {
				if (isConstructorDeclaration(member)) add(`${name}.__constructor`, "method", member);
				else if (isMethodDeclaration(member) || isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member))
					add(`${name}.${member.name.getText(sourceFile)}`, "method", member);
				else if (isPropertyDeclaration(member)) add(`${name}.${member.name.getText(sourceFile)}`, "property", member);
			}
		} else if (isInterfaceDeclaration(statement)) {
			const name = statement.name.text;
			add(name, "interface", statement);
			for (const member of statement.members) {
				if (isMethodSignatureDeclaration(member)) add(`${name}.${member.name.getText(sourceFile)}`, "method", member);
				else if (isPropertySignatureDeclaration(member))
					add(`${name}.${member.name.getText(sourceFile)}`, "property", member);
			}
		} else if (isTypeAliasDeclaration(statement)) add(statement.name.text, "type", statement);
		else if (isEnumDeclaration(statement)) add(statement.name.text, "enum", statement);
		else addVariables(statement);
	}
	return declarations;
}

/** Parse source held in memory, using its extension to select TypeScript's script kind. */
export async function parseDeclarations(fileName: string, text: string): Promise<Declaration[]> {
	const parser = createDeclarationParser();
	try {
		return await parser.parse(fileName, text);
	} finally {
		await parser.close();
	}
}

/** Cache project files by disk metadata and reuse one TypeScript API process. */
export function createRangeIndex(root: string, options: { maxFiles?: number } = {}): RangeIndex {
	const absoluteRoot = resolve(root);
	const cache = new Map<string, { mtimeMs: number; size: number; declarations: Declaration[] }>();
	const inFlight = new Map<string, Promise<Declaration[] | undefined>>();
	const maxFiles = Math.max(0, options.maxFiles ?? 64);
	let parser: DeclarationParser | undefined;
	let closed = false;
	const insideRoot = (file: string) => {
		const path = relative(absoluteRoot, file);
		return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
	};
	const readDeclarations = async (absolute: string, file: string): Promise<Declaration[] | undefined> => {
		try {
			const actualRoot = await realpath(absoluteRoot);
			const actualFile = await realpath(absolute);
			const path = relative(actualRoot, actualFile);
			if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
			const metadata = await stat(absolute);
			if (!metadata.isFile()) return undefined;
			const cached = cache.get(absolute);
			if (cached?.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) return cached.declarations;
			const text = await readFile(absolute, "utf8");
			parser ??= createDeclarationParser();
			const parsed = await parser.parse(file, text);
			cache.delete(absolute);
			if (maxFiles > 0) {
				cache.set(absolute, { mtimeMs: metadata.mtimeMs, size: metadata.size, declarations: parsed });
				if (cache.size > maxFiles) cache.delete(cache.keys().next().value!);
			}
			return parsed;
		} catch (error) {
			if (["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
				return undefined;
			console.error(`sightread parser: ${error instanceof Error ? error.message : String(error)}`);
			const failed = parser;
			parser = undefined;
			await failed?.close().catch(() => undefined);
			return undefined;
		}
	};
	const declarations = async (file: string): Promise<Declaration[] | undefined> => {
		if (closed || isAbsolute(file) || file.includes("\\") || file.split("/").includes("..")) return undefined;
		const absolute = resolve(absoluteRoot, file);
		if (!insideRoot(absolute)) return undefined;
		const pending = inFlight.get(absolute);
		if (pending) return pending;
		const task = readDeclarations(absolute, file);
		inFlight.set(absolute, task);
		try {
			return await task;
		} finally {
			inFlight.delete(absolute);
		}
	};
	return {
		declarations,
		async rangesFor(ref) {
			const parsed = await declarations(ref.file);
			if (!parsed) return undefined;
			const matches = parsed.filter(
				(declaration) =>
					declaration.name === ref.name &&
					(declaration.kind === ref.kind ||
						(ref.kind === "property" && declaration.kind === "variable") ||
						(ref.kind === "variable" && declaration.kind === "property")),
			);
			if (!matches.length) return undefined;
			const mergeable = ["function", "interface", "method", "enum"].includes(ref.kind);
			const onLine = ref.line === undefined ? [] : matches.filter((declaration) => declaration.codeStart === ref.line);
			return (mergeable || !onLine.length ? matches : onLine).map(({ start, end }) => ({ start, end }));
		},
		async close() {
			closed = true;
			await Promise.all(inFlight.values());
			await parser?.close();
			cache.clear();
		},
	};
}
