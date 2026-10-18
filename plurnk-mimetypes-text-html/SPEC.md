# HTML handler

`text/html` and `application/xhtml+xml` share one handler with two faces: structural
channels over parse5's tree with its source locations, and a readable projection of
what the page says.

§html-readable-text `content` is the page as Markdown and never raw HTML: Readability's
article when it finds one, otherwise the body with `script`, `style`, `noscript` and
`template` removed; a Readability failure is "no article", not a failed projection.
Residual tags and comments are stripped from the result. Empty or whitespace-only input,
and a page with nothing readable, project `undefined`. Bytes decode as UTF-8. Regex and
glob run over the raw markup, not this projection ({§mimetype-content-query}).

§html-markdown-serializer The serializer renders Readability's tag set: ATX headings,
paragraphs, `-`/`1.` lists with indented continuation, `>` blockquotes, fenced code with
the `language-*` class as its info string, pipe tables, `---` rules, links with titles,
images with alt text, `**`/`*`/`~~` inline marks and backtick code spans; an unknown
element flattens to its children. Prose characters that would read as Markdown are
escaped, so the output never fabricates structure the page did not have.

§html-wrap-columns `PLURNK_MIMETYPES_HTML_WRAP_COLUMNS` breaks projected prose at
whitespace to fit that many columns (shipped default 100; `0` disables). Fenced code,
headings, table rows, indented code, inline code, links and raw tags are never split,
and a wrapped list item or blockquote keeps its marker's continuation. The value is
part of `projectionConfiguration()` ({§mimetype-projection-identity}); anything but an
integer of at least 0 fails hard.

| Surface | Contract |
|---|---|
| `validate` | The no-op default: parse5 recovers any input into a document ({§mimetype-validation}). |
| §html-symbols `extractRaw` | `<h1>`–`<h6>` with nonblank text are `heading` symbols with `level` from the tag and the element's text, nested markup flattened; `<title>` becomes a level-1 heading only when the page has no `<h1>`, with no container; each `<pre>` is a `module` named by its first `<code>` child's `language-*` class, else `code`, and its content is not entered. Containers follow heading order ({§mimetype-symbol-container}); coordinates come from parse5's locations. |
| §html-tree `deepJson` | The parsed DOM as nested nodes rooted at `{ type: "document" }`: `type` is the element name, `attrs` its attributes, `text` a lone text child, `children` otherwise; ill-formed markup still yields a tree. |
| §html-source-regions JSONPath / XPath | Both address the parse5 tree, XPath 1.0 with unprefixed HTML element names. A selected element, attribute or text node carries its exact source span; an element the parser implied (`html`, `head`, `body`) and a computed scalar carry the locator only; several results are `(expr)[n]` ({§mimetype-query}). A malformed XPath is `InvalidExpressionError`. |
