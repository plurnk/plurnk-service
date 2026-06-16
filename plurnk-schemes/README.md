# plurnk-schemes

Framework + contract for `@plurnk/plurnk-schemes-*` URI handler packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-execs](https://github.com/plurnk/plurnk-execs).

## Write a scheme

Ship a scheme by publishing a package — **under any scope** (`@acme/whatever`; discovery keys on `plurnk.kind`, not the `@plurnk` scope) — that declares itself and default-exports a `SchemeHandler`. Install it and it lights up; there is no first-party allow-list (scope-agnostic discovery, SPEC §6).

### 1. Declare in `package.json`

```json
{
  "plurnk": { "kind": "scheme", "name": "foo" }
}
```

`plurnk.name` is the URI prefix you claim (`foo://…`). The consumer's scope-agnostic `node_modules` scan registers you by it; two packages claiming one prefix fail-hard.

### 2. Default-export a `SchemeHandler`

```ts
import type {
  SchemeHandler, SchemeManifest, SchemeCtx, SchemeResult, ReadStatement,
} from "@plurnk/plurnk-schemes";

export default class Foo implements SchemeHandler {
  static manifest: SchemeManifest = { /* step 3 */ };

  async read(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult> {
    /* … reach the substrate ONLY through ctx capabilities (SPEC §3.bis, §5) … */
  }
}
```

Implement only the op methods you support — `read` / `find` / `edit` / `copy` / `move` / `send` / … — all optional; the engine calls `handler[op.toLowerCase()](statement, ctx)` and returns **501** for any op you omit. `implements SchemeHandler` gives you compile-time signature checking. The statement + path types (`ReadStatement`, `SendStatement`, `UrlPath`, …) are **re-exported from this package**, so you depend on and exact-pin **only `@plurnk/plurnk-schemes`** — grammar rides underneath.

### 3. Declare the manifest — including self-doc

```ts
static manifest: SchemeManifest = {
  name: "foo",
  channels: { body: "text/markdown" },
  defaultChannel: "body",
  category: "data",
  scope: "session",
  writableBy: ["model", "client"],
  volatile: false,
  modelVisible: true,
  glyph: "🦊",                              // display icon; omit → the name is shown
  example: "READ(foo://thing/42) — read entry 42" // usage + short explanation, shown verbatim
};
```

- **`example`** — a single self-documenting usage line, surfaced **verbatim** in the model's tools listing (like an execs runtime's `example`). May carry a short trailing explanation after the snippet. Omit it and your scheme isn't advertised with a usage line.
- **`glyph`** — a display icon (emoji / nerdfont). Omit it and the scheme `name` is rendered in its place.

### 4. Ship deep docs (beyond the one-liner)

The `example` is the teaser. For real documentation — every op, channel, status code, and gotcha — author a **markdown doc the model reads on demand at `plurnk://schemes/<name>.md`**, which the consumer serves. Keep it model-facing prose; the manifest stays a one-liner, the doc carries the depth. (See plurnk-service for where to place the file in your package.)

That's the whole contract: declare, `implements SchemeHandler`, manifest with self-doc, optional deep doc. Publish, install, discovered.

## Exports

### Types

- Manifest/flags: `SchemeManifest` (incl. `example` / `glyph` self-doc), `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
- Behavior contract: `SchemeHandler` + the re-exported scheme-facing grammar types (`PlurnkStatement` + per-op statements + `ParsedPath` / `LocalPath` / `UrlPath`).
- Result families: `SchemeResult` / `EntryResult` / `ProposalResult` / `PassthroughResult` / `SchemeResultBase` / `TelemetryEvent`.
- Capability ctx: `SchemeCtx` + `EntryCaps` / `ChannelCaps` / `TagCaps` / `NotifyCaps` / `SubscriptionCaps` / `CrossSchemeCaps`, plus `EntryData` / `ChannelState` / `SubscriptionHandle` / `ProposalAware`.

### Helpers (`export default class`, static methods)

- `SchemeResolver.forLoop(handlers, flags)` — active-scheme resolution under loop flags.
- `MimetypeClassifier.isBinary` / `.isLineNavigable` / `.isJson` / `.normalizeAutoText` (+ `TEXT_PRIMITIVE_MIMETYPE` named export) — mimetype classification.
- `Slicer.lines` / `.linesRaw` / `.jsonItems` / `.lineMarkerEdit` / `.jsonItemEdit` — `<L>` slicing + structural EDIT.
- `PathMimetype.resolve(pathname, default, mimetypes)` — path-extension mimetype resolver.
- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher dispatch over `Mimetypes.query` (glob/regex/jsonpath/xpath).
- `Results.error` / `.logCoordinate` / `.isEntry` / `.isProposal` / `.isPassthrough` / `.isErrorStatus` — result builders + guards.
- `SchemeDiscovery.discover({ cwd? })` — scope-agnostic `node_modules` scan for `plurnk.kind:"scheme"` packages (trust-gated, fail-hard on prefix collision); returns descriptors for the consumer to register (SPEC §6).

The **capability ctx** (`SchemeCtx`) is the DB-free authoring surface for siblings — interfaces only; plurnk-service injects the db-backed impl (see SPEC §3.bis). The db-backed implementations themselves (CRUD primitives, entry-op handlers, channel writes, subscription registry) stay in plurnk-service.

## Tests

`test:lint`, `test:unit`.
