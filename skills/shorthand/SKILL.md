---
name: shorthand
description: How to write repository edits as a code program, with Bun's file APIs and ast-grep or GritQL rewrites. Use when a code program edits several files, extracts existing source, or rewrites code by its structure.
---

# Shorthand

A `code` program is a transaction: Bun runs it against the repository, and its writes are applied only
if it exits successfully. The tool reports changed files and their diff; console output is optional.
Keep the program focused on editing. Run tests, type-checks, builds and other verification separately
afterward with the shell tool.

Read existing source at runtime and reuse its text or captures. For extraction, select syntax rather
than searching for braces or exact source layouts. This moves a state-independent `TableWriter.format`
implementation into `renderTable`, keeps the method as a delegate, and updates its direct caller:

```ts
const pattern = { rule: { kind: "method_definition", has: { field: "name", regex: "^format$" } } };
const method = sg.one(pattern, "writer.ts");
await Bun.write(
	"table.ts",
	'import type { Cell, FormatOptions } from "./types";\n' +
		method.text.replace(/^format\b/, "export function renderTable"),
);
sg.rewrite(method, (m) => m.node.field("body")!.replace("{ return renderTable(rows, options); }"));
await Bun.write("writer.ts", 'import { renderTable } from "./table";\n' + (await Bun.file("writer.ts").text()));
sg.rewrite('import { TableWriter } from "./writer"', 'import { renderTable } from "./table"', "export.ts");
sg.rewrite("new TableWriter().format($$$ARGS)", "renderTable($$$ARGS)", "export.ts");
```

The declaration reuses the existing signature and body; the original method gets a new body through
`field("body")`. Preserve the extracted code's imports and dependencies; moving text does not remove
its dependence on instance state. New implementations still need new code.

Use `sg.rewrite` for structural replacements, including conditional ones: its callback has capture
text (`m.X`) and syntax nodes (`m.node.getMatch("X")`). Return text to replace the match,
node edits to preserve its surroundings, or `null` to skip. `node.replace()` constructs an edit;
return it from `sg.rewrite` to apply it. Pass an existing match or match array to reuse a selection;
select again after changing its file. Pattern-based rewrites handle discovery, parsing and writing;
omit the file scope to search the working directory. Read the ast-grep guide
when you need these operations; ordinary file transformations don't require every guide below.

TypeScript 7.0 does not expose the legacy compiler API (`createSourceFile`, `ScriptTarget`) from
`typescript`; changing import syntax won't fix that. Use the supplied `sg` or `grit` for structural edits.

The injected helpers and bundled CLIs belong to the `code` environment; don't assume they exist in
an ordinary `bash` call.

- [writing.md](writing.md): the everyday part. The environment, Bun's file and shell APIs, and the
  shape of a program that transforms many files.
- [ast-grep.md](ast-grep.md): when a text replace isn't safe. Structural search, rewrite and placement, rule
  objects, and ast-grep's own API.
- [gritql.md](gritql.md): GritQL rewrites, including other languages.

A failed program applies nothing by default; correct the edit and rerun it. `rollback: "file"` can
retain closed files after a timeout, not after an exception or failed check. Inspect the resulting
diff and run the relevant project checks separately to verify the completed change.
