# Specification checker

## §spec-check-cli Execution and source selection

`plurnk-spec-check [directory] [--allowance file] [--write]` checks a Git source tree. The directory defaults to the current working directory; an allowance path is relative to that directory. `--help` prints usage without inspecting a tree. Unknown options, extra operands, malformed allowance data, and I/O failures fail the command. Success exits zero; violations exit nonzero with their file and line locations.

Git selects tracked and non-ignored untracked files. Missing tracked files, symbolic links, and files containing NUL bytes are skipped. Checking never modifies source files. The package is a CLI-only development dependency with no runtime dependencies or daemon connection.

## §spec-check-tags Declarations, witnesses, and provenance

| Element | Contract |
| --- | --- |
| Declaration (`§lowercase-kebab`) | Declares one named contract at the first semantic position of a Markdown heading (`#`–`######`) in `SPEC.md` and must share its heading with a title. Paragraph, list-item, and table-row declarations, duplicate declarations, and tag-only headings fail with locations. |
| Citation (`{§lowercase-kebab}`) | Cites an existing, unambiguous declaration in the selected source tree (`CHANGELOG.md` release history is exempt). Unresolved, ambiguous, or unbraced/malformed named tags outside code examples fail. |
| Code examples | Fenced, inline, and indented Markdown code blocks are inert and neither declare nor cite tags. Numeric references (`§3`, `§3.bis`) are presentation. |
| Dual witnesses | Every declared tag requires both an implementation/panel citation (outside Markdown prose and test files) and a test citation (`*.test.*` or `test/`), or an entry in the shrinking `--allowance` map (updated only via `--write`). |
| Tagged tests | Every deterministic `test()` / `it()` block (`*.test.*` outside `tiers/live/`, `tiers/demo/`, `test/live/`, `test/demo/`, and `test/tui/`) must cite at least one `{§lowercase-kebab}` tag in its title. |
| Issue provenance | Unqualified `plurnk-repo#N` shorthands outside code examples fail; local `#N`, owner-qualified `owner/repo#N`, and full URLs are permitted. |
