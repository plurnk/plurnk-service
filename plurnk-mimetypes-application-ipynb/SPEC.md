# Notebook handler

## §ipynb-reading Notebook projections, cells, and JSON source

| Surface | Contract |
|---|---|
| `validate` | `JSON.parse` strict JSON gate; malformed JSON is refused and nothing else is. |
| `content` | Reading Markdown ({§mimetype-content}), one cell after another, each followed by a blank line: markdown or raw cell source verbatim; code cell fenced in kernel language (`metadata.kernelspec.language`, else `metadata.language_info.name`, else bare), followed when present by an `_Output:_` fence holding stream text, `text/plain` results, and error tracebacks with ANSI colour codes stripped. Images and other payloads are dropped. Non-object JSON or empty projection answers `undefined`. |
| `extractRaw` | Symbols index into the Markdown projection, not the JSON: ATX headings in markdown cells are `heading` symbols (`level` 1–6) spanning until the next heading of equal/shallower level or document end; each code cell is a `module` symbol spanning its fence and folded outputs, named `In[n]` by execution count or `code cell N` by position when absent. Non-object JSON has `[]`. |
| `deepJson` | The parsed notebook object verbatim (`null` when not a JSON object). |
| `references` | Framework default (`[]`); cell code is kernel-language source this handler does not parse. |
| JSONPath / XPath | Carry regions in the notebook JSON through `jsonc-parser` offsets, never in the Markdown projection ({§mimetype-content}); a computed XPath scalar is locator-only ({§mimetype-query}). |

Raw source remains unchanged; binary input is decoded as UTF-8 for projections and query regions resolve from string input.
