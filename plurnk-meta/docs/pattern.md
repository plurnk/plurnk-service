# Patterns

## Summary

Select source text consistently with literal, glob, regex, full-text, structural, and graph patterns.

A path chooses resources; a pattern selects within the addressed channel.
The selection has the same meaning across operations. `plurnk.find` reports matches;
`plurnk.read` shows their source lines and locations; `plurnk.edit` replaces each selected span
with its literal `content`. `plurnk.copy` transfers selected text; `plurnk.move` transfers then removes
it; textual `plurnk.kill` removes it. Surrounding text displayed by `read` is not part of
the match. Multiple fragments are concatenated in source order without added
separators.

File addresses returned by `find` and receipts can be reused directly. Ordinary
names are project-relative; names that collide with path syntax use native
`file:///` URLs. For example, `/work/hash#name.txt` is addressed as
`file:///work/hash%23name.txt`, a literal `%28` as `%2528` in a file URL, and
parentheses in paths as `%28` (`(`) and `%29` (`)`).
This quoting changes neither the file nor its workspace membership. A fragment
such as `#bytes` still selects a channel; a literal filename `#` must be encoded.
Quoting also composes with path globs: `file:///work/dir%5Cname/*.txt`
selects text files inside the literal `dir\name` folder, never `dir/name`.

Glob `edit` and resource `kill` apply independently to every matching resource,
not just a preview page. Scopes and patterns apply inside each resource; a
refused target does not undo successful siblings. No matching path changes
nothing. `copy`/`move` require one resolved resource per operand; use explicit
source/destination pairs for multiple transfers.

## Pattern Dialects

| Prefix | Dialect | Pattern | Selection |
| --- | --- | --- | --- |
| none | literal | `retry` | Each literal substring occurrence |
| none | glob / extglob | `*retry*`, `?(export )?(async )function *` | Each whole line matching the glob or extglob |
| `/` | regex (ECMAScript) | `/\bretry\b/i` | Each complete ECMAScript regex match |
| `~` | full-text (SQLite FTS5) | `~retry` | FTS5 token occurrences; the query determines which resources match |
| `//` | xpath (1.0) | `//item` | Item elements |
| `//` | xpath (1.0) | `//item/text()` | Their direct text nodes |
| `//` | xpath (1.0) | `//item/@id` | The complete source attribute (`id="old"`), not only its value |
| `$` | jsonpath (RFC 9535) | `$.host`, `$.items[?(@.price>500)]` | The JSON member's serialized value, including string quotes |
| `&` | graph (treesitter symbols) | `&connect` | Definitions of `connect` |
| `&` | graph (treesitter symbols) | `&<connect` | References to `connect` |
| `&` | graph (treesitter symbols) | `&>connect` | Definitions of names referenced by `connect` |

Graph selections use the language handler's extracted definitions and
references, not compiler-resolved bindings. Replacing references is literal
source editing, not a semantic rename.

## Same selection, different operations

For source `const first = connect(); const second = connect();`:

| Operation | Result |
| --- | --- |
| `plurnk.find({ path: "client.js", pattern: "/connect/" })` | Two locations: `<1,15,1,22>` and `<1,41,1,48>` |
| `plurnk.read({ path: "client.js", pattern: "/connect/" })` | The source line once, with both match locations |
| `plurnk.edit({ path: "client.js", pattern: "/connect/", content: "open" })` | `const first = open(); const second = open();` |
| `plurnk.edit({ path: "client.js", range: "1,15,1,22", pattern: "/connect/", content: "open" })` | Only the first occurrence changes |

A source scope narrows mutation and transfer selections to complete matches inside it.
A `read` shows the whole selection when it fits the budget and its size otherwise; what a later pattern selects is never limited by what was shown.
Coordinates always refer to the addressed source channel, not receipt
decorations or another channel's rendered text.

Regex anchors `^` and `$` address line boundaries; a match may span lines.
`edit`'s `content` is literal replacement text, not regex substitution syntax.

## Pattern and metadata fields

The `pattern` field selects text. The optional `metadata` field carries
named options; first-party operations read it as a JSON array of option objects.
The `content` / `text` / `prompt` field remains the operation's input, not its options.
Option names belong to the addressed scheme or executor.

## Elements and text

For source `<root><item>A</item><other>B</other></root>`:

await plurnk.edit({ path: "items.xml", pattern: "//item/text()", content: "C" });

produces `<root><item>C</item><other>B</other></root>`.

await plurnk.edit({ path: "items.xml", pattern: "//item", content: "<label>C</label>" });

produces `<root><label>C</label><other>B</other></root>`. `label` is an ordinary
XML element name in the replacement text, not Plurnk syntax.

An empty `content` removes the selected source text. In mixed content
`<item>A<b>B</b>C</item>`, `//item/text()` selects `A` and `C`, not the nested
`B`; replacement `content` `"X"` produces `<item>X<b>B</b>X</item>`.

For `<item id="old"/>`, `//item/@id` selects `id="old"`. `edit` `content`
`"id=\"new\""` replaces that attribute; `kill` removes it. Entity spellings and
quotes are preserved by `copy`: text `A &amp; B` copies as `A &amp; B`.

## JSON values

For source `{"host":"old","port":80}`:

await plurnk.edit({ path: "settings.json", pattern: "$.host", content: "\"new\"" });

produces `{"host":"new","port":80}`. The selected value includes its original
quotes and escapes, not the property name or colon. The replacement `content` is
source text: `edit` does not quote, escape, or serialize it for you.

`content: "new"` would instead produce `{"host":new,"port":80}`, which is invalid
JSON. `content: "null"` assigns JSON null; `content: "\"null\""` assigns the string `null`.
Selecting only the substring with `/old/` lets `content: "new"` retain the existing
quotes. The quotes follow what was selected, not a separate `edit` requirement.

Likewise, `$[0]` selects an array element's value, not an adjacent comma.
Replacing the containing array can remove an element structurally;
empty-content replacement only removes the selected text.

## Bytes

On a native binary channel, literal, regex, and glob patterns match bytes
one character per byte; regex `\xNN` matches a byte value. `read` shows hex,
one byte per line. `copy` and `move` transfer the selected bytes unchanged;
source and destination scopes use byte positions. Text `edit` bodies do not
author native bytes. Structural and indexed text dialects require a text channel.

## Source coordinates

Exact match locations are `region`; `enclosingRegion` is display context only.
A computed value or a synthesized node can have a locator without a source
span. `find` reports it; `read` needs source or enclosing coordinates to show text.
Mutation and transfer require exact source coordinates and do not substitute
an ancestor's text. Scoped `read` of a reported exact region retrieves that
fragment.

## Dialect references

- [ECMAScript regular expressions](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects)
- [XPath 1.0](https://www.w3.org/TR/1999/REC-xpath-19991116/)
- [JSONPath, RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)
- [SQLite FTS5 queries](https://www.sqlite.org/fts5.html#full_text_query_syntax)
