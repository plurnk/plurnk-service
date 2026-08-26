# @plurnk/plurnk-mimetypes-text-markdown

`text/markdown` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-markdown
```

plurnk-service discovers this handler automatically via its `plurnk.kind: "mimetype"` declaration.

## what it extracts

Two symbol kinds via [marked](https://marked.js.org/)'s lexer:

- **Headings** — ATX (`# Title`) and setext (`Title\n=====`), every depth, with `level` 1-6 — also a content attribute, so `//heading[@level='2']` selects by level and `$..[?(@.type=='heading' && @.level==2)]` is the jsonpath form.
- **Fenced code blocks** — emitted as `module` symbols named by their language tag (or `code` when no language), with line range covering the full fence.

Everything else (paragraphs, lists, links, inline code, blockquotes, tables) is *content*, not structure — not emitted.

`validate()` is a no-op: any string is valid markdown.

## development

```sh
npm install
npm run build
npm test
```

## license

MIT.
