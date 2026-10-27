# INI handler

## §ini-tree INI value tree, section symbols, and source regions

Reads one line at a time: `[section]` headers, `key = value` or `key: value` entries split at the first delimiter with key and value trimmed, and `;` / `#` comment or blank lines skipped (no multiline continuation).

| Surface | Contract |
|---|---|
| `validate` | Framework default no-op ({§mimetype-channel-selection}). |
| `extractRaw` | Each section is a `module` spanning from its header line to the line before the next header or EOF; each key is a `field` on its own line contained by its section ({§mimetype-symbol}), or top-level with no container before any section. |
| `deepJson` | `{ section: { key: value } }` with string values: root keys sit at root, repeated sections merge, repeated keys keep their last value, and a section replaces a root key of the same name. `deepXml` projects it as a parsed value with the same source map. |
| JSONPath / XPath | A key resolves to its value's exact lexical span and a section to its complete line span; a repeated section reports one disjoint region per occurrence, and a section that replaced a root key keeps only the section's source ({§mimetype-query}). |

`content` and `references` use framework defaults; raw source remains unchanged and bytes decode as UTF-8.
