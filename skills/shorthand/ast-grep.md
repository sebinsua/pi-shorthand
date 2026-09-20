# ast-grep patterns

A pattern is ordinary code with metavariables. It has to parse on its own, so match a whole
expression or statement (`oldApi($$$A)`, `const $X = $Y`), not a fragment.

- `$X` matches one node and captures its text, as `m.X` (or `m.vars.X`).
- `$$$X` matches zero or more nodes, e.g. all the arguments, keeping the original text, commas
  included.
- `$_` matches one node without capturing it.

```ts
sg.find("oldApi($$$ARGS)", "src"); // [{ file, line, text, vars, node }]
sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)", "src"); // template
sg.rewrite("oldApi($A)", (m) => m.A !== "0" && `newApi(${m.A})`, "src"); // function
```

A function returns the new text; returning anything else (`undefined`, `null`, `false`) leaves that
match alone. If nested matches would produce overlapping edits, `sg.rewrite` throws instead of
silently dropping a replacement or returning an inaccurate count.

## Inserting, moving and removing syntax

For JS/TS, use matches from `sg.find` or `sg.one(pattern, files)`, which requires exactly one match.
`sg.file(path)` selects a root inside the repository, including ignored files; missing files and
directories are created only on insertion.

```ts
sg.insert("initialize();", { before: sg.one("run();", "src/app.ts") });
sg.move(sg.one("function helper() { $$$BODY }", "src/old.ts"), {
	endOf: sg.file("src/new.ts"),
});
sg.remove(sg.find("obsolete();", "src")); // single match or array; validates the batch before writing
```

Choose one destination: `before`/`after` a whole statement or declaration (`"run();"`), or
`startOf`/`endOf` a file root or `statement_block`. For a function, select its body explicitly.
Argument lists and class bodies aren't supported.

To copy, use `sg.insert(source.text, destination)`. `sg.move(source, destination, transform?)`
accepts an optional `(text) => string` returning non-empty replacement text.

**Rematch after each edit to a file**; use array removal for matches from one search. Adjacent comments stay in
place, and interior whitespace is preserved. Imports and bindings aren't repaired. If placement
rejects joined statement boundaries, add explicit semicolons.

## Renaming a name

A bare name as the pattern (`sg.rewrite("oldName", "newName")`) only matches plain identifiers, not
property names (`obj.oldName`, `{ oldName: 1 }`, interface fields). To rename a name everywhere it
appears in code (but not in strings), match it by kind:

```ts
const anyName = [
	"identifier",
	"property_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
	"type_identifier",
];
sg.rewrite({ rule: { regex: "^oldName$", any: anyName.map((kind) => ({ kind })) } }, "newName", "src");
```

## Rule objects

When a pattern alone can't say it, pass a rule instead:

```ts
sg.find({ rule: { kind: "import_statement" } }, "src");
sg.find({ rule: { pattern: "console.log($$$A)", inside: { kind: "function_declaration", stopBy: "end" } } }, "src");
sg.find(
	{ rule: { pattern: "console.log($$$A)", not: { inside: { kind: "function_declaration", stopBy: "end" } } } },
	"src",
);
```

`kind` names come from tree-sitter (`function_declaration`, `call_expression`, `import_statement`,
…). `stopBy: "end"` searches all ancestors, not just the parent.

## ast-grep's own API

When an edit depends on context a pattern can't express, use ast-grep's JavaScript API directly.
It's on `sg` under its usual names, and `import { parse, Lang } from "@ast-grep/napi"` works too:

```ts
const file = "src/app.ts";
const root = sg.parse(sg.Lang.TypeScript, await Bun.file(file).text()).root();
const edits = root.findAll("app.get($PATH, $$$HANDLERS)").map((node) => {
	const path = node.getMatch("PATH")!; // edit just the captured node
	return path.replace(path.text().toLowerCase());
});
await Bun.write(file, root.commitEdits(edits));
```

## Other languages

`sg.find` and `sg.rewrite` handle JS, TS, TSX, HTML and CSS. For anything else, use the CLI:
File, directory and glob inputs may be relative or absolute; results are always repository-relative.
All input forms use Git's tracked and non-ignored file set, so explicitly naming an ignored file does
not include it.

```ts
const matches = await $`ast-grep run -p 'print($A)' -l python --json=compact src`.json();
await $`ast-grep run -p 'print($A)' -r 'log($A)' -l python -U src`; // -U applies the rewrite
```
