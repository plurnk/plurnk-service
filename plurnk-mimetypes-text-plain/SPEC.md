# Plain text handler

§plain-text-defaults One handler class serves `text/plain` (`.txt`) and
`text/stream` (no extension; the tail-oriented label in {§mimetype-naming}) and
overrides nothing: `BaseHandler`'s defaults ({§mimetype-handler-contract}) are
the whole contract, and each registered name is its own instance reporting its
own identity.

| Surface | Contract |
|---|---|
| `validate` | No-op; any text is valid. |
| `extractRaw` | `[]`; the symbol outline is empty. |
| `deepJson` | `null`. |
| `content` | Absent; the raw body is already readable ({§mimetype-content}). |
| regex / glob | The default text dispatch over the raw body ({§mimetype-query}). |
| JSONPath / XPath | The default structural dispatch ({§mimetype-query}): JSONPath over the empty outline finds nothing; XPath has no tree to project and is `UnsupportedDialectError`. |

Raw source text remains unchanged; no projection is derived from it.
