# JSON handler

## §json-strictness JSON and JSONC validation, keys, and value spans

One handler serves two names through `jsonc-parser`: `application/json` is strict, while `application/jsonc` also accepts comments and trailing commas.

| Surface | Contract |
|---|---|
| `validate` | Enforces the name's grammar and throws `SyntaxError` naming the first error's code and position. Other channels never throw. |
| `extractRaw` | Emits recovered property keys at every depth as `field` symbols spanning the quoted key token ({§mimetype-symbol}); `container` is the dotted path of enclosing emitted keys with array indices contributing nothing. An array or scalar root has `[]`. |
| `deepJson` | The parsed value with plain-prototype objects ({§mimetype-channel-architecture}); `null` when the source has any parse error or is binary. |
| JSONPath / XPath | Exact value spans through `JsonSource` (the exported JSON Pointer to source-region map): lexical quotes and escapes retained, member name and colon excluded, array elements on their own span. `deepXml` stamps those same spans so XPath matches report the JSONPath region; a computed XPath scalar is locator-only, and JSONPath over unparseable input throws `QueryParseFailureError` ({§mimetype-query}). Regex and glob run over raw text regardless. |

Raw source remains unchanged. Structural projections accept strings; binary decoding belongs to the caller.
