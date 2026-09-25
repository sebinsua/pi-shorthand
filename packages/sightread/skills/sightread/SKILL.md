---
name: sightread
description: Ask a TypeScript project what calls what, what a symbol uses and contains, and exactly which lines each piece of code spans, using the TypeScript compiler. Use it to get your bearings before reading files, to find callers or callees, and to see what a branch changed and what that affects.
---

# sightread

`sightread` answers structural questions about a TypeScript project from the compiler, with exact line
ranges. Ask it first, then read only the lines it points to, instead of searching text and opening
whole files. It graphs the nearest `tsconfig.json`, so in a monorepo run it from the package or source
folder whose code you're asking about.

## Ask in batches

Pass one request, or an array of them, as JSON. One call answers every request in it:

```sh
sightread '[{"type":"lookup","query":"formatPrice"},{"type":"trace","from":"formatPrice","direction":"reverse"}]'
```

Names work wherever a symbol is expected: `formatPrice`, `Row.get`. If a name is ambiguous or
missing, the error lists the handles to use instead, such as `src/row.ts#Row.get:method`. A request
that fails reports its error in its own slot, and the rest of the batch still answers.

## Requests

- `lookup` (`query`): find symbols by name.
- `trace` (`from`, `direction`): follow callers with `"reverse"`, callees with `"forward"`, or what
  a change affects with `"impact"`. `maxDepth` and `maxNodes` bound it.
- `details` (`handles`): what symbols call, use and contain, with the location of each
  relationship.
- `entrypoints` (`query`): where a feature starts.
- `tour` (`reinterpretations`): a walk through the code relevant to some names.
- `overview`: the project's structure; `aspect` narrows it to `hotspots`, `layers` or `publicApi`.

`sightread --help` lists every field.

## Reading the output

Symbols are grouped by file, each with its exact line range: `20-115  runWithBun  function`. Read
those lines and nothing else. Paths are relative to the repository, so they work unchanged with
other tools, including shorthand. Relationships are listed by name, with where each happens:
`main → runWithBun  calls at shorthand.ts:73`. When a list is cut short, the first line says which
field to raise.

`--json` prints the same results as data: `nodes` with `ranges`, and `edges` with `from`, `to`,
`kind` and `at`. `--in packages/api` keeps results to one part of a monorepo.

## Branches

`sightread diff [base]` lists the declarations changed since `base` (by default, where the branch
left the default branch), grouped by file, then their callers, the call chains, and the tests that
use them. Read it before reviewing or extending someone else's change.

## What it can't see

- Code reached through string keys, dynamic property access or configuration.
- A second call from the same caller: each caller is listed once, with its first call.
- Your own edits, until you ask again. Line numbers go stale when files change, so re-run the
  same query after editing rather than trusting earlier ranges.
