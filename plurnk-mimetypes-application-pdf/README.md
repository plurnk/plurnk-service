# @plurnk/plurnk-mimetypes-application-pdf

`application/pdf` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Binary content; extracts text via [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist).

## install

```
npm i @plurnk/plurnk-mimetypes-application-pdf
```

## what it does

PDF is a binary mimetype — the package declares `plurnk.binary: true`, and the framework reads files as `Uint8Array` before passing to handler methods.

- `validate(content)` parses the PDF via pdfjs-dist's legacy build (Node-compatible); throws on parse failure or on image-only PDFs (scans without OCR — no extractable text means the LLM would get nothing useful).
- `toText(content)` extracts text page-by-page (joined with `\n\n`), page-count bounded by `PLURNK_PDF_MAX_PAGES` (unset → unbounded) — the readable projection the consumer gets for LLM ingestion.
- `symbols(content)` empty (the preview *is* the structural signal for a PDF; future enhancement could surface the document outline / bookmarks as heading symbols).

Salvage pattern from [rummy.web/WebFetcher.js](https://github.com/possumtech/rummy.web): pdfjs configured with `isEvalSupported: false` (no PDF JS execution) and `verbosity: 0` (silences font-warning noise — we read text streams directly, not glyphs).

## license

MIT.
