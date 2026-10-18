# JSON handler

§json-strictness One handler serves two names through `jsonc-parser`:
`application/json` is strict, `application/jsonc` also accepts comments and
trailing commas. `validate` throws `SyntaxError` naming the first error's code
and position. The other channels never throw: `extractRaw` emits the keys the
parser recovers, `deepJson` is `null` for any source with a parse error, and a
JSONPath query over one throws `QueryParseFailureError` ({§mimetype-query}).
Regex and glob run over the raw text regardless.

§json-keys Every property key at every depth is one `field` symbol spanning its
quoted key token ({§mimetype-symbol}). `container` is the dotted path of the
enclosing emitted keys; array indices contribute nothing
({§mimetype-symbol-container}). An array or scalar root has no symbols.

§json-value-spans A JSONPath or XPath match selects the value's own source text:
lexical quotes and escapes retained, member name and colon excluded, an array
element on its own span. `deepXml` stamps those same spans, so an XPath row
reports the JSONPath row's exact region; a computed XPath scalar is locator-only
({§mimetype-query}).

| Surface | Contract |
|---|---|
| `validate` | The name's grammar; `SyntaxError` on the first violation ({§json-strictness}). |
| `extractRaw` | Key symbols with complete columns and container paths ({§json-keys}). |
| `deepJson` | The parsed value with plain-prototype objects ({§mimetype-channel-architecture}); `null` when the source does not parse or is binary. |
| JSONPath / XPath | Exact value spans through `JsonSource`, the exported JSON Pointer to source-region map ({§json-value-spans}). |

Raw source remains unchanged. Structural projections accept strings; binary
decoding belongs to the caller.
