---
name: sightread
description: Find every place a TypeScript symbol is used, what calls what, and exactly which lines each piece of code spans, from the TypeScript compiler. Use it instead of searching text or opening files to locate code, before editing call sites, and to see what a branch changed and affects.
---

# sightread

Use `sightread` instead of searching text or opening files to find where code is and what it touches.
Its answers come from the TypeScript compiler, including uses through aliases, re-exports and
interfaces, so trust them: don't repeat the search with `rg` or `grep`.

Ask everything you need in one call, as a JSON array. Names work directly, and a name can carry its file
when the task gives one, like `src/api/users.ts#getUser`:

```sh
sightread '[{"type":"references","symbol":"Row.get"},{"type":"trace","from":"Row.get","direction":"reverse"}]'
```

- To change every use of something, ask for `references`. It lists each use with its line and text,
  the whole call when it spans lines, which is enough to edit without reading the file.
- To see what a change affects, ask for `trace` with `"direction": "reverse"`; for what something
  calls, `"forward"`.
- For what a symbol uses and contains, `details`. To get your bearings, `overview`. For a branch,
  `sightread diff`.

Read only the line ranges it gives. After editing, verify with the project's type check. Line numbers
change when files do, so ask again rather than reuse old ones.

In a monorepo, run it from the package whose code you're asking about. `sightread --help` lists every
field.
