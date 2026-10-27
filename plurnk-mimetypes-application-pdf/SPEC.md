# PDF handler

## §pdf-magic Header validation and facts line

| Surface | Contract |
|---|---|
| `validate` | Accepts bytes beginning with `%PDF-` directly or after a UTF-8 BOM, and refuses anything else with `SyntaxError`; a non-binary value throws `TypeError` ({§mimetype-binary-input}). |
| `facts` | `pages`: largest `/Count` of a `/Type /Pages` dictionary within the first 8 MiB (`null` when none is visible); `bytes`: source byte length ({§mimetype-binary-input}). |
| `content`, `summary` | One facts line: `PDF document, 3 pages, 12345 bytes` (`1 page` singular; page clause omitted when `pages` is `null`). |
| `deepJson` | The facts record `{ pages, bytes }`. |

Nothing beyond the header is extracted, rendered, or indexed; the document rides the packet as a native part on routes that accept one ({§log-wire-format}).
