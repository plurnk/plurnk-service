# plurnk-schemes

Framework + contract for `@plurnk/plurnk-schemes-*` URI handler packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-contracts](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts), [plurnk-mimetypes](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes), [plurnk-providers](https://github.com/plurnk/plurnk-service/tree/main/plurnk-providers), [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs).

## Write a scheme

First-party `@plurnk/plurnk-schemes-*` packages declare `plurnk.kind === "scheme"` in `package.json` and default-export a `SchemeHandler` ({§scheme-discovery}).

### 1. Declare in `package.json`

```json
{
  "name": "@plurnk/plurnk-schemes-foo",
  "plurnk": { "kind": "scheme", "name": "foo" }
}
```

`plurnk.name` is the URI prefix you claim (`foo://…`). The consumer's `@plurnk/*` `node_modules` scan registers you by it; two packages claiming one prefix fail-hard.

### 2. Default-export a `SchemeHandler`

```ts
import type {
  RepresentationPreparationRequest, RepresentationPreparationResult,
  SchemeHandler, SchemeManifest, SchemeCtx,
} from "@plurnk/plurnk-schemes";

export default class Foo implements SchemeHandler {
  static manifest: SchemeManifest = { /* step 3 */ };

  async prepareRepresentation(
    { target, pathname }: RepresentationPreparationRequest,
    ctx: SchemeCtx,
  ): Promise<RepresentationPreparationResult> {
    const { content, mimetype } = await acquire(target);
    const written = await ctx.entries.write(pathname, {
      channels: { body: { content, mimetype } },
    });
    return written.status >= 400 ? written : { status: 200 };
  }
}
```

| Owner | Responsibilities |
| --- | --- |
| **Core** | Owns `plurnk.read`, `plurnk.copy`, and `plurnk.move` channel selection, slicing, anchors, and effect composition over `ctx.entries` and `editBatch`. Passes canonical `authority`-bound `SchemeCtx` without scopes or matchers. |
| **Handler** | Implements scope-blind `prepareRepresentation` (for acquisition schemes) and optional `find`, `editBatch` (returning `EditBatchResult` / `EditBatchReceipt`), `send`, and synchronous `attributions(context)` ({§extension-discovery}). |

- Grammar and path types (`FindStatement`, `SendStatement`, `UrlPath`, etc.) re-export from `@plurnk/plurnk-schemes` (`peerDependencies: "^3.0.0"`).

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
  lineAnchors: true,                    // publish stable line anchors without EDIT
  textEditScopes: true,                 // use the standard text-edit capability
  glyph: "🦊",                          // optional client-only display marker
  documentation,                        // deep doc from docs/foo.md, READ on demand
};
```

- **`documentation`** — the **deep doc** (ops, channels, edge cases) with an exact H2 `Summary`. The consumer materializes it as a pull-able `plurnk:///<name>.md` entry: FIND catalogs the summary and the model READs the body on demand, off the hot path. It is analogous to executor supplemental `details`. **Convention:** keep it in a **`docs/<name>.md`** file (root) and load it at module init with the snippet above — `../` resolves the same from `src/` (test) and `dist/` (built); add `docs/**/*` to `files`. A missing file fails-hard at import.
- **`glyph`** — optional opaque client display metadata. It is discoverable through the client capability wire and never rendered into model teaching; clients choose fallback, fonts, and theme.

Declare `lineAnchors: true` when stable textual representations should publish
and accept shared anchors without supporting EDIT. Declare `textEditScopes: true`
only when `editBatch` accepts PLURNK's shared
text-coordinate algebra. Core's universal READ projection derives and resolves
any model-facing line anchor; scheme handlers receive numeric
`ResolvedEditStatement` coordinates only. Delegate those edits to
`ctx.entries.operations.editBatch`; it owns the anchor recheck and atomic
collision guard.

### 4. Discoverable references

Put operation contracts and examples in `documentation`. Its `## Summary` orients the model during FIND; the model READs the reference when it needs the details.

That's the whole contract: declare, `implements SchemeHandler`, manifest with self-doc. Publish, install, discovered.

## Exports

### Types

- Manifest: `SchemeManifest` (including capability `traits`, `documentation`, and client-only `glyph`) and `WriterTier`.
- Behavior contract: `SchemeHandler`, numeric-only `ResolvedEditStatement`, and optional `PacketSectionTransformer` (`PacketSectionDraft`); the remaining re-exported scheme-facing grammar types (`PlurnkStatement` + per-op statements + `ParsedPath` / `LocalPath` / `UrlPath`).
- Results: universal `SchemeResult` plus RFC 9457 `ProblemDetails`, optional `EntryResult` / `ProposalResult` / `PassthroughResult` authoring shapes, `SchemeResultBase`, matcher navigation `MatchEvidence`, and target-shaped standard `EntryFindResult` pagination/count metadata.
- Capability ctx: `SchemeCtx` and its entry, channel, notification, projection, and subscription domains. Entry schemes reuse typed standard operations at canonical workspace addresses.

### Helpers (`export default class`, static methods)

- `MimetypeClassifier.isBinary` / `.isJson` / `.normalizeAutoText` (+ `TEXT_PRIMITIVE_MIMETYPE` named export) - registry-free mimetype taxonomy and scheme-local helpers. Configured consumers use `Mimetypes.classify()` for handler-aware binary decisions.
- `Slicer.lines` / `.linesRaw` / `.textReplacement` / `.lineMarkerEdit` / `.lineMarkerEditBatch` - universal text-region projection and same-snapshot replacement; `Slicer.page` handles ordered results, and `.coversAvailable` derives complete coverage from their compact `RangeExtent`.
- `PathMimetype.resolve(pathname, default, mimetypes)` — path-extension mimetype resolver.
- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes)` - boolean resource selection over `Mimetypes.query` (glob/regex/jsonpath/xpath), returning locator/exact-region `MatchEvidence`.
- `Results.problem` / `.failure` / `.assert` / `.assertReadResult` / `.assertMatchEvidenceList` / `.attachInstance` / `.isEntry` / `.isProposal` / `.isPassthrough` / `.isErrorStatus` - RFC 9457 result builders, validators, durable-occurrence attachment, and guards.
- `PacketSections.assertDrafts(value, subject?)` — validates the exact unweighted section-draft list returned by a packet transformer.
- `SchemeDiscovery.discover({ cwd? })` — first-party `@plurnk/*` `node_modules` scan for `plurnk.kind:"scheme"` packages (fail-hard on prefix collision); returns descriptors plus canonical static attribution lists for represented packages ({§scheme-discovery}, {§extension-discovery}).

`SchemeCtx` is the stable semantic API for trusted in-process schemes, not a
sandbox. The consumer injects its implementation; database layout and private
service modules remain outside the compatibility contract.
Consumers pass only this contract to handlers. Consumer-owned adapters inject
their daemon collaborators separately instead of extending the context.

## Tests

`test:lint`, `test:unit`.
