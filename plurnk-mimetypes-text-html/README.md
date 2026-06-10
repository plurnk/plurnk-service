# @plurnk/plurnk-mimetypes-text-html

`text/html` AND `application/xhtml+xml` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Structural extraction via [parse5](https://www.npmjs.com/package/parse5); real-DOM xpath via [@xmldom/xmldom](https://www.npmjs.com/package/@xmldom/xmldom) + [xpath](https://www.npmjs.com/package/xpath).

## install

```
npm i @plurnk/plurnk-mimetypes-text-html
```

## what it does

- `extractRaw(content)` — h1–h6 headings as `heading` symbols (with `level`), `<title>` as an h1 fallback when no headings exist, and code blocks as `module` symbols. Source line numbers come from parse5's location info.
- `preview(content)` — hybrid per SPEC §1: a `SymbolPreview` when structural signals were found, otherwise a head-oriented `TextPreview` over the raw HTML (the framework truncates and marks it).
- `deepJson(content)` — the parse5 DOM as a nested node tree, with source-algebra attributes under the `attrs` convention (framework projects this to the deep-xml channel).
- `query(content, dialect, pattern)` — overrides xpath to dispatch against the real parsed DOM (XPath 1.0) instead of the projected deep-xml.
- `validate(content)` — no-op (HTML is forgiving).

## not in scope

Web-page denoising (Readability-style filtering of nav/ads/comments) belongs in the fetcher layer (`plurnk-schemes-http` when it lands), not in a mimetype handler. Markdown conversion of rendered content likewise — the preview channel is a structural-or-truncated radar, not a substitute for fetching the content.

## license

MIT.
