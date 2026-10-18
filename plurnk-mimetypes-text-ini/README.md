# @plurnk/plurnk-mimetypes-text-ini

`text/x-ini` (INI / config) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Hand-rolled, no parser dependency: the syntax is a single-line scan ({§ini-tree}).

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-ini
```

## what it does

Covers the Python tooling cluster (`setup.cfg`, `tox.ini`, `pytest.ini`, `.editorconfig`, `.flake8`, `.pylintrc`) plus generic `.ini`/`.cfg`.

- `extractRaw(content)` — sections as `module` symbols, keys as `field` symbols ({§ini-symbols}).
- `deepJson(content)` — the nested `{ section: { key: value } }` object, a JSONPath target such as `$.metadata.version` ({§ini-tree}).
- `query(content, dialect, pattern)` — JSONPath and XPath answer with lexical source spans ({§ini-regions}); regex and glob run over the raw text.

The raw body is directly readable, so there is no content projection.

## license

MIT.
