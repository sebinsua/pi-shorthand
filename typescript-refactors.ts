import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { editingFiles } from "./file-outcomes.ts";
import { withTypeScriptServer } from "./lsp-client.ts";
import {
	existingProjectFile,
	planWorkspaceEdit,
	type Position,
	type Range,
	type WorkspaceEdit,
} from "./workspace-edit.ts";

export interface RenameOptions<File = string> {
	file: File;
	symbol: string;
	to: string;
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
	const changes = await withTypeScriptServer(root, async (server) => {
		const symbols = await server.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
		);
		const positions = findSymbols(symbols ?? [], options.symbol);
		if (positions.length === 0)
			throw new Error(
				`ts.rename found no declaration named ${JSON.stringify(options.symbol)} in ${JSON.stringify(options.file)}`,
			);
		if (positions.length > 1)
			throw new Error(
				`ts.rename found more than one declaration named ${JSON.stringify(options.symbol)} in ${JSON.stringify(options.file)}`,
			);
		const edit = await server.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
			textDocument: { uri },
			position: positions[0],
			newName: options.to,
		});
		return planWorkspaceEdit(root, edit);
	});
	if (changes.size === 0) throw new Error(`TypeScript returned no edits for ${JSON.stringify(options.symbol)}`);
	editingFiles([...changes.keys()], () => {
		for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
	});
}

function validateRename(options: RenameOptions): void {
	if (
		!options ||
		typeof options.file !== "string" ||
		typeof options.symbol !== "string" ||
		typeof options.to !== "string"
	)
		throw new TypeError("ts.rename expects { file, symbol, to } strings");
	if (!options.file || !options.symbol || !options.to)
		throw new Error("ts.rename file, symbol and to must not be empty");
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
