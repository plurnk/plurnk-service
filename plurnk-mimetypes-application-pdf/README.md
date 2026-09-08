# @plurnk/plurnk-mimetypes-application-pdf

`application/pdf` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Binary content. Nothing is extracted or rendered: the readable body is the document's header facts, and the document itself rides the model packet as a native document part on a route whose model accepts one.

Part of the default service install, exactly as the image handler is.

## what it does

- `validate(content)` checks the `%PDF-` header (a UTF-8 BOM before it is tolerated); throws `SyntaxError` on non-PDF input.
- `facts(content)` reports `{ pages, bytes }` — `pages` is the root page tree's `/Count`, or `null` when the tree sits inside a compressed object stream.
- `content(content)` / `summary(content)` are the same one line: `PDF document, 12 pages, 48213 bytes`.
- `deepJson(content)` is the facts object.

A `READ` of a PDF member delivers the bytes to the provider as a native document attachment when the route declares document input ({§packet-attachment-parts} in plurnk-core's SPEC); on a route that does not, the READ reports the attachment as unsupported exactly as an unsupported image does. A model that needs the text runs the workspace's own tools through `EXEC` (`pdftotext`, `pdfinfo`, …); the daemon does no extraction and no lexical indexing of PDF content.

## license

MIT.
