# @plurnk/plurnk-mimetypes-text-diff

`text/x-diff` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem: unified (`diff -u`, `git diff`) and combined (`diff --cc`) diffs. No parser dependency.

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-diff
```

## what it does

- `extractRaw(content)` — one `module` symbol per file section and one `field` per hunk ({§diff-line-budget}).
- `deepJson(content)` — the tree of file sections, hunks and per-file counts that JSONPath and XPath query ({§diff-line-budget}).

Both come from one single-pass line scanner. It is hand-written rather than grammar-backed because the fact that disambiguates a diff—the hunk's line budget—is not context-free, and the same budget reads both unified and combined file sections ({§diff-line-budget}).

Detection is by the `.diff` and `.patch` extensions; extensionless output such as a piped `git diff` falls to the consumer's default mimetype.

## license

MIT.
