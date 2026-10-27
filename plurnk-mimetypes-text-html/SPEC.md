# HTML handler

## §html-readable-text HTML readable Markdown, wrap columns, and parse5 projections

`text/html` and `application/xhtml+xml` share one handler over parse5's source-located DOM and Readability's article extraction.

| Surface | Contract |
|---|---|
| `validate` | Framework default no-op: parse5 recovers any input into a document ({§mimetype-channel-selection}). |
| `content` | Page rendered as Markdown (never raw HTML): Readability's article when found, else `<body>` with `script`, `style`, `noscript`, and `template` removed (Readability failure falls back to body), with residual tags/comments stripped. Renders ATX headings, paragraphs, `-`/`1.` lists with indented continuation, `>` blockquotes, fenced code (`language-*` info string), pipe tables, `---` rules, links with titles, images with alt text, `**`/`*`/`~~` marks, and backtick spans; unknown elements flatten to children and Markdown-special prose characters are escaped. `PLURNK_MIMETYPES_HTML_WRAP_COLUMNS` wraps prose at whitespace to that column limit (default `100`, `0` disables, included in `projectionConfiguration()`, non-integer or `< 0` fails hard) without splitting fenced/indented/inline code, headings, table rows, links, or raw tags. Empty/unreadable pages answer `undefined`. Regex/glob query raw markup ({§mimetype-content}). |
| `extractRaw` | Nonblank `<h1>`–`<h6>` as `heading` symbols (`level` 1–6, nested markup flattened); `<title>` as level-1 `heading` only when no `<h1>` exists (no container); each `<pre>` as a `module` named by its first `<code>` child's `language-*` class, else `code` (content not entered). Containers follow heading order ({§mimetype-symbol}); coordinates come from parse5 locations. |
| `deepJson` | Parsed DOM rooted at `{ type: "document" }` (`type` element name, `attrs` attributes, `text` lone text child, `children` otherwise). |
| JSONPath / XPath | Address the parse5 tree (XPath 1.0 unprefixed HTML names). Selected elements, attributes, and text nodes carry exact source spans; parser-implied elements (`html`, `head`, `body`) and computed scalars are locator-only; multiple results use `(expr)[n]`; malformed XPath throws `InvalidExpressionError` ({§mimetype-query}). |
