# @plurnk/plurnk-mimetypes-text-dotenv

`text/x-dotenv` (`.env`) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Uses Node's native environment parser; no parser dependency.

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-dotenv
```

## what it does

- `extractRaw(content)` — each recognized assignment is a `constant` symbol spanning its source lines.
- `deepJson(content)` — the `{ KEY: value }` map, a JSONPath target (`$.MODEL`), with Node's `util.parseEnv` semantics for quotes, inline comments, multiline values, and duplicate keys ({§dotenv-values}).
- `query(content, dialect, pattern)` — JSONPath/XPath against the value map with source regions ({§dotenv-source}); regex/glob against the raw text.

**Values are exposed, not redacted.** A `.env` file is config; plenty of workflows carry no secrets in it, so the handler treats values like any other configuration. The raw body is directly readable, so there is no content projection. References are not applicable.

## license

MIT.

Tests include all [Node v26.6.0 dotenv fixtures](https://github.com/nodejs/node/tree/v26.6.0/test/fixtures/dotenv), stored verbatim as JSON strings under `test/fixtures/` with their license, and exercise both LF and CRLF source coordinates.
