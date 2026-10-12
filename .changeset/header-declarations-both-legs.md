---
"@plurnk/plurnk-mcp": minor
---

A tool whose `x-mcp-header` declarations break SEP-2243 is never called: the
definition is scanned before either request leg, Tasks or direct, and an
invalid declaration refuses the call with `tool-header-invalid` naming the tool
and the declaration, with no request sent. `number` is no longer a permitted
header type, and a declaration under `items`, `additionalProperties`, a
combinator, a conditional or `$defs` invalidates the definition. The
conformance referee moves to `0.2.0-alpha.12`.
