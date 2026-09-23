import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { parse } from "@ast-grep/napi";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { editingFiles } from "./file-outcomes.ts";
import { notifyTypeScriptServer, recordTypeScriptFiles, withTypeScriptServer } from "./lsp-client.ts";
import { scriptLanguage } from "./placement.ts";
import {
	existingProjectFile,
	planWorkspaceEdit,
	projectPath,
	type Position,
	type AdjustEdit,
	type Range,
	type WorkspaceEdit,
} from "./workspace-edit.ts";

export interface RenameOptions<File = string> {
	file: File;
	symbol: string;
	to: string;
}

export interface RenameFileOptions<File = string> {
	from: File;
	to: File;
}

interface DocumentSymbol {
	name: string;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

interface SymbolInformation {
	name: string;
	location: { range: Range };
}

export async function rename(root: string, options: RenameOptions): Promise<void> {
	validateRename(options);
	const file = existingProjectFile(root, options.file);
	const uri = pathToFileURL(file).href;
	await withTypeScriptServer(root, async (server) => {
		const symbols = await server.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
		);
		const positions = findSymbols(symbols ?? [], options.symbol);
		if (positions.length === 0)
			throw new Error(
				`refactor.rename found no declaration named ${JSON.stringify(options.symbol)} in ${JSON.stringify(options.file)}`,
			);
		if (positions.length > 1)
			throw new Error(
				`refactor.rename found more than one declaration named ${JSON.stringify(options.symbol)} in ${JSON.stringify(options.file)}`,
			);
		const edit = await server.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
			textDocument: { uri },
			position: positions[0],
			newName: options.to,
		});
		const changes = planWorkspaceEdit(root, edit, keepShorthandPropertyNames(options.symbol));
		if (changes.size === 0) throw new Error(`TypeScript returned no edits for ${JSON.stringify(options.symbol)}`);
		editingFiles([...changes.keys()], () => {
			for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
		});
		await filesChanged(server, [...changes.keys()]);
	});
}

/**
 * The server renames without aliases, so imports and re-exports follow the new name (see lsp-client.ts). That
 * would also change the key of an object literal shorthand such as `{ parseUser }`, while reads of that property
 * keep the old key. Expand those to `parseUser: decodeUser` so only the referenced value changes.
 */
function keepShorthandPropertyNames(symbol: string): AdjustEdit {
	const shorthands = new Map<string, Set<number>>();
	return (file, source, start, end, text) => {
		if (source.slice(start, end) !== symbol) return text;
		let starts = shorthands.get(file);
		if (!starts) {
			const lang = scriptLanguage(file);
			const nodes = lang
				? parse(lang, source)
						.root()
						.findAll({ rule: { kind: "shorthand_property_identifier" } })
				: [];
			starts = new Set(nodes.map((node) => node.range().start.index));
			shorthands.set(file, starts);
		}
		return starts.has(start) ? `${symbol}: ${text}` : text;
	};
}

export async function renameFile(root: string, options: RenameFileOptions): Promise<void> {
	validateRenameFile(options);
	const from = existingProjectFile(root, options.from);
	const to = projectPath(root, options.to);
	if (from === to) throw new Error("refactor.renameFile source and destination are the same file");
	if (lstatSync(to, { throwIfNoEntry: false }))
		throw new Error(`refactor.renameFile destination already exists: ${JSON.stringify(options.to)}`);

	await withTypeScriptServer(root, async (server) => {
		const files = [{ oldUri: pathToFileURL(from).href, newUri: pathToFileURL(to).href }];
		const edit = await server.sendRequest<WorkspaceEdit | null>("workspace/willRenameFiles", { files });
		const changes = planWorkspaceEdit(root, edit);
		editingFiles([...changes.keys(), from, to], () => {
			for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
			mkdirSync(dirname(to), { recursive: true });
			renameSync(from, to);
		});
		await notifyTypeScriptServer(server, "workspace/didRenameFiles", { files });
		await filesChanged(
			server,
			[...changes.keys()].filter((file) => file !== from),
			[from],
			[to],
		);
	});
}

async function filesChanged(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	changed: string[],
	deleted: string[] = [],
	created: string[] = [],
): Promise<void> {
	recordTypeScriptFiles(server, [...changed, ...deleted, ...created]);
	await notifyTypeScriptServer(server, "workspace/didChangeWatchedFiles", {
		changes: [
			...changed.map((file) => ({ uri: pathToFileURL(file).href, type: 2 })),
			...deleted.map((file) => ({ uri: pathToFileURL(file).href, type: 3 })),
			...created.map((file) => ({ uri: pathToFileURL(file).href, type: 1 })),
		],
	});
}

function validateRename(options: RenameOptions): void {
	if (
		!options ||
		typeof options.file !== "string" ||
		typeof options.symbol !== "string" ||
		typeof options.to !== "string"
	)
		throw new TypeError("refactor.rename expects { file, symbol, to } strings");
	if (!options.file || !options.symbol || !options.to)
		throw new Error("refactor.rename file, symbol and to must not be empty");
}

function validateRenameFile(options: RenameFileOptions): void {
	if (!options || typeof options.from !== "string" || typeof options.to !== "string")
		throw new TypeError("refactor.renameFile expects { from, to } strings");
	if (!options.from || !options.to) throw new Error("refactor.renameFile from and to must not be empty");
}

function findSymbols(symbols: Array<DocumentSymbol | SymbolInformation>, name: string): Position[] {
	const positions: Position[] = [];
	for (const symbol of symbols) {
		if (symbol.name === name)
			positions.push("selectionRange" in symbol ? symbol.selectionRange.start : symbol.location.range.start);
		if ("children" in symbol && symbol.children) positions.push(...findSymbols(symbol.children, name));
	}
	return positions;
}
