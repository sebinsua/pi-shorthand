---
name: shorthand
description: How to write repository edits as a code program, with Bun's file APIs and ast-grep or GritQL rewrites. Use when a code program edits several files, extracts existing source, or rewrites code by its structure.
---

# Shorthand

A `code` program is a transaction: Bun runs it against the repository, and its writes are applied only
if it exits successfully. Find the edit targets, transform the source, and print a short summary.
Keep the program focused on editing. Run tests, type-checks, builds and other verification separately
afterward with the shell tool.

Treat existing source as input to the program: read it at runtime and reuse its text or captures.
For an extraction, derive the new declaration from the existing body; emit the new glue rather than
copying the body or a whole expected file into a string literal. New implementations still need new code.

Use `sg.rewrite` for structural replacements, including conditional ones: its callback has capture
text (`m.X`) and the matched node (`m.node.getMatch("X")`) for syntax checks. Read the ast-grep guide
when you need these operations; ordinary file transformations don't require every guide below.

The injected helpers and bundled CLIs belong to the `code` environment; don't assume they exist in
an ordinary `bash` call.

- [writing.md](writing.md): the everyday part. The environment, Bun's file and shell APIs, and the
  shape of a program that transforms many files.
- [ast-grep.md](ast-grep.md): when a text replace isn't safe. Structural search, rewrite and placement, rule
  objects, and ast-grep's own API.
- [gritql.md](gritql.md): GritQL rewrites, including other languages.

A failed program applies nothing by default; correct the edit and rerun it. `rollback: "file"` can
retain closed files after a timeout, not after an exception or failed check. Inspect the resulting
diff and run the relevant project checks separately to verify the completed change.
