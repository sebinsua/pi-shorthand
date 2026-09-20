# Local reference edits and failed-call recovery

Eight human-authored editing programs pass the existing independent evaluators for the three guidance tasks.
Two exact failed Sol programs also pass after correcting only their API arguments. This establishes feasible
compact edits and concrete recovery paths; it does not measure whether a model will discover or follow them.
The reference edits and deterministic replays make no model calls. A separate model recovery comparison is
summarized below. The restored skill and tool description were held fixed.

## Reference programs

Counts are characters in the complete `program` argument, including whitespace. These are readable examples
for the recorded fixtures, not proven minima or general-purpose codemods. Evaluators run separately after each
program and check behavior, the requested structure, and TypeScript correctness.

| Task                      |                                                ast-grep |                                                   GritQL |                                           Source text |
| ------------------------- | ------------------------------------------------------: | -------------------------------------------------------: | ----------------------------------------------------: |
| Extract table formatter   |      [872](reference-programs/extract-table-ast.ts.txt) |      [689](reference-programs/extract-table-grit.ts.txt) |   [848](reference-programs/extract-table-text.ts.txt) |
| Migrate boolean options   | [429](reference-programs/durability-options-ast.ts.txt) | [121](reference-programs/durability-options-grit.ts.txt) |                                                     — |
| Propagate request headers |    [694](reference-programs/request-headers-ast.ts.txt) |    [302](reference-programs/request-headers-grit.ts.txt) | [380](reference-programs/request-headers-text.ts.txt) |

All three extraction programs read and reuse the original method body. The AST version selects the method with
a contextual pattern and obtains its body from the captured node. The text version depends on the known
`format`/`record` boundaries. Both structural versions use Bun text operations for import/caller glue. The
GritQL version creates the new file from captures, then normalizes indentation in the same editing program.
It uses GritQL's documented [`$new_files` operation](https://docs.grit.io/language/idioms#creating-new-files).

Both migration programs edit only the captured boolean node, preserving the preceding comment, dynamic
expressions, existing options objects and the sample string. GritQL expresses that selection and rewrite in
one query; native ast-grep needs file discovery, parsing, an edit list and writing. No text-only migration is
presented as an equivalent structural transformation: enumerating the fixture's known literal locations
would skip the syntax-selection problem this task is intended to exercise.

The header AST version changes parameter and call nodes rather than reproducing function bodies. The text
version uses the fixture's known signatures and calls. GritQL performs signature and call transformations in
two invocations and preserves the existing layout. Two invocations avoid an observed panic in the installed
CLI's combined `sequential` query; this is not a claim that sequential queries generally fail.

One local execution per final reference took 0.89–2.38 seconds, including the overlay runner. These are not
model session times, and no latency ranking is inferred from one run. Authoring, documentation research and
failed drafts are excluded from those execution times, but their results are retained below.

## Comparison with the actual agent programs

The following are the previous-skill sessions from the latest three-condition benchmark, matching the skill
now restored in the working tree. Counts exclude shell verification and include every code retry in totals.

| Task       | Sol first programs, attempts 1 / 2 | Sol total program characters, attempts 1 / 2 | Smallest verified reference here |
| ---------- | ---------------------------------: | -------------------------------------------: | -------------------------------: |
| Extraction |                      1,976 / 1,709 |                                1,976 / 9,375 |                              689 |
| Migration  |                          693 / 925 |                                    693 / 925 |                              121 |
| Headers    |                        1,198 / 884 |                                1,198 / 1,305 |                              302 |

The second extraction's first program failed. Its subsequent attempts switched to an unavailable compiler
API, retried an import, then required a signature repair. The reference shows that neither a different parser
nor a copied formatting body was needed. In migration, much of the difference is boilerplate that GritQL's
captured-node rewrite avoids. In headers, some Sol programs generated guards, reconstructed full declarations,
or made a separate formatting call. References show these costs are not required for the fixture.

This comparison demonstrates opportunity, not attainable model speed or cost savings. The reference author
had full task and evaluator knowledge and could iterate locally. The agent still needs exploration, program
construction and separate verification. No model was told to prefer GritQL in these experiments.

## Exact failure replays and interface changes

[Replay programs](recovery-programs/) retain the first failed code programs from the concise-skill extraction
and header sessions. Their JSON metadata identifies the source session; corrected variants preserve the
program except for the changes below.

