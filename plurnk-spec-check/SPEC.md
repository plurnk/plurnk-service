# Specification checker

## §spec-check-cli Execution, external contract imports, and source selection

`plurnk-spec-check [directory] [--import pkg-or-path] [--witness prefix-or-tag] [--allowance file] [--write]` checks a Git source tree. The directory defaults to the current working directory; an allowance path is relative to that directory. `--help` prints usage without inspecting a tree. Unknown options, extra operands, unresolvable `--import` targets, malformed allowance data, and I/O failures fail the command. Success exits zero; violations exit nonzero with their file and line locations.

| Option | Multiplicity | Contract |
| --- | --- | --- |
| `--import <pkg-or-path>` | Repeatable | Loads external `SPEC.md` heading declarations from an installed npm package (`<pkg>/SPEC.md` resolved from `<directory>/package.json`) or a file/directory path (`./path/to/SPEC.md` or `../pkg`) into the tag symbol table for citation resolution and duplicate/shadowing detection, without re-checking the imported document's own outgoing prose citations. |
| `--witness <prefix-or-tag>` | Repeatable | Requires the checked tree to supply both an implementation/panel witness and a test witness for every imported declaration matching an exact tag (`foo`) or hyphenated prefix (`client-`). |
| `--allowance <file>` | Optional | Path (relative to `<directory>`) to a shrinking JSON map `{ "<spec-path>": ["<tag>", ...] }` excusing known unwitnessed local or `--witness`-selected imported tags. |
| `--write` | Optional | Rewrites `--allowance` to the exact minimal unwitnessed-anchor map; requires `--allowance`. |

Git selects tracked and non-ignored untracked files. Missing tracked files, symbolic links, and files containing NUL bytes are skipped. Ordinary checking never modifies source or allowance files. The package is a CLI-only development dependency with no runtime dependencies or daemon connection.

## §spec-check-tags Declarations, witnesses, and provenance

| Element | Contract |
| --- | --- |
| Declaration (`§lowercase-kebab`) | Declares one named contract at the first semantic position of a Markdown heading (`#`–`######`) in `SPEC.md`, sharing its heading with a title and owning at least one non-whitespace body line before the next heading or end of file. Paragraph, list-item, and table-row declarations, duplicate declarations (across local and `--import`ed specifications), tag-only headings, and bodyless declarations fail with locations. |
| Citation (`{§lowercase-kebab}`) | Cites an existing, unambiguous declaration in the selected source tree or `--import`ed specifications (`CHANGELOG.md` release history is exempt). Unresolved, ambiguous, or unbraced/malformed named tags outside code examples fail. |
| Code examples | Fenced, inline, and indented Markdown code blocks are inert and neither declare nor cite tags. Numeric references (`§3`, `§3.bis`) are presentation. |
| Dual witnesses | Every local declared tag and every `--witness`-matched imported tag requires both an implementation/panel citation (outside Markdown prose and test files) and a test citation (`*.test.*` or `test/`), or an entry in the shrinking `--allowance` map (updated only via `--write`). |
| Tagged tests | Every deterministic `test()` / `it()` block (`*.test.*` outside `tiers/live/`, `tiers/demo/`, `test/live/`, `test/demo/`, and `test/term/`) must cite at least one `{§lowercase-kebab}` tag in its title. |
| Issue provenance | Unqualified `plurnk-repo#N` shorthands outside code examples fail; local `#N`, owner-qualified `owner/repo#N`, and full URLs are permitted. |
