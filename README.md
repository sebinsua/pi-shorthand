# code

A [Pi](https://github.com/badlogic/pi-mono) tool that lets the model make a change by writing one
small Bun program, instead of calling `read`, `edit` and `bash` over and over.

The program sees your repo as normal, but its writes are held back. If it succeeds, they're applied
and the model gets the diff. If it fails, nothing changes.

## Install

```sh
cd code && npm install
pi install ~/dev/pi-extensions/code
```

You also need Bun, git, and either [bubblewrap](https://github.com/containers/bubblewrap) 0.9+
(Linux) or [AgentFS](https://github.com/tursodatabase/agentfs) (macOS:
`curl -fsSL https://agentfs.ai/install | bash`).

## What a program can use

Anything in Bun or Node, plus these globals (no imports):

```ts
await $`bun test src/api.test.ts`                   // Bun's shell
await glob("src/**/*.ts")                           // → ["src/a.ts", …]
await grep("oldApi(", "src")                        // → [{ file, line, text }, …]
await sg.find("oldApi($$$ARGS)", "src")             // ast-grep search
await sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)", "src")
await grit("`console.log($x)` => `logger.info($x)`", "src")
```

## Options

- `rollback`: `"all"` (default) applies nothing if the program fails. `"file"` keeps the files it
  finished writing.
- `timeout`: seconds before the program is killed. Default 2.

## Good to know

- Only files git tracks, or would track, are applied.
- On macOS your repo is briefly swapped for the overlay while a program runs (about 150 ms), so your
  editor may notice. On Linux nothing outside the program sees it (about 10 ms).
- To try it with only `read` and `code`: `pi --tools read,code`.
