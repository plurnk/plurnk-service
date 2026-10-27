# PDF handler

§pdf-magic `validate` accepts bytes that begin with the `%PDF-` magic, directly or
after a UTF-8 byte-order mark, and refuses anything else with `SyntaxError`; a
non-binary value is a `TypeError`. The header proves the type; nothing beyond it
is parsed ({§mimetype-pdf-facts}).

§pdf-facts-line The readable body is one line of the facts: `PDF document, 3 pages,
12345 bytes`, with `1 page` singular and the page clause omitted when the count is
unknown. `summary` is that same line and `deepJson` is the facts record
({§mimetype-pdf-facts}).

| Surface | Contract |
|---|---|
| `validate` | Header magic ({§pdf-magic}). |
| `facts` | `pages`: the largest `/Count` of a `/Type /Pages` dictionary within the first 8 MiB, `null` when none is visible; `bytes`: the source length ({§mimetype-pdf-facts}). |
| `content`, `summary` | The facts line ({§pdf-facts-line}). |
| `deepJson` | The facts record ({§pdf-facts-line}). |

Nothing is extracted, rendered or indexed; the document rides the packet as a
native part on a route that accepts one ({§log-wire-format}).
