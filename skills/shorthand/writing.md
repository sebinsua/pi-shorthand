# Writing a shorthand program

## The environment

TypeScript, run by Bun in an isolated copy of the repository's working directory. Use relative paths
for repository files; on macOS the real checkout's absolute path is intentionally inaccessible. Top-level `await`
works. `glob`, `grep`, `sg` and `grit` are globals and synchronous (no `await`); Bun's `$` is async.
These injected globals and the bundled ast-grep/grit CLIs are available inside `code`, not necessarily
in ordinary shell tool calls.
On Linux, host paths outside the repository are read-only. `$TMPDIR` is a private writable filesystem
discarded with the run; the only host-writable exception is shorthand's own run log.

## Files

```ts
const source = await Bun.file("src/app.ts").text(); // .json() for JSON
await Bun.write("src/app.ts", source.replace("a", "b")); // creates missing directories
await Bun.file("src/old.ts").exists();
await Bun.file("src/old.ts").delete();
```

`node:fs` works too, including its sync API (`readFileSync`, `writeFileSync`, `renameSync`, `rmSync`).

Reuse existing source for moves and extractions. For example, this converts a matched function into
an exported function in a new file without repeating its body in the program:

```ts
const helper = sg.one("function normalize($$$PARAMS) { $$$BODY }", "src/service.ts");
sg.move(helper, { endOf: sg.file("src/normalize.ts") }, (text) => `export ${text}`);
// Update imports and callers as required by the surrounding module.
```

For class methods, select the method structurally and derive the new declaration from its text.
Write the destination with Bun; replace the original body through `node.field("body")`, as shown in
[ast-grep.md](ast-grep.md). Placement cannot move a method into a file root, but structural selection
still works. Preserve bindings and dependencies; moving text alone does not make code pure.

## Finding what to change

```ts
glob("src/**/*.ts"); // files git sees, sorted
grep("oldApi(", "src"); // [{ file, line, text }]; pass a RegExp for a pattern
sg.find("oldApi($$$ARGS)", "src"); // by syntax, when matching text isn't enough
```

`sg.rewrite` handles file discovery itself: omit its scope to search the working directory, or pass
a path, directory or glob to narrow it. Use `glob` or `grep` when your own transformation needs a file list.

## Commands

```ts
const files = await $`git ls-files`.text(); // shell commands run inside the code environment
```

Interpolated values become single, safely quoted arguments; an array becomes several.

## A complete structural edit

```ts
sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)");
```

No file loop, counter or summary is required. The tool reports the changed files and diff.
Use `console.log` for additional information that helps interpret the result.

After the edit, inspect the diff and run the repository's configured verification (for example,
`npm run check` or a relevant test command) separately with the shell tool, using the project's
supported runtime. Keep verification out of the editing program.

## Options

- `timeout`: 2 seconds unless you pass more. Pass more for longer transformations.
- `rollback: "file"`: after a timeout, keep changed files that were no longer open for writing when
  the program was killed, if writer inspection succeeds. An inspection failure, exception or crash
  applies nothing. Use this only when each retained file stands on its own.
