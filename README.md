# pi-shorthand

![A code call in Pi: the verdict, then the diff it applied, then the program's output](https://raw.githubusercontent.com/sebinsua/pi-shorthand/main/docs/screenshot.png?v=2)

A [Pi](https://github.com/earendil-works/pi) tool for token-efficient writes. The model writes a whole
change as one small Bun program, in shorthand, instead of calling `read`, `edit` and `bash` over
and over: fewer tokens, and fewer round trips.

The program sees your repo as normal, but its writes are held back. By default, they're applied only
if the program succeeds and destination files are unchanged, and the model gets the diff.
The program performs the edit; tests, type-checks and other verification run separately afterward.

## Install

```sh
pi install npm:pi-shorthand
```

Or from GitHub (`pi install git:github.com/sebinsua/pi-shorthand`), or a local clone: `npm install`, then `pi install /path/to/pi-shorthand`.

A project install (`pi install -l`) only loads once you trust the project: Pi asks, or run `pi --approve`.

You also need Bun, git, and either [bubblewrap](https://github.com/containers/bubblewrap) 0.9+
(Linux) or [AgentFS](https://github.com/tursodatabase/agentfs) and `clang` (macOS:
`curl -fsSL https://agentfs.ai/install | bash`).

## What a program can use

Anything in Bun or Node, plus these globals (no imports):

```ts
await $`git ls-files`.text(); // Bun's shell (the only async one)
glob("src/**/*.ts"); // → ["src/a.ts", …]
grep("oldApi(", "src"); // → [{ file, line, text }, …]
sg.find("oldApi($$$ARGS)", "src"); // ast-grep search
sg.rewrite("oldApi($$$ARGS)", "newApi($$$ARGS)", "src");
sg.insert("initialize();", { before: sg.one("run();", "src/app.ts") });
sg.move(sg.one("function helper() { $$$BODY }", "src/old.ts"), { endOf: sg.file("src/new.ts") });
sg.remove(sg.one("obsolete();", "src/app.ts"));
sg.parse(sg.Lang.TypeScript, source); // ast-grep's own API (or import from "@ast-grep/napi")
grit("`console.log($x)` => `logger.info($x)`", "src");
```

`sg.find`, `sg.one`, `sg.rewrite` and `grit` also accept `sg.file("src/app.ts")` directly, including
in arrays mixed with paths. Search reads the file's current contents. Missing targets are valid insertion
destinations but cannot be searched. An explicit target can select an ignored file inside the workspace;
the tool still only applies Git-visible changes.

[api.d.ts](api.d.ts) exposes the actual injected helper types for editor completion and external TypeScript
checking of editing programs. Include it in the program's TypeScript project (or reference
`pi-shorthand/api` via `compilerOptions.types` when installed as a package). This supplies types, not runtime
globals. Bun execution does not automatically type-check programs or run application verification.

## Options

- `title`: a short description shown with the call (required).
- `rollback`: `"all"` (default) applies nothing if the program fails. After a timeout, `"file"`
  keeps changed files that were no longer open for writing if writer inspection succeeds. Other
  failures apply nothing because open writers cannot be identified after the process exits.
- `timeout`: seconds before the program is killed. Default 2.

## Good to know

- Only files git tracks, or would track, are applied.
- Successful edits are formatted with detected installed project tools (Prettier, oxfmt, Biome, Ruff,
  Black, gofmt or rustfmt) before the final diff. Ambiguous setups are skipped; formatter failures warn
  without discarding completed edits. Set `PI_SHORTHAND_FORMAT=0` to disable. No project config is required.
- Each run snapshots the checkout first; reflinks make that cheap where supported, while other
  filesystems copy its contents and use corresponding temporary space. On macOS the program runs at
  a private AgentFS mount, so use paths relative to its working directory for repository files.
- Runs against the same checkout are serialized. If another process edits a destination while a run
  is in progress, shorthand checks it again immediately before replacing it and reports a conflict.
  A non-cooperating writer can still race the final filesystem rename or removal itself.
- To try it with only `read` and `code`: `pi --tools read,code`.
- Run history is stored in `~/.cache/pi-shorthand/runs.jsonl` with directory mode `0700` and file
  mode `0600`. It records timestamps, opaque run IDs, lifecycle events, exit status, durations,
  counts, helper names, and shell executable names. It does not record programs, output, errors,
  arguments, repository paths, file paths, or diffs. The log rotates at 1 MiB and expires after
  seven days. Set `PI_SHORTHAND_HISTORY=0` to disable it. To watch enabled history:
  `tail -f ~/.cache/pi-shorthand/runs.jsonl`.

## Developing

`npm run check` type-checks (TypeScript 7), lints (oxlint) and checks formatting (oxfmt). A pre-commit
hook runs it; `npm run format` fixes formatting.

`npm test` runs the tests against real overlays (it needs AgentFS on macOS, bubblewrap on Linux).
`test/linux.sh` runs them on Linux in Docker.

`bun e2e/suite.ts` previews the local benchmark suite without calling a model. Add `--execute` to run it.
The [comparison harness](e2e/README.md) supports stock, optional and replacement editing tools, controlled
documentation/skills, independent task checks, saved final changes and session reports.
`bun e2e/run.ts --repo <path or git URL> --task "…" --setups baseline,replace,code --check "…"` runs Pi
with a real model on fresh copies of your own repository.
