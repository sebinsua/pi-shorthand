// Render the stable diff result as aligned text or a single JSON object.
import { bold, groupedSymbols } from "../layout.ts";
import { fromHandle, type GraphNode } from "../model.ts";
import type { GitFile } from "./git.ts";

export interface DiffResult {
	base: string;
	baseRef?: string;
	project: string;
	tsconfig?: string;
	totalChanged?: number;
	changed: Array<
		GraphNode & {
			status: "edited" | "added" | "deleted" | "moved";
			baseRanges?: { start: number; end: number }[];
			oldPath?: string;
		}
	>;
	callers: GraphNode[];
	chains: Array<{ handles: string[]; hops: Array<{ from: string; to: string; kind: string }>; byName?: true }>;
	tests: Array<GraphNode & { byName?: true }>;
	notes: string[];
}

const listed = (items: string[], limit: number) =>
	`${items.slice(0, limit).join(", ")}${items.length > limit ? `, … (${items.length - limit} more)` : ""}`;

/** Coalesce repeated diagnostics and keep note kinds in reading order. */
export function formatDiffNotes(notes: string[]): string[] {
	const groups: string[][] = Array.from({ length: 8 }, () => []);
	const truncated: string[] = [];
	const nonTs: string[] = [];
	const imports: string[] = [];
	const outside: string[] = [];
	let extraNonTs = 0;
	let extraOutside = 0;
	for (const note of notes) {
		const truncation = note.match(/^(.+): impact truncated at \d+ callers; reverse trace used$/);
		if (truncation) truncated.push(truncation[1]);
		else if (note.endsWith(": not TypeScript")) nonTs.push(note.slice(0, -": not TypeScript".length));
		else if (/^\.\.\. \d+ more non-TS files$/.test(note)) extraNonTs += Number(note.match(/\d+/)?.[0]);
		else if (note.endsWith(": imports changed")) imports.push(note.slice(0, -": imports changed".length));
		else if (note.includes("(cap 30)")) groups[0].push(note);
		else if (note.includes(": not indexed:")) groups[2].push(note);
		else if (note.includes("deleted/renamed away")) groups[3].push(note);
		else if (note.endsWith(": file rename")) groups[4].push(note);
		else if (note.endsWith(": outside project")) outside.push(note.slice(0, -": outside project".length));
		else if (/^\.\.\. \d+ more outside-project files$/.test(note)) extraOutside += Number(note.match(/\d+/)?.[0]);
		else groups[5].push(note);
	}
	if (truncated.length)
		groups[1].push(
			`impact truncated for ${truncated.length} symbols (${listed(truncated, 5).replace(/, … \(\d+ more\)$/, ", …")}); reverse trace used`,
		);
	if (imports.length > 3) groups[5].push(`${imports.length} imports changed: ${listed(imports.toSorted(), 3)}`);
	else groups[5].push(...imports.toSorted().map((path) => `${path}: imports changed`));
	if (nonTs.length || extraNonTs) {
		const count = nonTs.length + extraNonTs;
		const names = nonTs.slice(0, 3).join(", ");
		groups[6].push(
			`${count} non-TypeScript ${count === 1 ? "file" : "files"} changed: ${names}${count > 3 ? `, … (${count - 3} more)` : ""}`,
		);
	}
	if (outside.length || extraOutside) {
		const count = outside.length + extraOutside;
		const names = outside.slice(0, 3).join(", ");
		groups[7].push(
			`${count} ${count === 1 ? "file" : "files"} changed outside the project: ${names}${count > 3 ? `, … (${count - 3} more)` : ""}`,
		);
	}
	return groups.flat();
}

// A name used on many lines of one test file is one row, its lines joined into runs.
function mergeNameSites(tests: DiffResult["tests"]): DiffResult["tests"] {
	const merged: DiffResult["tests"] = [];
	const rows = new Map<string, { node: DiffResult["tests"][number]; lines: number[] }>();
	for (const node of tests) {
		if (!node.byName || !node.site) {
			merged.push(node);
			continue;
		}
		const key = `${node.file}\u0000${node.name}`;
		const row = rows.get(key);
		if (row) row.lines.push(node.site.start);
		else {
			const created = { node, lines: [node.site.start] };
			rows.set(key, created);
			merged.push(node);
		}
	}
	return merged.map((node) => {
		const row = node.byName && node.site ? rows.get(`${node.file}\u0000${node.name}`) : undefined;
		if (!row || row.lines.length === 1) return node;
		const runs: Array<{ start: number; end: number }> = [];
		for (const line of row.lines.toSorted((a, b) => a - b)) {
			const last = runs.at(-1);
			if (last && line <= last.end + 1) last.end = line;
			else runs.push({ start: line, end: line });
		}
		const { site: _site, ...rest } = node;
		return { ...rest, ranges: runs };
	});
}

/** Show counts, file-grouped symbols, chains, sites, then bounded notes. */
export function renderDiffText(value: DiffResult, files: Map<string, GitFile>, color: boolean): string {
	const testCount = new Set(value.tests.map(({ file }) => file)).size;
	const lines = [
		`diff ${value.base.slice(0, 12)}${value.baseRef ? ` (${value.baseRef})` : ""} → working tree (${value.project})${value.tsconfig && value.tsconfig !== "tsconfig.json" ? ` (${value.tsconfig})` : ""}: ${value.totalChanged ?? value.changed.length} changed${value.totalChanged === undefined ? "" : ` (${value.changed.length} analysed)`}, ${value.callers.length} callers, ${testCount} test ${testCount === 1 ? "file" : "files"}`,
	];
	const section = (title: string, rows: string[]) => {
		if (rows.length) lines.push("", title, ...rows);
	};
	section(
		"changed",
		groupedSymbols(
			value.changed,
			color,
			(node) => {
				const item = node as DiffResult["changed"][number];
				return item.status === "deleted"
					? "deleted (base lines)"
					: item.status === "moved"
						? `moved (from ${item.oldPath})`
						: item.status;
			},
			(file) => {
				const info = files.get(file);
				if (!info) return file;
				if (info.status === "untracked" || info.status === "added") return `${file}  (new file)`;
				if (info.status === "deleted") return `${file}  (deleted file)`;
				if (info.oldPath) return `${file}  (renamed from ${info.oldPath})`;
				return file;
			},
		),
	);
	section("callers", groupedSymbols(value.callers, color));
	section("chains", [
		...new Set(
			value.chains.map(
				({ handles, hops, byName }) =>
					`  ${bold(handles.map((handle, index) => `${index ? (hops[index - 1]?.kind === "calls" ? " → " : ` -${hops[index - 1]?.kind ?? "unknown"}→ `) : ""}${fromHandle(handle)?.name ?? handle}`).join(""), color)}${byName ? "  (by name)" : ""}`,
			),
		),
	]);
	section(
		"tests",
		groupedSymbols(
			mergeNameSites(value.tests).map((node) => ({ ...node, kind: "test" })),
			color,
			(node) => (node.byName ? "(by name)" : ""),
		),
	);
	section(
		"notes",
		formatDiffNotes(value.notes)
			.slice(0, 40)
			.map((note) => `  ${note}`),
	);
	if (lines.length === 1) lines.push("", "(no changes)");
	return lines.join("\n");
}
