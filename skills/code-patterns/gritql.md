# GritQL patterns

Code goes in backticks. `$x` captures a node, `=>` rewrites, and `where` adds conditions.

```ts
await grit("`oldApi($args)`", "src", { dryRun: true });                  // find: [{ file, matches }]
await grit("`console.log($m)` => `logger.info($m)`", "src");             // rewrite in place
await grit("`$f($x)` where { $f <: `oldApi` }", "src", { dryRun: true }); // conditions
await grit("`print($x)` => `log($x)`", "src", { lang: "python" });       // other languages
```

It defaults to JavaScript/TypeScript. Other languages include python, go, rust, java, ruby, css,
json and yaml.

Worth knowing:

- Each `grit` call takes about a second to start, so pass a longer `timeout` to the code tool when
  a program calls it.
- A rewrite can drop a statement's trailing semicolon. Check the diff, or use `sg.rewrite` for
  simple JS/TS rewrites.
