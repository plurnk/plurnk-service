# @plurnk/plurnk-mimetypes-text-html

`text/html` AND `application/xhtml+xml` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Converts HTML to markdown for LLM consumption via [turndown](https://www.npmjs.com/package/turndown).

## install

```
npm i @plurnk/plurnk-mimetypes-text-html
```

## what it does

HTML's value for an LLM lives in its rendered content, not in a separate symbol outline. So this handler overrides `preview()` to return the markdown-converted content directly, budgeted via the framework's `fitContent`:

- `preview(content, budget)` — turndown-converts to markdown, fit to budget tokens.
- `symbols(content)` — empty (the preview *is* the structural signal).
- `validate(content)` — no-op (HTML is forgiving).

Custom turndown rule (`safe-links`) salvaged from rummy.web: encodes parens in hrefs as `%28`/`%29` so URLs with literal parens don't break markdown's link syntax.

## not in scope

Web-page denoising (Readability-style filtering of nav/ads/comments) belongs in the fetcher layer (`plurnk-schemes-http` when it lands), not in a mimetype handler. This handler does pure HTML→markdown on whatever HTML it receives.

## license

MIT.
