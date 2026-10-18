# Markdown handler

§markdown-symbols `text/markdown` structure is headings and code blocks, located by
marked's lexer. Every ATX or setext heading is a `heading` symbol with `level` 1
through 6; every code block, fenced or indented, is a `module` spanning the whole
block, named by its fence's language tag or `code` when it has none. Paragraphs,
lists, links, inline code, blockquotes and tables are content, not symbols. A
heading's container is the dotted path of its open ancestor headings, a heading at
level N closing every open heading at level N or deeper; a code block's container is
the innermost open heading path ({§mimetype-symbol-container}).

§markdown-block-regions Marked lexes a line-ending-normalized copy and transforms
nested block input, so a top-level block token is located by the tokenizer callback
that produced it and carries its complete region in the source's line and column
coordinates, whatever its line separator; a nested token (a list item's paragraph, a
`strong` run) has only its enclosing block's lines. No region is invented for a token
the source cannot locate ({§mimetype-query}).

| Surface | Contract |
|---|---|
| `validate` | The no-op default: any string is Markdown ({§mimetype-validation}). |
| `extractRaw` | The symbols above. |
| §markdown-tree `deepJson` | `{ type: "document", children }` of marked's block tokens: each node carries its token `type`, its region or enclosing lines, `level` (mirrored as `attrs.level` so `//heading[@level='2']` selects by level), and `text`, `lang`, `href`, `title`, `ordered` and nested `children` as the token has them. A `Uint8Array` projects `null`. |
| `summary` | Document metadata as {§mimetype-summary} defines it. |
| JSONPath / XPath | The default dispatch over that tree ({§mimetype-query}); regex and glob run over the raw body. |

Raw source text remains unchanged.
