# Plain text handler

## §plain-text-defaults Plain text and stream defaults

One handler class serves `text/plain` (`.txt`) and `text/stream` (no extension; the tail-oriented label in {§mimetype-discovery}) and overrides nothing: `BaseHandler`'s defaults ({§mimetype-handler-contract}) are the complete contract, and each registered name is its own instance reporting its own identity.

| Surface | Contract |
|---|---|
| `validate` | No-op; any text is valid. |
| `extractRaw` | `[]`; the symbol outline is empty. |
| `deepJson` | `null`. |
| `content` | Absent; the raw body is already readable ({§mimetype-content}). |
| regex / glob | Default text dispatch over the raw body ({§mimetype-query}). |
| JSONPath / XPath | Default structural dispatch ({§mimetype-query}): JSONPath over the empty outline returns `[]`; XPath has no tree to project and throws `UnsupportedDialectError`. |
