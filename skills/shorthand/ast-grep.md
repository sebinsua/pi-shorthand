# ast-grep patterns

A pattern is ordinary code with metavariables. It has to parse on its own, so match a whole
expression or statement (`oldApi($$$A)`, `const $X = $Y`), not a fragment.

- `$X` matches one node and captures its text, as `m.X` (or `m.vars.X`).
- `$$$X` matches zero or more nodes, e.g. all the arguments, keeping the original text, commas
  included.
- `$_` matches one node without capturing it.

```ts
sg.find("oldApi($$$ARGS)", "src"); // [{ file, line, text, vars, node }]
sg.find("oldApi($$$ARGS)", sg.file("src/app.ts")); // explicit file; also accepted by one/rewrite
sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)", "src"); // template
sg.rewrite("oldApi($A)", (m) => m.A !== "0" && `newApi(${m.A})`, "src"); // function
```

A callback returns text to replace the whole match, a native `node.replace(text)` edit (or array
of edits) to change nodes within it, or `null`/`undefined`/`false` to skip. Callbacks are synchronous.
The result counts matches producing edits, not individual edits. Overlapping edits are rejected.
Omit the file scope to search the working directory; the helper discovers, parses and writes files.

Use `getMatch("NAME")` for a capture. Replacing just the captured argument preserves the surrounding
call, including comments between arguments:

```ts
sg.rewrite("store.save($KEY, $VALUE)", (m) => {
	const value = m.node.getMatch("VALUE")!;
	return ["true", "false"].includes(value.kind()) ? value.replace(`{ durable: ${value.text()} }`) : null;
});
```

Syntax fields such as `field("body")` depend on the language and node kind.
See [SKILL.md](SKILL.md) for a complete method extraction using a body-field edit.

## Inserting, moving and removing syntax

For JS/TS, use matches from `sg.find` or `sg.one(pattern, files)`, which requires exactly one match.
`sg.file(path)` selects a JS/TS file root for placement or for scoping `find`, `one` and `rewrite`.
Pass paths or file targets individually or in mixed arrays. Missing targets are valid insertion destinations,
but cannot be searched.

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

**Rematch placement targets after each edit**; use array removal for matches from one search. Adjacent comments stay in
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

For transformations outside file-backed rewrites, use ast-grep's JavaScript API directly.
It's on `sg` under its usual names, and `import { parse, Lang } from "@ast-grep/napi"` works too:

```ts
const root = sg.parse(sg.Lang.TypeScript, sourceText).root();
const calls = root.findAll("app.get($PATH, $$$HANDLERS)");
```

## Other languages

`sg.find` and `sg.rewrite` handle JS, TS, TSX, HTML and CSS. For anything else, use the CLI:
File, directory and glob inputs may be relative or absolute; results are always repository-relative.
String inputs use Git's tracked and non-ignored file set. An explicit `sg.file()` target can select an
ignored JS/TS file inside the editing workspace.

```ts
const matches = await $`ast-grep run -p 'print($A)' -l python --json=compact src`.json();
await $`ast-grep run -p 'print($A)' -r 'log($A)' -l python -U src`; // -U applies the rewrite
```
