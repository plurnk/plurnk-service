# plurnk-schemes

Framework + contract for `@plurnk/plurnk-schemes-*` URI handler packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-execs](https://github.com/plurnk/plurnk-execs).

## Exports

### Types

- Manifest/flags: `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
- Result families: `SchemeResult` / `EntryResult` / `ProposalResult` / `PassthroughResult` / `SchemeResultBase` / `TelemetryEvent`.
- Capability ctx: `SchemeCtx` + `EntryCaps` / `ChannelCaps` / `VisibilityCaps` / `TagCaps` / `NotifyCaps` / `SubscriptionCaps` / `CrossSchemeCaps`, plus `EntryData` / `ChannelState` / `SubscriptionHandle` / `ProposalAware`.

### Helpers

- `resolveForLoop(handlers, flags)` — active-scheme resolution under loop flags.
- `isBinaryMimetype` / `isLineNavigableMimetype` / `isJsonMimetype` / `normalizeAutoTextMimetype` / `TEXT_PRIMITIVE_MIMETYPE` — mimetype classification.
- `sliceLines` / `sliceLinesRaw` / `sliceJsonItems` / `applyLineMarkerEdit` / `applyJsonItemEdit` — `<L>` slicing + structural EDIT.
- `resolveEntryMimetype(pathname, default, mimetypes)` — path-extension mimetype resolver.
- `matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher dispatch adapter over `Mimetypes.query` (glob/regex/jsonpath/xpath).
- Result builders/guards: `schemeError` / `logCoordinate` / `isEntryResult` / `isProposalResult` / `isPassthroughResult` / `isErrorStatus`.

The **capability ctx** (`SchemeCtx`) is the DB-free authoring surface for siblings — interfaces only; plurnk-service injects the db-backed impl (see SPEC §3.bis). The db-backed implementations themselves (CRUD primitives, entry-op handlers, channel writes, subscription registry) stay in plurnk-service.

## Tests

`test:lint`, `test:unit`.
