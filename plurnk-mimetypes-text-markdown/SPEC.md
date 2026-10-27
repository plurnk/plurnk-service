# Markdown handler

## §markdown-symbols Markdown headings, code blocks, and block-token tree

Located by marked's lexer over a line-ending-normalized copy while preserving source line and column coordinates regardless of LF/CRLF/CR separator.

| Surface | Contract |
|---|---|
| `validate` | Framework default no-op: any string is Markdown ({§mimetype-channel-selection}). |
| `extractRaw` | Every ATX or setext heading is a `heading` symbol (`level` 1–6) whose `container` is the dotted path of open ancestor headings (a level-$N$ heading closes open headings at level $\ge N$); every fenced or indented code block is a `module` spanning the whole block, named by fence language tag or `code` when absent, with the innermost open heading path as `container` ({§mimetype-symbol}). Paragraphs, lists, links, inline code, blockquotes, and tables are not symbols. |
| `deepJson` | `{ type: "document", children }` of marked's block tokens (`null` for `Uint8Array`): each node carries token `type`, complete source region for top-level blocks or enclosing block lines for nested tokens (list item paragraphs, `strong` runs; no region invented when unlocatable), `level` (mirrored as `attrs.level` so `//heading[@level='2']` selects by level), and `text`, `lang`, `href`, `title`, `ordered`, and nested `children` when present. |
| `summary` | Leading YAML frontmatter string `description`, else first paragraph directly beneath the first exact semantic H2 `Summary` before any subsequent heading ({§mimetype-channel-selection}). |
| JSONPath / XPath | Default dispatch over `deepJson` ({§mimetype-query}); regex and glob run over the raw body. |