| Failure                                                  | Minimal correction                                                                         | Result                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| Standalone class-method pattern in `sg.one`              | Replace the pattern argument with a class-context pattern and `method_definition` selector | Independent evaluator passes |
| `sg.file(...)` objects supplied where paths are required | Replace the two target initializers with path strings                                      | Independent evaluator passes |

`prelude.ts` now validates `files` arguments at the helper boundary. A mistaken placement object produces a
message identifying the helper, the required path type, and a repository-relative path example. Validation
covers the whole input array before any file is edited, including when the caller catches the exception.

For a multiple-node pattern parse error, the helper checks whether the pattern matches as a class method in
context. If so, the error supplies that executable pattern object and says to replace only the pattern
argument. Otherwise it explains contextual patterns without claiming a class-method match. The pattern is
never silently changed, and the original error is preserved. Valid-call behavior and rollback modes are unchanged.

Regression tests cover all three helper names (`sg.find`, `sg.one`, `sg.rewrite`), executing the suggested
pattern, unrelated invalid snippets, and no partial edit when a path list contains an invalid argument.
The exact original failures were replayed before and after the diagnostic change, and their minimal manual
corrections passed both times. This is deterministic recovery validation, not evidence of improved model recovery.

Full API declarations and automatic type checking were not added in this change. Runtime messages address
the observed misuse without adding another compiler dependency or changing the skill. A type checker could
catch the wrong argument shape, but not invalid syntax inside a string pattern.

## Reproduce locally

Both commands require the existing overlay backend (AgentFS on macOS or bubblewrap on Linux), Bun, and installed
project dependencies. They create temporary fixtures, run the editing programs, evaluate separately, save
programs/results, and remove the fixtures. They never start Pi or call a model.

```sh
bun e2e/reference-edits.ts --out e2e/results/my-reference-run
bun e2e/replay-edit-errors.ts --out e2e/results/my-recovery-run
```

Use `--only extract-table-grit,durability-options-grit` to select references. Use a new output directory for each
run. The edit examples are `.ts.txt` files because they execute in the injected `code` environment, not as
standalone project modules.

Recorded artifacts for this investigation:

- [Final references, runtime results and independent verification](results/reference-edits-2026-09-20/verified/results.json).
- [Original failure messages](results/reference-edits-2026-09-20/recovery-before/results.json) and [final diagnostics](results/reference-edits-2026-09-20/recovery-final/results.json).
- [First drafts](results/reference-edits-2026-09-20/attempt-1/results.json), [corrected GritQL scope and second query attempt](results/reference-edits-2026-09-20/attempt-2/results.json), and [working two-call header query](results/reference-edits-2026-09-20/attempt-3/results.json).
- [Sol sessions used for comparison](results/guidance-concise-sol-2026-09-20/report.md).

The first GritQL migration draft supplied `"*.ts"` as a literal CLI path and made no changes. Supplying the
repository directory fixed the scope. GritQL's two combined header drafts panicked; separating the operations
worked. The initial extraction draft passed behavior checks but needed explicit newlines and indentation
normalization, which are included in the final 689-character count. These failures are part of the evidence,
not omitted development costs.

The [completed recovery comparison](results/recovery-sol-2026-09-20/report.md) kept the restored skill and
successful-call interface fixed. It used subscription-backed Sol with high reasoning, two failures and two
attempts per condition. Sessions started from constructed contexts containing the task, source and skill reads,
the failed program and its error; these measure recovery, not whole-task performance.
All eight sessions passed, but new diagnostics totaled 149.7 seconds versus
116.9 with the original errors. Both method-pattern attempts followed the contextual-pattern suggestion;
one introduced a new source-boundary bug while regenerating the program. All four file-path attempts replaced
the AST strategy with text replacement instead of applying the small argument correction. Clearer errors did
not establish faster or consistently local recovery in this sample. A separate experiment can test discovery
of the shorter GritQL transformations.

Both conditions had zero additional failed code calls. The new-diagnostic condition nevertheless needed seven
code calls versus four: one repaired malformed application source and two corrected indentation. Successful
tool execution alone would miss those costs. Responses producing edits accounted for 75.2 seconds with new
diagnostics versus 48.3 with original errors, explaining most of the overall difference. Compact human-authored
transformations demonstrate capability; these sessions do not establish that Sol can construct them more
cheaply or that better recovery guidance makes completion faster.
