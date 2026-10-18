# INI handler

§ini-tree The `text/x-ini` value projection reads one line at a time: `[section]`
headers, `key = value` or `key: value` entries split at the first delimiter with key
and value trimmed, `;` and `#` comment lines and blank lines skipped. A value ends at
its line; continuation lines are not folded into the preceding value. `deepJson` is
`{ section: { key: value } }` with every value a string: keys before any section sit
at the root, a repeated section merges into one object, a repeated key keeps its last
value, and a section replaces a root key of the same name.

| Surface | Contract |
|---|---|
| `validate` | The no-op default ({§mimetype-validation}). |
| §ini-symbols `extractRaw` | Each section is a `module` spanning its header line to the line before the next header or the end of the document; each key is a `field` on its own line, contained by its section ({§mimetype-symbol-container}); keys before any section are top-level fields with no container. |
| `deepJson` | The value tree above; `deepXml` projects it as a parsed value with the same source map. |
| §ini-regions JSONPath / XPath | A key resolves to its value's exact lexical span and a section to its complete line span; a repeated section reports one disjoint region per occurrence, and a section that replaced a root key keeps only the section's source ({§mimetype-query}). |

`content` and `references` are the framework defaults: the raw body is directly
readable. Raw source remains unchanged; bytes decode as UTF-8.
