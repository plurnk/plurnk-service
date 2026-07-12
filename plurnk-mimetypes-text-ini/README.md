# @plurnk/plurnk-mimetypes-text-ini

`text/x-ini` (INI / config) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Hand-rolled, no parser dependency.

## install

```
npm i @plurnk/plurnk-mimetypes-text-ini
```

## what it does

`[section]` headers, `key = value` / `key: value` entries, `;` and `#` comments. Covers the Python tooling cluster (`setup.cfg`, `tox.ini`, `pytest.ini`, `.editorconfig`, `.pylintrc`) plus generic `.ini`/`.cfg`.

- `extractRaw(content)` — sections are `module` symbols spanning to the next section; keys are `field` symbols contained by their section (keys before any section are top-level fields).
- `deepJson(content)` — the nested `{ section: { key: value } }` object, a jsonpath target (`$.metadata.version`).
- `query(content, dialect, pattern)` — jsonpath against the nested object; regex/glob against the raw text.

v1 is single-line: indented continuation lines (`setup.cfg` multi-line values) are skipped rather than guessed. The raw body is directly readable, so there is no content projection. References are not applicable.

## license

MIT.
