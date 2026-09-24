/** Conservative diagnostics for the editing program, not the source being edited. */
import type { SgNode } from "@ast-grep/napi";

type Origin = "match" | "node" | "root" | undefined;

export function discardedEdits(root: SgNode): string[] {
	// Only follow unique, immutable bindings. Ambiguous/shadowed names are deliberately ignored.
	const bindings = new Map<string, SgNode | null>();
	const bind = (name: SgNode, value: SgNode | null) => {
		const kinds = ["identifier", "type_identifier", "shorthand_property_identifier_pattern"];
		const names = kinds.includes(String(name.kind()))
			? [name]
			: name.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } });
		for (const identifier of names) {
			const key = identifier.text();
			bindings.set(key, bindings.has(key) ? null : value);
		}
	};
	for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
		const name = declaration.field("name");
		if (name)
			bind(
				name,
				name.kind() === "identifier" && declaration.parent()?.text().startsWith("const ")
					? declaration.field("value")
					: null,
			);
	}
	for (const fn of root.findAll({
		rule: {
			any: [
				{ kind: "arrow_function" },
				{ kind: "function_expression" },
				{ kind: "function_declaration" },
				{ kind: "method_definition" },
				{ kind: "generator_function" },
				{ kind: "generator_function_declaration" },
				{ kind: "class_declaration" },
				{ kind: "class" },
			],
		},
	})) {
		const name = fn.field("name");
		if (name) bind(name, null);
		const parameters = fn.field("parameters") ?? fn.field("parameter");
		if (parameters) bind(parameters, null);
	}
	for (const node of root.findAll({
		rule: {
			any: [
				{ kind: "assignment_expression" },
				{ kind: "augmented_assignment_expression" },
				{ kind: "update_expression" },
				{ kind: "catch_clause" },
				{ kind: "import_clause" },
				{ kind: "for_in_statement" },
			],
		},
	})) {
		const target = node.field("left") ?? node.field("argument") ?? node.field("parameter") ?? node;
		bind(target, null);
	}
	if (bindings.has("sg")) return [];

	function origin(node: SgNode | null, seen = new Set<string>()): Origin {
		if (!node) return;
		if (
			["parenthesized_expression", "non_null_expression", "as_expression", "satisfies_expression"].includes(
				String(node.kind()),
			)
		) {
			return origin(node.children().find((child) => child.isNamed()) ?? null, seen);
		}
		if (node.kind() === "identifier") {
			const name = node.text();
			if (seen.has(name)) return;
			seen.add(name);
			return origin(bindings.get(name) ?? null, seen);
		}
		if (node.kind() === "member_expression" && node.field("property")?.text() === "node") {
			return origin(node.field("object"), seen) === "match" ? "node" : undefined;
		}
		if (node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (fn?.kind() !== "member_expression") return;
		const receiver = fn.field("object");
		const method = fn.field("property")?.text();
		if (receiver?.text() === "sg") {
			if (method === "one" || method === "file") return "match";
			if (method === "parse") return "root";
		}
		const parent = origin(receiver, seen);
		if (parent === "root" && method === "root") return "node";
		if (parent === "node") {
			if (method === "getRoot") return "root";
			if (["field", "getMatch", "parent", "child", "find"].includes(method ?? "")) return "node";
		}
	}

	const warnings: string[] = [];
	for (const statement of root.findAll({ rule: { kind: "expression_statement" } })) {
		const call = statement.children().find((child) => child.isNamed());
		if (call?.kind() !== "call_expression") continue;
		const fn = call.field("function");
		if (fn?.kind() !== "member_expression" || fn.field("property")?.text() !== "replace") continue;
		if (origin(fn.field("object")) !== "node") continue;
		warnings.push(
			`line ${call.range().start.line + 1}: node.replace() returns an edit; this result was discarded. Return it from sg.rewrite(match, m => ...) to apply it, or pass it to commitEdits().`,
		);
	}
	return warnings;
}

/**
 * After a failure: a program that loaded the TypeScript package and then hit a TypeError was probably
 * reaching for a compiler API that TypeScript 7 no longer ships. Only said when that is the version resolved.
 */
export function typeScriptApiHint(program: string, output: string, version: string | undefined): string[] {
	if (!/\bTypeError\b/.test(output)) return [];
	if (!/(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["']typescript["']/.test(program)) return [];
	if (!version || Number.parseInt(version, 10) < 7) return [];
	return [
		`typescript resolves to ${version} here, which no longer has the classic compiler API (ts.createSourceFile, ts.SyntaxKind and so on); its unstable replacement is typescript/unstable/sync. Use sg to read and edit syntax, or refactor.rename and refactor.renameFile for refactors.`,
	];
}
