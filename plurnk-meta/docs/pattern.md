# Patterns

## Summary

Select source text consistently with literal, glob, regex, full-text, structural, and graph patterns.

A path chooses resources; a pattern selects within the addressed channel.
The selection has the same meaning across operations. FIND reports matches;
READ shows their source lines and locations; EDIT replaces each selected span
with its literal body. COPY transfers selected text; MOVE transfers then removes
it; textual KILL removes it. Surrounding text displayed by READ is not part of
the match. Multiple fragments are concatenated in source order without added
separators.

## What a pattern selects

| Pattern | Selection |
| --- | --- |
| `retry` | Each literal substring occurrence |
| `/\bretry\b/i` | Each complete ECMAScript regex match |
| `*retry*` | Each whole line matching the glob |
| `~retry` | FTS5 token occurrences; the query determines which resources match |
| `//item` | Item elements |
| `//item/text()` | Their direct text nodes |
| `//item/@id` | The complete source attribute, not only its value |
| `$.host` | The JSON member's value |
| `&connect` | Definitions of `connect` |
| `&<connect` | References to `connect` |
| `&>connect` | Definitions of names referenced by `connect` |

Graph selections use the language handler's extracted definitions and
references, not compiler-resolved bindings. Replacing references is literal
source editing, not a semantic rename.

## Same selection, different operations

For source `const first = connect(); const second = connect();`:

| Operation | Result |
| --- | --- |
| `FIND (client.js) /connect/` | Two locations: `<1,15,1,22>` and `<1,41,1,48>` |
| `READ (client.js) /connect/` | The source line once, with both match locations |
| `EDIT (client.js) /connect/`, body `open` | `const first = open(); const second = open();` |
| `EDIT (client.js) <1,15,1,22> /connect/`, body `open` | Only the first occurrence changes |

A source scope narrows mutation and transfer selections to complete matches inside it.
A READ preview limits what is shown, not what a later pattern selects.
Coordinates always refer to the addressed source channel, not receipt
decorations or another channel's rendered text.

Regex anchors `^` and `$` address line boundaries; a match may span lines.
EDIT's body is literal replacement text, not regex substitution syntax.

COPY and MOVE attach the pattern to their source operand:

```COPY (client.js) [{"pattern":"/connect/"}] (names.txt)
```

The copied text is `connectconnect`; surrounding calls and punctuation are not selected.

## Elements and text

For source `<root><item>A</item><other>B</other></root>`:

```EDIT (items.xml) //item/text()
C
```

produces `<root><item>C</item><other>B</other></root>`.

```EDIT (items.xml) //item
<replacement>C</replacement>
```

produces `<root><replacement>C</replacement><other>B</other></root>`.

An empty body removes the selected source text. In mixed content
`<item>A<b>B</b>C</item>`, `//item/text()` selects `A` and `C`, not the nested
`B`; replacement body `X` produces `<item>X<b>B</b>X</item>`.

For `<item id="old"/>`, `//item/@id` selects `id="old"`. EDIT body
`id="new"` replaces that attribute; KILL removes it. Entity spellings and
quotes are preserved by COPY: text `A &amp; B` copies as `A &amp; B`.

## JSON values

For source `{"host":"old","port":80}`:

```EDIT (settings.json) $.host
"new"
```

produces `{"host":"new","port":80}`. The selected value includes its original
quotes and escapes, not the property name or colon. The replacement body is
source text: EDIT does not quote, escape, or serialize it for you.

Likewise, `$[0]` selects an array element's value, not an adjacent comma.
Replacing the containing array can remove an element structurally;
empty-body replacement only removes the selected text.

## Bytes

On a native binary channel, literal, regex, and glob patterns match bytes
one character per byte; regex `\xNN` matches a byte value. READ shows hex,
one byte per line. COPY and MOVE transfer the selected bytes unchanged;
source and destination scopes use byte positions. Text EDIT bodies do not
author native bytes. Structural and indexed text dialects require a text channel.

## Source coordinates

Exact match locations are `region`; `enclosingRegion` is display context only.
A computed value or a synthesized node can have a locator without a source
span. FIND reports it; READ needs source or enclosing coordinates to show text.
Mutation and transfer require exact source coordinates and do not substitute
an ancestor's text. Scoped READ of a reported exact region retrieves that
fragment.

## Dialect references

- [ECMAScript regular expressions](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects)
- [XPath 1.0](https://www.w3.org/TR/1999/REC-xpath-19991116/)
- [JSONPath, RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)
- [SQLite FTS5 queries](https://www.sqlite.org/fts5.html#full_text_query_syntax)
