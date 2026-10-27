# @plurnk/plurnk-mimetypes-text-markdown

`text/markdown` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem, over [marked](https://marked.js.org/)'s lexer.

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-markdown
```

## what it does

- `extractRaw(content)` — headings and code blocks as symbols, nested by heading level ({§markdown-symbols}).
- `deepJson(content)` — the block-token tree that JSONPath and XPath query ({§markdown-symbols}): `$..[?(@.type=='heading' && @.level==2)]`, or `//heading[@level='2']`.
- `summary(content)` — a frontmatter `description` or the `## Summary` paragraph ({§mimetype-channel-selection}).

Top-level blocks carry exact source regions; nested tokens carry their block's ({§markdown-symbols}).

## license

MIT.
