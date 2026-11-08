# Patterns

## Summary

Select text or AST nodes with literal, glob (*, **, ?(p), @(p), !(p)), regex (/re/im), full-text (~query, ~"phrase"), XPath (//fn[name='x']), JSONPath ($.a.b), and symbol (&Foo, &?Foo, &>Foo, &<Foo) patterns.

A `path` chooses resources; a `pattern` selects within the addressed channel with identical semantics across operations:
- `plurnk.find`: reports matching resources and match regions.
- `plurnk.read`: shows matching source lines and match locations (surrounding context displayed by `read` is not part of the match).
- `plurnk.edit`: replaces each selected span with literal `text` (`""` deletes; edits that break a validated JSON/XML/HTML/etc. format are rejected with `422 edit-format-invalid`).
- `plurnk.copy` / `plurnk.move` / `plurnk.kill`: copies, moves, or deletes the selected spans (multiple fragments concatenate in source order without separators).
- Percent-encode path characters that collide with URI/glob syntax in `file:///` or relative paths (`#` as `%23`, `%` as `%25`, `(` as `%28`, `)` as `%29`, `\` as `%5C`).

## Pattern Dialects

| Prefix | Dialect | Pattern | Selection |
| --- | --- | --- | --- |
| none | literal | `retry` | Each literal substring occurrence |
| none | glob / extglob | `*retry*`, `?(export )?(async )function *` | Each whole line matching the glob or extglob |
| `/` | regex (ECMAScript) | `/\bretry\b/i` | Each complete ECMAScript regex match (`^`/`$` match line boundaries) |
| `~` | full-text (SQLite FTS5) | `~retry`, `~"exact phrase"` | FTS5 token occurrences across indexed resources |
| `//` | xpath (1.0) | `//item` | Whole `<item>...</item>` element |
| `//` | xpath (1.0) | `//item/text()` | Direct text nodes inside `<item>` |
| `//` | xpath (1.0) | `//item/@id` | The attribute's lexical value (`old` inside `id="old"`) |
| `$` | jsonpath (RFC 9535) | `$.host`, `$.items[?(@.price>500)]` | The JSON member's serialized value, including string quotes |
| `&` | graph (treesitter symbols) | `&connect` | Definitions of `connect` |
| `&` | graph (treesitter symbols) | `&?connect` | Definitions and references of `connect` |
| `&` | graph (treesitter symbols) | `&<connect` | References to `connect` |
| `&` | graph (treesitter symbols) | `&>connect` | Definitions of names referenced by `connect` |

## Same selection, different operations

For source `const first = connect(); const second = connect();`:

| Operation | Result |
| --- | --- |
| `plurnk.find({ path: "client.js", pattern: "/connect/" })` | Two locations: `<1,15,1,22>` and `<1,41,1,48>` |
| `plurnk.read({ path: "client.js", pattern: "/connect/" })` | The source line once, with both match locations |
| `plurnk.edit({ path: "client.js", pattern: "/connect/", text: "open" })` | `const first = open(); const second = open();` |
| `plurnk.edit({ path: "client.js", range: "1,15,1,22", pattern: "/connect/", text: "open" })` | Only the first occurrence changes |

## XML/HTML (XPath) and JSON (JSONPath) edits

| Target & source | Operation | Result & rule |
| --- | --- | --- |
| `<root><item id="old">A</item><other>B</other></root>` | `await plurnk.edit({ path: "items.xml", pattern: "//item/@id", text: "new" })` | `<root><item id="new">A</item><other>B</other></root>` (`//item/@id` selects `old` inside `id="old"`; `kill` empties the value to `id=""`) |
| `<root><item>A</item><other>B</other></root>` | `await plurnk.edit({ path: "items.xml", pattern: "//item/text()", text: "C" })` | `<root><item>C</item><other>B</other></root>` (`//item/text()` selects direct text nodes) |
| `<root><item>A</item><other>B</other></root>` | `await plurnk.edit({ path: "items.xml", pattern: "//item", text: "<label>C</label>" })` | `<root><label>C</label><other>B</other></root>` (`//item` selects the whole element) |
| `{"host":"old","port":80}` | `await plurnk.edit({ path: "settings.json", pattern: "$.host", text: "\"new\"" })` | `{"host":"new","port":80}` (`$.host` selects `"old"` with quotes; unquoted `text: "new"` breaks JSON and is rejected `422 edit-format-invalid`) |

await plurnk.edit({ path: "settings.json", pattern: "$.host", text: "\"new\"" })

The selected value includes its original quotes and escapes, not the property name or colon. The replacement `text` is literal source text: `text: "null"` assigns JSON `null`, while `text: "\"null\""` assigns the string `"null"`. In arrays, `$[0]` selects the element value without adjacent commas; replace the containing array to add or remove elements structurally.

## Bytes and source coordinates

- **Binary channels**: literal, regex (`\xNN`), and glob patterns match 1 byte per character; `read` shows hex (1 byte per line); `copy` and `move` transfer byte spans; `edit` does not author raw binary bytes.
- **Source coordinates**: `region` is the exact match span required by `edit`/`copy`/`move`/`kill`; `enclosingRegion` is display context for `read`.

## Dialect references

- [ECMAScript regular expressions](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects)
- [XPath 1.0](https://www.w3.org/TR/1999/REC-xpath-19991116/)
- [JSONPath, RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)
- [SQLite FTS5 queries](https://www.sqlite.org/fts5.html#full_text_query_syntax)
