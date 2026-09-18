# ast-grep patterns

A pattern is ordinary code with metavariables. It has to parse on its own, so match a whole
expression or statement (`oldApi($$$A)`, `const $X = $Y`), not a fragment.

- `$X` matches one node and captures it as `match.vars.X`.
- `$$$X` matches zero or more nodes, e.g. all the arguments. `vars.X` keeps the original text,
  commas included.
- `$_` matches one node without capturing it.

```ts
sg.find("oldApi($$$ARGS)", "src");                              // [{ file, line, text, vars, node }]
sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)", "src");         // template
sg.rewrite("oldApi($A)", (m) => (m.vars.A === "0" ? undefined : `newApi(${m.vars.A})`), "src");
```

A function replacement returning `undefined` leaves that match alone.

## Renaming a name

A bare name as the pattern (`sg.rewrite("oldName", "newName")`) only matches plain identifiers, not
property names (`obj.oldName`, `{ oldName: 1 }`, interface fields). To rename a name everywhere it
appears in code (but not in strings), match it by kind:

```ts
const anyName = ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "type_identifier"];
sg.rewrite({ rule: { regex: "^oldName$", any: anyName.map((kind) => ({ kind })) } }, "newName", "src");
```

## Rule objects

When a pattern alone can't say it, pass a rule instead:

```ts
sg.find({ rule: { kind: "import_statement" } }, "src");
sg.find({ rule: { pattern: "console.log($$$A)", inside: { kind: "function_declaration", stopBy: "end" } } }, "src");
sg.find({ rule: { pattern: "console.log($$$A)", not: { inside: { kind: "function_declaration", stopBy: "end" } } } }, "src");
```

`kind` names come from tree-sitter (`function_declaration`, `call_expression`, `import_statement`,
…). `stopBy: "end"` searches all ancestors, not just the parent.

## Other languages

`sg.find` and `sg.rewrite` handle JS, TS, TSX, HTML and CSS. For anything else, use the CLI:

```ts
const matches = await $`ast-grep run -p 'print($A)' -l python --json=compact src`.json();
await $`ast-grep run -p 'print($A)' -r 'log($A)' -l python -U src`;  // -U applies the rewrite
```
