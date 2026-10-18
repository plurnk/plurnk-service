# @plurnk/plurnk-mimetypes-application-jsonl

`application/jsonl` (JSON Lines / NDJSON) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm i @plurnk/plurnk-mimetypes-application-jsonl
```

## what it does

One JSON value per line: training data, eval sets, fine-tune files, chat and agent logs.

- `extractRaw(content)` emits the record schema, one `field` per distinct top-level key, so symbols stay bounded by schema width rather than record count ({§jsonl-schema}).
- `deepJson(content)` is the records array; JSONPath and XPath locate a record on its line and a nested value within it ({§jsonl-records}).

The raw body is already readable JSON-per-line, so there is no content projection and text matchers address its physical lines.

## license

MIT.
