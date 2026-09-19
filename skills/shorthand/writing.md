# Writing a shorthand program

## The environment

TypeScript, run by Bun in an isolated copy of the repository's working directory. Use relative paths
for repository files; on macOS the real checkout's absolute path is intentionally inaccessible. Top-level `await`
works. `glob`, `grep`, `sg` and `grit` are globals and synchronous (no `await`); Bun's `$` is async.
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
await $`bun test src/api.test.ts`; // throws if it fails, so a failing check fails the program
const count = await $`git grep -c oldApi`.nothrow().text(); // .nothrow(): check the exit code yourself
await $`npx tsc --noEmit -p .`.quiet(); // .quiet(): keep its output out of yours
```

Interpolated values become single, safely quoted arguments; an array becomes several.

## The shape of a program

1. Find what to change.
2. Change it: read, transform in memory, write.
3. Check it: look for leftovers, run the type-checker or the tests that cover it, and throw if
   something's wrong. Then nothing is applied, and you get the error.
4. Print a summary (counts, anything surprising), not whole files. The diff comes back anyway.

```ts
const files = [...new Set(grep("oldApi", "src").map((match) => match.file))];
for (const file of files) {
	const source = await Bun.file(file).text();
	await Bun.write(file, source.replaceAll("oldApi", "newApi"));
}

const left = grep("oldApi", "src");
if (left.length > 0) throw new Error(`oldApi is still used at ${left.map((m) => `${m.file}:${m.line}`).join(", ")}`);
await $`npx tsc --noEmit -p .`.quiet();
console.log(`updated ${files.length} files`);
```

## Options

- `timeout`: 2 seconds unless you pass more. Pass more when the program runs `tsc` or tests.
- `rollback: "file"`: after a timeout, keep changed files that were no longer open for writing when
  the program was killed, if writer inspection succeeds. An inspection failure, exception or crash
  applies nothing. Use this only when each retained file stands on its own.
