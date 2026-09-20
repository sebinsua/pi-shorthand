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

For shapes that placement doesn't support (such as class methods), derive the declaration from
captured text or source slices and write it with Bun. Preserve bindings and dependencies;
moving text alone doesn't make state-dependent code pure.

## Finding what to change

```ts
glob("src/**/*.ts"); // files git sees, sorted
grep("oldApi(", "src"); // [{ file, line, text }]; pass a RegExp for a pattern
sg.find("oldApi($$$ARGS)", "src"); // by syntax, when matching text isn't enough
```

Work out the files to change here, in the program, rather than copying a list from earlier output:
then it can't miss one.

## Commands

```ts
const files = await $`git ls-files`.text(); // shell commands run inside the code environment
```

Interpolated values become single, safely quoted arguments; an array becomes several.

## The shape of a program

1. Find what to change.
2. Change it: read, transform in memory, write.
3. Print a short summary, not whole files. The diff comes back anyway.

```ts
const files = [...new Set(grep("oldApi", "src").map((match) => match.file))];
for (const file of files) {
	const source = await Bun.file(file).text();
	await Bun.write(file, source.replaceAll("oldApi", "newApi"));
}

console.log(`updated ${files.length} files`);
```

After the edit, inspect the diff and run the repository's configured verification (for example,
`npm run check` or a relevant test command) separately with the shell tool, using the project's
supported runtime. Keep verification out of the editing program.

## Options

- `timeout`: 2 seconds unless you pass more. Pass more for longer transformations.
- `rollback: "file"`: after a timeout, keep changed files that were no longer open for writing when
  the program was killed, if writer inspection succeeds. An inspection failure, exception or crash
  applies nothing. Use this only when each retained file stands on its own.
