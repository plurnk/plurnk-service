# @plurnk/plurnk-mimetypes-text-dotenv

`text/x-dotenv` (`.env`) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Hand-rolled, no parser dependency.

## install

```
npm i @plurnk/plurnk-mimetypes-text-dotenv
```

## what it does

- `extractRaw(content)` — each variable is a `constant` symbol at its line. `export ` prefixes are handled; comments (`#`) and non-variable lines are ignored.
- `deepJson(content)` — the `{ KEY: value }` map, a jsonpath target (`$.MODEL`). One layer of matching surrounding quotes is stripped; unquoted values are taken verbatim.
- `query(content, dialect, pattern)` — jsonpath against the value map; regex/glob against the raw text.

**Values are exposed, not redacted.** A `.env` file is config; plenty of workflows carry no secrets in it, so the handler treats values like any other configuration. The raw body is directly readable, so there is no content projection. References are not applicable.

## license

MIT.
