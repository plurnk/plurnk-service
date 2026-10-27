# @plurnk/plurnk-mimetypes-application-pdf

`application/pdf` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Binary content: nothing is extracted or rendered.

## install

```sh
npm i @plurnk/plurnk-mimetypes-application-pdf
```

Part of the default service install, exactly as the image handler is.

## what it does

- `validate(content)` checks the `%PDF-` header ({§pdf-magic}).
- `facts(content)` reports `{ pages, bytes }` ({§mimetype-pdf-facts}); `content`, `summary` and `deepJson` are that facts record ({§pdf-facts-line}).

The document itself rides the packet as a native document part on a route that accepts one ({§log-wire-format}); a model that needs the text runs the workspace's own tools through an executor fence.

## license

MIT.
