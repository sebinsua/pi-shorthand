---
name: shorthand
description: How to write a whole change as one code program, with Bun's file and shell APIs, checks, and ast-grep or GritQL rewrites. Use when a code program edits several files, rewrites code by its structure, or checks its own change.
---

# Shorthand

A `code` program is a transaction: Bun runs it against the repository, and its writes are applied only
if it exits successfully. So write the whole change as one program: find what to change, change it,
check it, and print a short summary.

- [writing.md](writing.md): the everyday part. The environment, Bun's file and shell APIs, and the
  shape of a program that edits and checks many files.
- [ast-grep.md](ast-grep.md): when a text replace isn't safe. Structural search and rewrite, rule
  objects, and ast-grep's own API.
- [gritql.md](gritql.md): GritQL rewrites, including other languages.

A failed program changes nothing (unless you passed `rollback: "file"`), so fix it and run it again
without asking. It's done when its own checks pass (no leftover matches, and `tsc` or the relevant
tests where the change could break them) and the diff shows what you meant.
