# @plurnk/plurnk-mimetypes-application-pdf

`application/pdf` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Binary content; extracts text via [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist).

## install

```
npm i @plurnk/plurnk-mimetypes-application-pdf
```

## what it does

PDF is a binary mimetype — the package declares `plurnk.binary: true`, and the framework reads files as `Uint8Array` before passing to handler methods.

- `validate(content)` checks the `%PDF-` header; throws `SyntaxError` on non-PDF input.
- `extractRaw(content)` surfaces the outline (bookmark TOC) as heading symbols plus the metadata Title; empty when the PDF carries neither.
- `deepJson(content)` returns a document model — metadata, detect-only security signals (`hasJavaScript` / `hasEmbeddedFiles`, presence only, never executed), external links, and AcroForm fields; `null` on parse failure.
- `toText(content)` extracts page text (joined with `\n\n`) for regex/glob queries and the model-facing readable body; page-count bounded by `PLURNK_PDF_MAX_PAGES` (unset → unbounded).
- `query(content, …)` runs jsonpath over the outline (`$['Chapter 1']`), regex/glob over `toText`.

Resource caps are unbounded by default; set `PLURNK_PDF_MAX_BYTES` / `PLURNK_PDF_MAX_PAGES` to a positive integer to cap (malformed → crash). See `.env.example`.

Salvage pattern from [rummy.web/WebFetcher.js](https://github.com/possumtech/rummy.web): pdfjs configured with `isEvalSupported: false` (no PDF JS execution) and `verbosity: 0` (silences font-warning noise — we read text streams directly, not glyphs).

## license

MIT.
