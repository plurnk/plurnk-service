# @plurnk/plurnk-mimetypes-text-html

`text/html` AND `application/xhtml+xml` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Two faces: **structural** extraction via [parse5](https://www.npmjs.com/package/parse5) (symbols, deep-json/deep-xml, real-DOM xpath via [@xmldom/xmldom](https://www.npmjs.com/package/@xmldom/xmldom) + [xpath](https://www.npmjs.com/package/xpath)) and **readable** projection — the page's main content as clean reading markdown via [@mozilla/readability](https://www.npmjs.com/package/@mozilla/readability) + [turndown](https://www.npmjs.com/package/turndown) over a [linkedom](https://www.npmjs.com/package/linkedom) DOM.

## install

```
npm i @plurnk/plurnk-mimetypes-text-html
```

## what it does

- `content(content)` — the **content channel** (SPEC §18): the page's markup-free reading markdown. Main-content extraction via Readability strips nav, ads, and chrome; turndown renders the article body as markdown. Non-article pages (apps, forms, fragments, very short HTML) degrade to best-effort markdown of the `<body>` — never raw HTML, never a throw. Empty/whitespace input → absent. This is also the embed-source: an HTML entry's embedding reflects the article, not `<div class>` noise. HTML is the only mimetype that populates this channel.
- `extractRaw(content)` — h1–h6 headings as `heading` symbols (with `level`), `<title>` as an h1 fallback when no headings exist, and code blocks as `module` symbols. Source line numbers come from parse5's location info.
- `deepJson(content)` — the parse5 DOM as a nested node tree, with source-algebra attributes under the `attrs` convention (framework projects this to the deep-xml channel).
- `query(content, dialect, pattern)` — overrides xpath to dispatch against the real parsed DOM (XPath 1.0) instead of the projected deep-xml. regex/glob run against the same readable markdown the content channel produces (one projection, shared by `toText`).
- `validate(content)` — no-op (HTML is forgiving).

## two faces, one handler

The structural channels (`extractRaw`/`deepJson`/`query` xpath) stay parse5-based with source positions — they answer "where is this tag, on what line." The content channel answers a different question — "what does this page *say*" — and for that the raw markup is noise. Readability + turndown denoise it into reading markdown. Web-page denoising used to be deferred to the fetcher layer; SPEC §18 moved it here, because the readable projection is a pure function of the HTML bytes (whatever a browser scheme rendered and serialized, or a file on disk) and belongs with the mimetype that owns HTML.

## license

MIT.
