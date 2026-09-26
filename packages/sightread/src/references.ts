// Find every compiler-resolved use of a graph symbol in the project's real files.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { API, type Snapshot } from "typescript/unstable/async";
import {
	getTouchingPropertyName,
	isCallExpression,
	isClassDeclaration,
	isEnumDeclaration,
	isFunctionDeclaration,
	isGetAccessorDeclaration,
	isIdentifier,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isNewExpression,
	isPropertyAccessExpression,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isSetAccessorDeclaration,
	isTypeAliasDeclaration,
	isVariableDeclaration,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import { fromHandle, type GraphNode, type GraphResult } from "./model.ts";
import type { PathMapper } from "./paths.ts";
import { projectFiles, type Project } from "./project.ts";

export interface ReferenceIndex {
	query(request: Record<string, unknown>, paths: PathMapper): Promise<GraphResult>;
	close(): Promise<void>;
}

function declarationName(node: Node): string | undefined {
	if (!isIdentifier(node)) return undefined;
	const parent = node.parent;
	if (!parent || !("name" in parent) || parent.name !== node) return undefined;
	const named =
		isFunctionDeclaration(parent) ||
		isClassDeclaration(parent) ||
		isInterfaceDeclaration(parent) ||
		isTypeAliasDeclaration(parent) ||
		isEnumDeclaration(parent) ||
		isVariableDeclaration(parent) ||
		isMethodDeclaration(parent) ||
		isMethodSignatureDeclaration(parent) ||
		isPropertyDeclaration(parent) ||
		isPropertySignatureDeclaration(parent) ||
		isGetAccessorDeclaration(parent) ||
		isSetAccessorDeclaration(parent);
	if (!named) return undefined;
	if (
		isMethodDeclaration(parent) ||
		isMethodSignatureDeclaration(parent) ||
		isPropertyDeclaration(parent) ||
		isPropertySignatureDeclaration(parent) ||
		isGetAccessorDeclaration(parent) ||
		isSetAccessorDeclaration(parent)
	) {
		const owner = parent.parent;
		if (isClassDeclaration(owner) || isInterfaceDeclaration(owner))
			return `${owner.name?.text ?? "default"}.${node.text}`;
	}
	return node.text;
}

function findDeclaration(source: SourceFile, name: string): Node | undefined {
	let found: Node | undefined;
	const visit = (node: Node): void => {
		if (found) return;
		if (declarationName(node) === name) {
			found = node;
			return;
		}
		node.forEachChild(visit);
	};
	visit(source);
	return found;
}

// The call or `new` a reference is the callee of, so a call split over lines can be shown whole.
function enclosingCall(reference: Node): Node | undefined {
	let callee = reference;
	if (callee.parent && isPropertyAccessExpression(callee.parent) && callee.parent.name === callee)
		callee = callee.parent;
	const call = callee.parent;
	return call && (isCallExpression(call) || isNewExpression(call)) && call.expression === callee ? call : undefined;
}

/** Keep one TypeScript language service for a daemon's lifetime, brought up to date before each query. */
export function createReferenceIndex(project: Project): ReferenceIndex {
	const api = new API({ cwd: project.root });
	const stamps = new Map<string, string>();
	let snapshot: Snapshot | undefined;
	let sequence: Promise<unknown> = Promise.resolve();
	let closed = false;

	// Compare every project file's size and mtime with the last query's, and send TypeScript only what changed.
	const refresh = async (): Promise<Snapshot> => {
		if (closed) throw new Error("Reference index is closed");
		const files = await projectFiles(project, api);
		const current = new Map<string, string>();
		await Promise.all(
			[...files].map(async (file) => {
				const metadata = await stat(file).catch(() => undefined);
				if (metadata) current.set(file, `${metadata.mtimeMs}:${metadata.size}`);
			}),
		);
		const created = [...current.keys()].filter((file) => !stamps.has(file));
		const changed = [...current.keys()].filter((file) => stamps.has(file) && stamps.get(file) !== current.get(file));
		const deleted = [...stamps.keys()].filter((file) => !current.has(file));
		const previous = snapshot;
		if (previous && !created.length && !changed.length && !deleted.length) return previous;
		snapshot = previous
			? await api.updateSnapshot({
					openFiles: created,
					closeFiles: deleted,
					fileChanges: { changed, created, deleted },
				})
			: await api.updateSnapshot({ openProjects: [project.tsconfig], openFiles: created });
		// Record the files only once TypeScript has them, so a failed update is retried next time.
		stamps.clear();
		for (const [file, stamp] of current) stamps.set(file, stamp);
		if (previous) {
			api.clearSourceFileCache();
			await previous.dispose();
		}
		return snapshot;
	};

	const serially = <T>(task: () => Promise<T>): Promise<T> => {
		const result = sequence.then(task);
		sequence = result.catch(() => undefined);
		return result;
	};

	return {
		query: (request, paths) =>
			serially(async () => {
				if (typeof request.symbol !== "string")
					throw new Error(`request.symbol must be string (got ${JSON.stringify(request.symbol) ?? "undefined"})`);
				if (request.includeDeclaration !== undefined && typeof request.includeDeclaration !== "boolean")
					throw new Error(
						`request.includeDeclaration must be boolean (got ${JSON.stringify(request.includeDeclaration)})`,
					);
				const ref = fromHandle(request.symbol);
				if (!ref) throw new Error(`${request.symbol} not found`);
				const current = await refresh();
				const file = resolve(project.root, ref.file);
				const local = relative(project.root, file);
				if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
					throw new Error(`${request.symbol} not found`);
				const home = await current.getDefaultProjectForFile(file);
				const source = await home?.program.getSourceFile(file);
				const declaration = source && findDeclaration(source, ref.name);
				if (!home || !source || !declaration) throw new Error(`${request.symbol} not found`);
				const start = declaration.getStart(source);
				const entries = await home.checker.getReferencedSymbolsForNode(getTouchingPropertyName(source, start), start);
				const nodes: GraphNode[] = [];
				const seen = new Set<string>();
				const lines = new Map<string, string[]>();
				for (const handle of entries.flatMap((entry) => entry.references)) {
					const reference = await handle.resolve(home);
					if (!reference) continue;
					const origin = reference.getSourceFile();
					const offset = reference.getStart(origin);
					if (
						declarationName(reference) &&
						(request.includeDeclaration !== true || origin.fileName !== source.fileName || offset !== start)
					)
						continue;
					const path = relative(project.root, origin.fileName);
					if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
					const key = `${origin.fileName}:${offset}:${reference.end}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const { line, character } = origin.getLineAndCharacterOfPosition(offset);
					const end = origin.getLineAndCharacterOfPosition(reference.end);
					if (!lines.has(origin.fileName)) lines.set(origin.fileName, origin.text.split(/\r\n|\n|\r/));
					const call = enclosingCall(reference);
					const last = call ? origin.getLineAndCharacterOfPosition(call.end).line : line;
					const text = (lines.get(origin.fileName) ?? []).slice(line, last + 1).join("\n");
					const outputFile = paths.toRepositoryPath(path.split(sep).join("/"));
					nodes.push({
						handle: `${outputFile}#reference:${line + 1}:${character + 1}:${end.character + 1}`,
						name: ref.name,
						file: outputFile,
						line: line + 1,
						col: character + 1,
						endCol: end.character + 1,
						...(last > line ? { endLine: last + 1 } : {}),
						text,
						ranges: null,
					});
				}
				nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line! - b.line! || a.col! - b.col!);
				return {
					type: "references",
					shown: nodes.length,
					nodes,
					edges: [],
					sections: {
						symbol: ref.name,
						declaration: {
							file: paths.toRepositoryPath(local.split(sep).join("/")),
							line: source.getLineAndCharacterOfPosition(start).line + 1,
						},
					},
				};
			}),
		close: () =>
			serially(async () => {
				closed = true;
				await snapshot?.dispose();
				await api.close();
			}),
	};
}
