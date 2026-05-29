# plurnk-schemes

Framework + contract for `@plurnk/plurnk-schemes-*` URI handler packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-execs](https://github.com/plurnk/plurnk-execs).

## Exports

### Types

`SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.

### Helpers

- `resolveForLoop(handlers, flags)` — active-scheme resolution under loop flags.
- `isBinaryMimetype` / `isLineNavigableMimetype` / `isJsonMimetype` / `normalizeAutoTextMimetype` / `TEXT_PRIMITIVE_MIMETYPE` — mimetype classification.
- `sliceLines` / `sliceLinesRaw` / `sliceJsonItems` / `applyLineMarkerEdit` / `applyJsonItemEdit` — `<L>` slicing + structural EDIT.
- `resolveEntryMimetype(pathname, default, mimetypes)` — path-extension mimetype resolver.
- `matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher dispatch adapter over `Mimetypes.query`.

DB-coupled helpers (CRUD primitives, entry-op handlers, channel writes, subscription registry) stay in plurnk-service; this repo ships only types and pure helpers. Forward-spec: a namespaced ctx API replaces the v0 split when third-party schemes are an actual concern.

## Tests

`test:lint`, `test:unit`.
