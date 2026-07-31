# @plurnk/plurnk-mimetypes-application-jsonl

`application/jsonl` (JSON Lines / NDJSON) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Hand-rolled, no parser dependency.

## install

```
npm i @plurnk/plurnk-mimetypes-application-jsonl
```

## what it does

One JSON value per line — training data, eval sets, fine-tune files, chat/agent logs. The structural definition of a JSONL dataset is its **record schema**, not its rows (a file can be millions of lines), so:

- `extractRaw(content)` — the schema: each distinct top-level key across records becomes a `field` symbol at the line it first appears. Scale-safe (bounded by schema width, not record count), and it answers "what is this dataset" — `{prompt, completion, score}`.
- `deepJson(content)` — the parsed records array, a jsonpath target (`$[5].completion`), computed only on demand.
- `query(content, dialect, pattern)` — jsonpath dispatches against the records array; regex/glob against the raw text.

Lenient by design: blank lines are skipped, and a line that doesn't parse is skipped (a trailing newline or a partial write doesn't poison the file). The raw body is already readable JSON-per-line, so text scopes address its physical lines. JSONPath locates matching records but never changes the text-region coordinate system. References are not applicable.

## license

MIT.
