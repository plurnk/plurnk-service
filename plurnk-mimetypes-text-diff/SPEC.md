# Diff handler

## §diff-line-budget Hunk line budgets, combined diffs, sections, and projections

- **Hunk line budget:** A hunk header `@@ -a,b +c,d @@` declares a line budget equal to the sum of every range's count. While unspent, a line's leading prefix column (`+`, `-`, or space) is authoritative content whatever follows (so `- ---` is a deletion, never a file header). Context spends 1 old + 1 new slot, addition 1 new, deletion 1 old; `\ No newline at end of file` spends 0. A hunk closes when its budget is spent, at a line without a valid prefix (rescanned as a header), or at EOF; it never throws.
- **Combined diffs:** `diff --cc` / `@@@` with $N$ parent ranges has $N$ prefix columns per line and one budget summed over all ranges; a line counts as an addition when any column is `+` (including conflict markers) and a deletion when any column is `-`.
- **File sections:** `diff --git`, `diff --cc`, `diff --combined`, or a bare `---`/`+++` pair opens a file section; paths strip `a/`, `b/`, `c/`, `i/`, `w/` prefixes, tab-separated timestamps, and quotes (`/dev/null` is `null`). `rename from`/`rename to` set rename paths; `Binary files` and `GIT binary patch` mark binary; `index`, modes, and similarity extend the section; lines outside any section are skipped.

| Surface | Contract |
|---|---|
| `validate` | Framework default no-op ({§mimetype-channel-selection}). |
| `extractRaw` | One `module` per file section (named by new path, old path for pure deletion, or `old → new` for rename) and one `field` per hunk contained by its section ({§mimetype-symbol}), named by hunk heading text when present, else `@@ +c,d`. Coordinates span the diff document, not the target file. |
| `deepJson` | `{ type: "diff", files: [{ type: "file", oldPath, newPath, additions, deletions, binary, hunks: [{ type: "hunk", oldStart, oldCount, newStart, newCount, heading }] }] }`, with complete source regions on document, file, and hunk nodes. |
| JSONPath / XPath | Default dispatch over `deepJson` ({§mimetype-query}): file and hunk nodes have exact regions; scalar fields have their node's enclosing region. |

`content` and `references` use framework defaults. Raw source remains unchanged; bytes decode as UTF-8.
