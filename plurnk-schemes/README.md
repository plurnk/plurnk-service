# plurnk-schemes

Framework + contract for `@plurnk/plurnk-schemes-*` URI handler packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-contracts](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts), [plurnk-mimetypes](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes), [plurnk-providers](https://github.com/plurnk/plurnk-service/tree/main/plurnk-providers), [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs).

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
    /* … use ctx's stable domain capabilities (SPEC §3.bis) … */
  }
}
```

Implement only the delegated methods you support - `read`, `find`, `editBatch`,
`send`, and the other optional methods in `SchemeHandler`. COPY and MOVE are
engine-owned compositions over `ctx.entries` and `editBatch`, so plugins do not
override them or author COPY/MOVE effect envelopes. A regional `editBatch`
returns `EditBatchResult` with its typed `EditBatchReceipt`; the engine validates
and projects it.
The optional synchronous `attributions(context)` hook may return no, one, or
many opaque tags for each provider emission attempt ({§plugin-attribution}).
`implements SchemeHandler` gives compile-time signature checking. The statement
and path types (`ReadStatement`, `SendStatement`, `UrlPath`, etc.) are re-exported
from this package, so you depend on and peer (`^1`) only
`@plurnk/plurnk-schemes`; grammar rides underneath.

### 3. Declare the manifest — including self-doc

```ts
import { readFile } from "node:fs/promises";

// Deep doc lives in docs/foo.md (convention); loaded at module init.
const documentation = await readFile(new URL("../docs/foo.md", import.meta.url), "utf-8");

static manifest: SchemeManifest = {
  name: "foo",
  channels: { body: "text/markdown" },
  defaultChannel: "body",
  category: "data",
  writableBy: ["model", "client"],
  volatile: false,
  modelVisible: true,
  glyph: "🦊",                          // optional client-only display marker
  example: "READ(foo://thing/42)",      // terse hot-path one-liner, rendered every turn
  documentation,                        // deep doc from docs/foo.md, pulled at worker://plurnk/docs/foo.md
};
```

- **`example`** — the scheme's terse **hot-path** one-liner, rendered in the live catalogue every turn (like an execs runtime's `example`). Keep it to one canonical usage line; depth goes in `documentation`. Omit → not advertised.
- **`documentation`** — the **deep doc** (ops, channels, edge cases). The consumer materializes it as a pull-able `worker://plurnk/docs/<name>.md` entry the model READs on demand — off the hot path. Mirrors `ExecInfo.documentation`. **Convention:** keep it in a **`docs/<name>.md`** file (root) and load it at module init with the snippet above — `../` resolves the same from `src/` (test) and `dist/` (built); add `docs/**/*` to `files`. A missing file fails-hard at import.
- **`glyph`** — optional opaque client display metadata. It is discoverable through the client capability wire and never rendered into model teaching; clients choose fallback, fonts, and theme.

### 4. Self-doc: terse pushes, depth pulls

`example` renders every turn — keep it terse. `documentation` is the deep prose; the consumer materializes it at `worker://plurnk/docs/<name>.md` for the model to READ on demand. Don't dump prose into `example` (it floods the hot path) — put it in `documentation`.

That's the whole contract: declare, `implements SchemeHandler`, manifest with self-doc. Publish, install, discovered.

## Exports

### Types

- Manifest/flags: `SchemeManifest` (including `example` / `documentation` self-doc and client-only `glyph`), `SchemeFlagAffinity`, and `WriterTier`; contracts-owned `LoopFlags` / `DEFAULT_LOOP_FLAGS` are re-exported.
- Behavior contract: `SchemeHandler` + optional `PacketSectionTransformer` (`PacketSectionDraft`); the re-exported scheme-facing grammar types (`PlurnkStatement` + per-op statements + `ParsedPath` / `LocalPath` / `UrlPath`).
- Results: universal `SchemeResult` plus RFC 9457 `ProblemDetails`, optional `EntryResult` / `ProposalResult` / `PassthroughResult` authoring shapes, `SchemeResultBase`, matcher navigation `MatchEvidence`, and target-shaped standard `EntryFindResult` pagination/count metadata.
- Capability ctx: `SchemeCtx` and its entry, channel, tag, notification, projection, and subscription domains. Entry schemes can reuse typed standard operations with semantic commons/worker ownership.

### Helpers (`export default class`, static methods)

- `SchemeResolver.forLoop(handlers, flags)` — active-scheme resolution under loop flags.
- `MimetypeClassifier.isBinary` / `.isJson` / `.normalizeAutoText` (+ `TEXT_PRIMITIVE_MIMETYPE` named export) - registry-free mimetype taxonomy and scheme-local helpers. Configured consumers use `Mimetypes.classify()` for handler-aware binary decisions.
- `Slicer.lines` / `.linesRaw` / `.textReplacement` / `.lineMarkerEdit` / `.lineMarkerEditBatch` - universal text-region projection and same-snapshot replacement; `Slicer.page` handles ordered results, and `.coversAvailable` derives complete coverage from their compact `RangeExtent`.
- `PathMimetype.resolve(pathname, default, mimetypes)` — path-extension mimetype resolver.
- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes)` - boolean resource selection over `Mimetypes.query` (glob/regex/jsonpath/xpath), returning locator/exact-region `MatchEvidence`.
- `Results.problem` / `.failure` / `.assert` / `.assertReadResult` / `.assertMatchEvidenceList` / `.attachInstance` / `.isEntry` / `.isProposal` / `.isPassthrough` / `.isErrorStatus` - RFC 9457 result builders, validators, durable-occurrence attachment, and guards.
- `PacketSections.assertDrafts(value, subject?)` — validates the exact tokenless section-draft list returned by a packet transformer.
- `SchemeDiscovery.discover({ cwd? })` — scope-agnostic `node_modules` scan for `plurnk.kind:"scheme"` packages (trust-gated, fail-hard on prefix collision); returns descriptors plus canonical static attribution lists for represented packages (SPEC §6, {§plugin-attribution}).

`SchemeCtx` is the stable semantic API for trusted in-process schemes, not a
sandbox. The consumer injects its implementation; database layout and private
service modules remain outside the compatibility contract.
Consumers pass only this contract to handlers. Consumer-owned adapters inject
their daemon collaborators separately instead of extending the context.

## Tests

`test:lint`, `test:unit`.
