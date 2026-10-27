# @plurnk/plurnk-mimetypes-application-json

`application/json` and `application/jsonc` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm install @plurnk/plurnk-mimetypes-application-json
```

plurnk-service discovers this handler automatically via its `plurnk.kind: "mimetype"` declaration.

## what it does

- `validate(content)` rejects what the name's grammar rejects: strict for `application/json`, comments and trailing commas allowed for `application/jsonc` ({§json-strictness}).
- `extractRaw(content)` emits every key at every depth as a `field` symbol with its container path ({§json-strictness}).
- `deepJson(content)` is the parsed value; JSONPath and XPath select each value's exact source span ({§json-strictness}).

`JsonSource` is exported for handlers whose records are JSON (JSON Lines, notebooks): it maps a JSON Pointer to the value's source region.

## license

MIT.
