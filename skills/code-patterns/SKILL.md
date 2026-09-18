---
name: code-patterns
description: Pattern syntax for the code tool's sg and grit helpers. Use when writing an ast-grep or GritQL pattern for a code program, or when one doesn't match what you expected.
---

# code tool patterns

The `code` tool's description covers its API. Read these only when you need them:

- [ast-grep.md](ast-grep.md): `sg.find` / `sg.rewrite` patterns, rule objects, and other languages.
- [gritql.md](gritql.md): `grit` patterns, rewrites and `where` clauses.

With the default rollback, a failed program changes nothing, so fix the pattern and run it again
without asking. The change is done when the program's own checks pass (no leftover matches, and
`tsc` or the relevant tests if the change could break them) and the diff shows what you meant.
