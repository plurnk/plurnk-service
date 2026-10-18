# Diff handler

§diff-line-budget A hunk header `@@ -a,b +c,d @@` declares a line budget: the sum of
every range's count. While an open hunk's budget is unspent, a line's leading prefix
column (`+`, `-` or space) is authoritative content whatever text follows it, so a
deleted line that begins `---` is a deletion, never a new file header. A context line
spends one old and one new slot, an addition one new slot, a deletion one old slot;
`\ No newline at end of file` spends none and counts nothing. The hunk closes when the
budget is spent, at a line with no valid prefix (which is then rescanned as a header),
or at the end of a truncated document; it never throws.

§diff-combined A combined diff (`diff --cc`, `@@@` with N parent ranges) has N prefix
columns per line and one budget summed over every range. A line counts as an addition
when any column is `+` and as a deletion when any column is `-`, so conflict markers
are additions.

§diff-sections A `diff --git`, `diff --cc` or `diff --combined` line opens a file
section and recovers both paths; a bare `---`/`+++` pair opens one without a git line.
Paths drop an `a/`, `b/`, `c/`, `i/` or `w/` prefix, a tab-separated timestamp tail and
surrounding quotes; `/dev/null` is `null`. `rename from`/`rename to` set a rename's
paths; `Binary files` and `GIT binary patch` mark a section binary; the other extended
headers (`index`, modes, similarity) extend the section. A line outside any section is
skipped, so prose, mail signatures and an empty document yield no sections.

| Surface | Contract |
|---|---|
| `validate` | The no-op default: a diff has no fail-hard syntax ({§mimetype-validation}). |
| §diff-symbols `extractRaw` | One `module` per file section, named by the new path, by the old path for a pure deletion, or `old → new` for a rename; one `field` per hunk, contained by its section ({§mimetype-symbol-container}), named by the hunk heading text when present, else `@@ +c,d`. `line`/`endLine` span the diff document, not the target file. |
| §diff-tree `deepJson` | `{ type: "diff", files: [{ type: "file", oldPath, newPath, additions, deletions, binary, hunks: [{ type: "hunk", oldStart, oldCount, newStart, newCount, heading }] }] }`; the document, each file and each hunk carry their complete source region. |
| JSONPath / XPath | The default dispatch over that tree ({§mimetype-query}): a file or hunk node is an exact region; a scalar field has only its node's enclosing region. |

Both channels are one exported `scanDiff(text)` pass. `content` and `references` are
the framework defaults. Raw source remains unchanged; bytes decode as UTF-8.
