# End-to-end comparisons

Every attempt runs from a copy of one recorded Git working tree, including its dirty and untracked files. The
summary records Pi's exit status and stderr, structured tool outcomes, separate token/cache/cost categories,
model and tool time, the final tracked and untracked changes, and the independent check result. A run counts as
verified only when Pi exits successfully within `--budget-seconds` and `--check` passes.

```sh
bun e2e/run.ts --repo /path/to/fixture --task "Rename the API" \
  --setup code --check "bun test" --runs 3 --budget-seconds 600
```

For a revision comparison, give both extension working trees. Each is copied to a separate frozen path before
the first attempt. Their order alternates, while every attempt starts from the same fixture state.

```sh
bun e2e/run.ts --repo /path/to/fixture --task "Rename the API" \
  --setup code --check "bun test" --runs 3 \
  --baseline-extension /path/to/baseline --candidate-extension /path/to/candidate
```

Raw Pi events and stderr are written under `e2e/results/`. `summary.jsonl` contains one `run` record per attempt
and an `experiment` record with completion rate, total cost per verified completion, and mean end-to-end latency
for each revision. Cost is Pi's estimate for the configured model rather than an invoice.
