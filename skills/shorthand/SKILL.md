---
name: shorthand
description: Edit repository files with Bun programs using plain text edits or structural matching. Read the advanced guide for extraction and complex refactors.
---

# Shorthand

Use text replacement for known source; use structural matching when it saves enumerating
occurrences or preserves varying syntax. Ordinary JavaScript strings, loops and Bun APIs work.
Run tests, type-checks and builds separately with the shell tool after editing.

## Replace known text

```ts
edit({ path: "src/config.ts", oldText: "timeoutMs: 1000", newText: "timeoutMs: 3000" });
```

`edit` replaces exactly one literal occurrence, throwing if it is missing or ambiguous. Include
surrounding text to distinguish repeated occurrences. Replacement text is literal, including `$`.
Line-ending differences are accepted when matching.
`edit` calls are synchronous and can be combined in one program; later calls see earlier changes.

## Semantic TypeScript refactors

Use the TypeScript language server to rename symbols or move files across the project:

```ts
await ts.rename({ file: "src/users.ts", symbol: "parseUser", to: "decodeUser" });
await ts.renameFile({ from: "src/users.ts", to: "src/models/users.ts" });
```

`ts.rename` requires the declaration name to be unique in its file and leaves unrelated symbols
alone. `ts.renameFile` moves the file and updates imports and exports that resolve to it. Read
[Semantic TypeScript refactors](advanced-refactors.md#semantic-typescript-refactors) for selection
rules, updated paths and failure conditions.

## Insert before or after a statement

Validate an order immediately before saving it:

```ts
const save = sg.one("await saveOrder(order);", "checkout.ts");
sg.insert("validateOrder(order);", { before: save });
```

Use `{ after: save }` to insert after it instead. `sg.one(pattern, files?)` requires exactly one
match. Select the whole statement, including its semicolon, for before/after insertion in JS/TS.

## Replace calls while keeping their arguments

Switch logging calls without reproducing their arguments:

```ts
sg.rewrite("console.log($$$ARGS)", "logger.info($$$ARGS)", "src");
```

`sg.rewrite(pattern, replacement, files?)` discovers, parses and writes matching files. Omit the
scope for the working directory, or pass a file, directory or glob. `$X` captures one syntax node;
`$$$X` captures a sequence. Captures can appear in the replacement text.

## Change one argument and preserve the rest

Migrate numeric retry limits to options objects, leaving existing options alone:

```ts
sg.rewrite("connect($URL, $RETRIES)", (m) => {
	const retries = m.node.getMatch("RETRIES")!;
	return retries.kind() === "number" ? retries.replace(`{ retries: ${retries.text()} }`) : null;
});
```

A callback returns text to replace the whole match, a native edit for part of it, or `null` to skip.
**`node.replace()` constructs an edit; return it from the callback so `sg.rewrite` applies it.**

## Replace an implementation while keeping its signature

Make `calculateTotal` sum its prices, preserving parameter and return types:

```ts
const fn = sg.one(
	{ rule: { kind: "function_declaration", has: { field: "name", regex: "^calculateTotal$" } } },
	"prices.ts",
);
sg.rewrite(fn, (m) => m.node.field("body")!.replace("{ return prices.reduce((total, price) => total + price, 0); }"));
```

Use `kind: "method_definition"` with the same `has` to select a class method; match names with
`regex`, since a method's name is not an identifier pattern. `sg.rewrite(match, "new source")`
replaces the whole selected node instead. `sg.find` returns an
array: pass it once to `sg.rewrite(matches, callback)` for independent edits. Each call writes
immediately within the editing workspace; select again if a later edit depends on that write.

## Write files or replace plain text

```ts
await Bun.write("src/defaults.ts", "export const retryLimit = 3;\n");
const source = await Bun.file("src/config.ts").text();
await Bun.write("src/config.ts", source.replace("timeoutMs: 1000", "timeoutMs: 3000"));
```

Use repository-relative paths. Changes apply on successful exit by default; the tool reports the
diff, preserves existing UTF-8 BOMs and uniform line endings across write methods, then uses a
detected project formatter. Counters and console summaries aren't required.

**For extraction or more complex rewrites, read [advanced-refactors.md](advanced-refactors.md).**
It covers reusing existing source, rule objects, moving/removing syntax, native APIs, GritQL and
other languages. The bundled TypeScript 7 package has no legacy compiler API; use the supplied
structural tools instead.
