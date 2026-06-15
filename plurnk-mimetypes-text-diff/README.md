# @plurnk/plurnk-mimetypes-text-diff

`text/x-diff` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Parses unified, plain (`diff -u`), and combined/merge (`diff --cc`) diffs with a hand-rolled line-budget scanner — **no parser dependency**.

## install

```
npm i @plurnk/plurnk-mimetypes-text-diff
```

## what it does

- **`extractRaw(content)`** emits one `module` symbol per file section and one `field` symbol per hunk (see the symbol model below).
- **`deepJson(content)`** emits the structural tree of target-file ranges and per-file stats — the jsonpath query target. The framework projects it to deep-xml automatically, so xpath works too.

Both channels are backed by a single `scanDiff(text)` pass (exported for re-use). `validate` is the framework default (a diff has no fail-hard syntax check). `content` (HTML-only) and `references` are not implemented.

## why hand-rolled (Tier 4)

A unified diff is rigidly line-oriented, but the one fact that disambiguates it is **not context-free**. The hunk header `@@ -a,b +c,d @@` declares a **line budget**: `b` old slots + `d` new slots. Inside an open hunk, while the budget is unspent, every line's leading `+`/`-`/space columns are *authoritative content* — regardless of what text follows the prefix.

This budget is exactly what `tree-sitter-diff` cannot track, and it fails on two real inputs:

1. **The `--` trap.** A hunk that *deletes* a line whose content starts with `---` (e.g. removing `--- old config`) is indistinguishable from a new file header to a context-free grammar — the grammar has no way to know it's still inside the prior hunk's budget. tree-sitter-diff mis-classifies it as the start of a new file section. The line budget resolves it: the line is consumed as a deletion because the open hunk still owes content slots. This is the test that justifies the hand-roll (`src/TextDiff.test.ts`, "the `--`-content-deletion trap").
2. **Combined/merge diffs ERROR.** `diff --cc` / `diff --combined` use an `@@@` fence with N parent ranges and multi-column `+`/`-` prefixes; conflict-marker lines (`<<<<<<<`, `=======`, `>>>>>>>`) appear as additions. tree-sitter-diff produces an ERROR node on these outright. The scanner handles them by summing every range's count into one budget and reading `fenceWidth` prefix columns per line.

A ~53-LOC prototype of this scanner matched `git diff --shortstat` **byte-exact** (files, insertions, deletions) on a 10,894-line real diff. The production scanner here is verified against the same kind of real `git diff` output.

The scanner also handles: `diff --git a/X b/Y` sections **and** bare `---`/`+++` pairs; `a/ b/ c/ i/ w/` prefix stripping; `/dev/null`; timestamp tails on `---`/`+++` lines; renames (`rename from`/`rename to` → one `old → new` section); mode-change-only and binary sections (paths recovered from the `diff --git` line); per-file add/del counts; truncation (budget never satisfied → close cleanly); interleaved garbage (no header match → skip; mid-hunk garbage → close hunk, rescan); and `\ No newline at end of file` (counts no budget).

## symbol model

| Diff element | `MimeSymbol` kind | name |
|---|---|---|
| File section | `module` | new path (a/b-stripped); old path for pure deletions; `old → new` for renames |
| Hunk | `field` | git's section-heading text when present (`function greet(name) {` — more useful to a model than coordinates, and name-joinable to the source entry), else `@@ +c,d` (the new-file coordinates the model navigates to) |

A hunk is a `field` (not a `function`) because hunks have no params and aren't callable — `field` renders as a member of the file module (the hunk's `container` is the file's name). `line`/`endLine` span the section / hunk **within the diff document** (where the reader navigates), not the target file.

## deepJson shape

The deep channel carries the **target-file** ranges and per-file stats — jsonpath-queryable, each object carrying a `type` so the framework's `projectJsonToXml` names elements cleanly:

```ts
{
  type: "diff",
  files: [{
    type: "file",
    oldPath, newPath, line, endLine, additions, deletions, binary,
    hunks: [{
      type: "hunk",
      oldStart, oldCount, newStart, newCount, heading /* string | null */,
      line, endLine,
    }],
  }],
}
```

`extent` is `totalLines` (the framework default — correct for a line-oriented format).

## references

Refs-free for v1. References are a code-graph concept (`call`, `import`, `inherit`, …) that a diff doesn't natively express. A future **file-path use-edge** is plausible — a diff's touched paths are in-corpus entry paths, so the diff could link to the entries it patches — but that edge is not built here (precision over speculation).

## detection

Resolves on the `.diff` and `.patch` extensions. Extensionless git output (e.g. piped `git diff`) is not detected by extension and falls to the consumer's `defaultMimetype` (plurnk-service); magic-byte / content sniffing is the framework's §8 future lane, not this handler's job.

## license

MIT.
