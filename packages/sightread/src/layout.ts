// Share aligned, file-grouped symbol rows and terminal colours across query and diff.
import { basename } from "node:path";
import type { GraphNode } from "./model.ts";

export const bold = (value: string, color: boolean) => (color ? `\u001b[1m${value}\u001b[0m` : value);
export const dim = (value: string, color: boolean) => (color ? `\u001b[2m${value}\u001b[0m` : value);
export const unnamedTest = (node: GraphNode) => !!node.site && node.name === basename(node.file);
export const displayName = (node: GraphNode) => (unnamedTest(node) ? "" : node.name);
export const displayKind = (node: GraphNode) =>
	node.kind ? `${node.exported ? "exported " : ""}${node.kind}` : unnamedTest(node) ? "test" : "reference";

export function range(node: GraphNode): string {
	if (node.site) return `${node.site.start}${node.site.end === node.site.start ? "" : `-${node.site.end}`}`;
	return node.ranges?.length ? node.ranges.map(({ start, end }) => `${start}-${end}`).join(", ") : "range unavailable";
}

/** Render each file once, with columns sized independently within that file. */
export function groupedSymbols<T extends GraphNode>(
	nodes: T[],
	color: boolean,
	suffix?: (node: T) => string,
	header?: (file: string) => string,
): string[] {
	const rows: string[] = [];
	for (const file of new Set(nodes.map((node) => node.file))) {
		const fileNodes = nodes.filter((node) => node.file === file);
		const ordered = fileNodes.flatMap((node) =>
			node.site && fileNodes.some((other) => !other.site && other.name === node.name)
				? []
				: [node, ...(!node.site ? fileNodes.filter((other) => !!other.site && other.name === node.name) : [])],
		);
		const width = Math.max(...ordered.map((node) => range(node).length));
		const nameWidth = Math.max(...ordered.map((node) => displayName(node).length));
		const kindWidth = Math.max(...ordered.map((node) => displayKind(node).length));
		rows.push(bold(header?.(file) ?? file, color));
		for (const node of ordered) {
			const span = range(node);
			const name = displayName(node);
			const extra = suffix?.(node);
			rows.push(
				`  ${" ".repeat(width - span.length)}${dim(span, color)}${name ? `  ${bold(name, color)}${" ".repeat(nameWidth - name.length + 2)}` : `  ${" ".repeat(nameWidth + 2)}`}${dim(displayKind(node), color)}${extra ? `${" ".repeat(kindWidth - displayKind(node).length + 2)}${extra}` : ""}`.trimEnd(),
			);
		}
	}
	return rows;
}
