# Specification checker

## §spec-check-cli Execution and source selection

`plurnk-spec-check [directory] [--allowance file] [--write]` checks a Git source tree. The directory defaults to the current working directory; an allowance path is relative to that directory. `--help` prints usage without inspecting a tree. Unknown options, extra operands, malformed allowance data, and I/O failures fail the command. Success exits zero; violations exit nonzero with their file and line locations.

Git selects tracked and non-ignored untracked files. Missing tracked files, symbolic links, and files containing NUL bytes are skipped. Checking never modifies source files. The package is a CLI-only development dependency with no runtime dependencies or daemon connection.

## §spec-check-tags Declarations, witnesses, and provenance

| Element | Contract |
| --- | --- |
| Declaration (`§lowercase-kebab`) | Declares one named contract in `SPEC.md` and must own contract text in the same block. Duplicate or empty declarations fail with locations. |
| Citation (`{§lowercase-kebab}`) | Cites an existing, unambiguous declaration in the selected source tree. Unresolved, ambiguous, or unbraced/malformed named tags outside code examples fail. |
| Code examples | Fenced, inline, and indented Markdown code blocks are inert and neither declare nor cite tags. Numeric references (`§3`, `§3.bis`) are presentation. |
| Witnesses | Every declared tag requires a citation outside Markdown prose (or an entry in the shrinking `--allowance` map, updated only via `--write`). |
| Issue provenance | Unqualified `plurnk-repo#N` shorthands outside code examples fail; local `#N`, owner-qualified `owner/repo#N`, and full URLs are permitted. |
