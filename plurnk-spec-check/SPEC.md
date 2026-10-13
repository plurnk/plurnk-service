# Specification checker

## §spec-check-cli Execution and source selection

`plurnk-spec-check [directory] [--allowance file] [--write]` checks a Git source
tree. The directory defaults to the current working directory; an allowance path
is relative to that directory. `--help` prints usage without inspecting a tree.
Unknown options, extra operands, malformed allowance data, and I/O failures fail
the command. Success exits zero; violations exit nonzero with their locations.

Git selects tracked and non-ignored untracked files. Missing tracked files,
symbolic links, and files containing NUL bytes are not read as source. Generated
or local files are excluded through the consuming repository's Git ignore rules.
Checking does not modify source. The package is a CLI-only development dependency
with no runtime dependencies or daemon connection.

## §spec-check-tags Declarations and citations

| Form | Contract |
|---|---|
| `§lowercase-kebab` | Declares one named contract at the first semantic position of a SPEC.md heading, paragraph, list item, or table row. The same Markdown block contains its contract text. |
| `{§lowercase-kebab}` | Cites exactly one declaration in the selected source tree. |
| Numeric section references | Presentation, not named contract tags. |
| Fenced, inline, and indented Markdown code | Inert examples: neither declarations nor citations. |

Duplicate or empty declarations, unresolved or ambiguous citations, and unbraced
or malformed named tags in supported source types fail with file/line locations.

## §spec-check-witnesses Witnesses

A declaration needs a citation outside Markdown prose. This is a traceability
check, not a claim about test quality or completeness. With no explicit allowance,
every unwitnessed declaration fails. An allowance maps specification paths to
arrays of tag names: new omissions and entries that are now witnessed or gone fail.
Only an explicit `--write` with `--allowance` regenerates that file; it does not
waive other validation failures.

## §spec-check-provenance Issue references

Unqualified `plurnk-repository#number` references are ambiguous and fail outside
Markdown code examples. Local `#number`, owner-qualified references, and complete
issue URLs are not rejected by this check. Repository guidance may be stricter.
