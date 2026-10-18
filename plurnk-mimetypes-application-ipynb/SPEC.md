# Notebook handler

§ipynb-reading `content` is the notebook as reading Markdown ({§mimetype-content}),
one cell after another, each followed by a blank line: a markdown or raw cell's
source verbatim; a code cell fenced in the kernel language
(`metadata.kernelspec.language`, else `metadata.language_info.name`, else bare),
followed, when it has any, by an `_Output:_` fence holding its stream text,
`text/plain` results and error tracebacks with ANSI colour codes stripped. Images
and every other payload are dropped. A source that is not a JSON object has no
content.

§ipynb-cells Symbols index into that projection, not the JSON. An ATX heading in a
markdown cell is a `heading` symbol with its level, spanning until the next heading
of equal or shallower level or the document end; each code cell is a `module`
symbol spanning its fence and folded outputs, named `In[n]` by execution count or
`code cell N` by position when it has none. A source that is not a JSON object has
no symbols.

§ipynb-source `deepJson` is the parsed notebook verbatim; JSONPath and XPath carry
regions in the notebook JSON through `jsonc-parser` offsets, never in the Markdown
projection ({§mimetype-content-query}). `validate` is `JSON.parse`: malformed JSON
is refused and nothing else is. `references` is the framework default, none: cell
code is kernel-language source this handler does not parse.

| Surface | Contract |
|---|---|
| `validate` | Strict JSON gate ({§ipynb-source}). |
| `extractRaw` | Heading and code-cell symbols in projection lines ({§ipynb-cells}). |
| `deepJson` | The notebook object ({§ipynb-source}); `null` when the source is not a JSON object. |
| `content` | Reading Markdown ({§ipynb-reading}); absent when empty. |
| JSONPath / XPath | Notebook-JSON regions ({§ipynb-source}); a computed XPath scalar is locator-only ({§mimetype-query}). |

Raw source remains unchanged. Binary input is decoded as UTF-8 for the
projections; query regions resolve from string input.
