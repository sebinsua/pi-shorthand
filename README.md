# pi-shorthand

![A code call in Pi: the verdict, then the diff it applied, then the program's output](https://raw.githubusercontent.com/sebinsua/pi-shorthand/main/docs/screenshot.png)

A [Pi](https://github.com/earendil-works/pi) tool for token-efficient writes. The model writes a whole
change as one small Bun program, in shorthand, instead of calling `read`, `edit` and `bash` over
and over: fewer tokens, and fewer round trips.

The program sees your repo as normal, but its writes are held back. If it succeeds, they're applied
and the model gets the diff. If it fails, nothing changes.

## Install

```sh
pi install npm:pi-shorthand
```

Or from GitHub (`pi install git:github.com/sebinsua/pi-shorthand`), or a local clone: `npm install`, then `pi install /path/to/pi-shorthand`.

A project install (`pi install -l`) only loads once you trust the project: Pi asks, or run `pi --approve`.

You also need Bun, git, and either [bubblewrap](https://github.com/containers/bubblewrap) 0.9+
(Linux) or [AgentFS](https://github.com/tursodatabase/agentfs) (macOS:
`curl -fsSL https://agentfs.ai/install | bash`).

## What a program can use

Anything in Bun or Node, plus these globals (no imports):

```ts
await $`bun test src/api.test.ts`; // Bun's shell (the only async one)
glob("src/**/*.ts"); // → ["src/a.ts", …]
grep("oldApi(", "src"); // → [{ file, line, text }, …]
sg.find("oldApi($$$ARGS)", "src"); // ast-grep search
sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)", "src");
sg.parse(sg.Lang.TypeScript, source); // ast-grep's own API (or import from "@ast-grep/napi")
grit("`console.log($x)` => `logger.info($x)`", "src");
```

## Options

- `rollback`: `"all"` (default) applies nothing if the program fails. `"file"` keeps the files it
  finished writing.
- `timeout`: seconds before the program is killed. Default 2.

## Good to know

- Only files git tracks, or would track, are applied.
- On macOS your repo is briefly swapped for the overlay while a program runs (about 150 ms), so your
  editor may notice. On Linux each run snapshots the checkout first; reflinks make that cheap where
  supported, while other filesystems copy its contents and use corresponding temporary space.
- To try it with only `read` and `code`: `pi --tools read,code`.
- To watch runs as they happen, including each command a program starts: `tail -f ~/.cache/pi-shorthand/runs.jsonl`.

## Developing

`npm run check` type-checks (TypeScript 7), lints (oxlint) and checks formatting (oxfmt). A pre-commit
hook runs it; `npm run format` fixes formatting.

`npm test` runs the tests against real overlays (it needs AgentFS on macOS, bubblewrap on Linux).
`test/linux.sh` runs them on Linux in Docker.

`bun e2e/run.ts --repo <path or git URL> --task "…" --setup baseline|code|read-code --check "…"` runs Pi
with a real model on a fresh copy of a repo and summarises what it did (time, turns, tool calls,
tokens, whether the check passed).
