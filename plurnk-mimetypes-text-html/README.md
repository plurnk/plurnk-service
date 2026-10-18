# @plurnk/plurnk-mimetypes-text-html

`text/html` and `application/xhtml+xml` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Structural channels come from [parse5](https://www.npmjs.com/package/parse5), with XPath over the parsed tree via [xpath](https://www.npmjs.com/package/xpath); the readable projection comes from [@mozilla/readability](https://www.npmjs.com/package/@mozilla/readability) and the package's own Markdown serializer over a [linkedom](https://www.npmjs.com/package/linkedom) DOM.

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-html
```

## what it does

- `content(content)` — the page's reading Markdown ({§html-readable-text}, {§html-markdown-serializer}), wrapped at `PLURNK_MIMETYPES_HTML_WRAP_COLUMNS` ({§html-wrap-columns}); the service stores it as the entry's `readable` channel ({§mimetype-content}).
- `extractRaw(content)` — headings, the `<title>` fallback and code blocks as symbols ({§html-symbols}).
- `deepJson(content)` — the DOM as nested nodes ({§html-tree}).
- `query(content, dialect, pattern)` — XPath and JSONPath over the parsed tree with source regions ({§html-source-regions}); regex and glob address the markup itself.

## configuration

| Variable | Default | Meaning |
|---|---|---|
| `PLURNK_MIMETYPES_HTML_WRAP_COLUMNS` | `100` | Prose wrap width in columns for the readable projection; `0` disables ({§html-wrap-columns}). |

## license

MIT.
