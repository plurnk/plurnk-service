# plurnk-schemes — Specification

Contract for `@plurnk/plurnk-schemes-*` sibling packages. Audience: implementer of a URI scheme handler. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §3).

## §manifest §1 Manifest

```json
{
    "name": "@plurnk/plurnk-schemes-<name>",
    "plurnk": { "kind": "scheme", "name": "<scheme name>" }
}
```

Class-level manifest (static field on the default export):

```ts
import type { SchemeManifest } from "@plurnk/plurnk-schemes";

class Notes {
    static manifest: SchemeManifest = {
        name: "notes",
        authority: "namespace",
        channels: { body: "text/markdown", preview: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        textEditScopes: true,
        flags: { /* optional SchemeFlagAffinity */ },
    };
}
```

| Field | Constraint |
|---|---|
| `name` | Matches `package.json#plurnk.name`. Addressing/routing identity (the URI prefix). |
| §manifest-authority `authority?` | URI-authority disposition: `"namespace"` folds authored authority into pathname; `"resource"` preserves it as the entry authority; `"owner"` consumes it while selecting the entry owner. Absent means `"namespace"`. |
| `channels` | `Record<channelName, mimetype>`. Channel names lowercase. Empty = dynamic per-call. |
| `defaultChannel` | Channel targeted when path has no `#fragment`. Dynamic-channel schemes may name it without fixing a mimetype; empty means no default. |
| `category` | `"data"` (entry-bearing) \| `"logging"` (`log://` rows) \| `"control"` (addresses sister workers, owns no entries — e.g. `worker://`). |
| `writableBy` | Subset of `["model", "client", "_plurnk", "plugin"]`; empty declares an immutable scheme. Consumer returns 403 for outside-set writes. |
| `volatile` | Boolean. |
| `modelVisible` | Boolean. |
| `folderScopes?` | `true` declares that a trailing slash on FIND is a collection scope. Absent/false means `/` is ordinary resource syntax. |
| `lineAnchors?` | `true` publishes and accepts shared line anchors for stable textual representations without declaring EDIT support. |
| `textEditScopes?` | `true` declares the shared textual EDIT coordinate and collision contract. For model-writable schemes it implies `lineAnchors`; handlers receive only numeric coordinates and route standard entry mutation through `ctx.entries.operations.editBatch`. |
| `flags?` | Optional exact `SchemeFlagAffinity`; see {§manifest-flag-affinity}. |
| `example?` | The scheme's concise **hot-path** operation example set (e.g. `"## READ0 (foo://thing/42)"`) — renders in the live resource catalogue every turn. One or more complete operations may be separated by blank lines; keep semantics in `documentation`. Omit → not advertised. |
| `documentation?` | The **deep doc** (semantics / channels / edge cases), with an exact H2 `Summary` for discovery. Consumer materializes it as a pull-able `worker://plurnk/skills/plurnk/<name>.md` entry READ on demand; never hits the hot path. Analogous to executor supplemental `details`. |
| §manifest-client-display `glyph?` | Non-empty opaque client presentation glyph. It is projected through {§client-display-capabilities}; omission delegates identity fallback to the client. It never enters model teaching. |
| `foldedByDefault?` | Entries land FOLDED, off the ranked manifest surface (READable via address, not poured into the ranked view). For executor-output streams (`<tag>://`) — containment one level up. Absent/false → ranked/first-class. |
| `storedScheme?` | Value persisted to `entries.scheme`, which may differ from the addressing `name`. Absent defaults to `name`. It must be a non-null string because every persisted identity component is non-null. |

The manifest is closed: unknown top-level fields fail admission. Entry
visibility is not manifest metadata; the consumer resolves it through the
entry owner's identity.

§manifest-flag-affinity `flags` is a closed environmental-authority declaration.
Unknown flag fields fail manifest admission; absent fields are false. Only registered
schemes enter affinity evaluation; an unknown name remains the consumer's
registration failure.

| Field                  | Scheme is inactive when          | Declared requirement                    |
| ---------------------- | -------------------------------- | --------------------------------------- |
| `excludedInAsk`        | `mode === "ask"`                 | Act-mode operation authority            |
| `requiresWeb`          | `noWeb === true`                 | Web access                              |
| `requiresInteraction`  | `noInteraction === true`         | Interactive access                      |

Proposal behavior is not scheme affinity. A handler proposes by returning 202;
the consumer's proposal lifecycle decides whether a client, loop auto,
`noProposals`, or a timeout resolves it.

§manifest-self-doc **Self-doc split (terse pushes, depth pulls).** `example` is the hot-path operation example set rendered every turn — keep it terse. `documentation` is the deep prose (every op, channel, status code, gotcha); the consumer materializes it as a pull-able **`worker://plurnk/skills/plurnk/<name>.md`** entry whose exact H2 `Summary` is catalogued and whose body the model READs on demand, off the hot path. Both live on the manifest; the consumer decides what's pushed vs pulled. `glyph` is client display metadata under {§manifest-client-display}, not self-documentation.

**Authoring convention — `docs/<name>.md`.** The contract field stays a plain `string`, but a sibling SHOULD keep the deep doc in a **`docs/<name>.md`** file at the package root rather than inline, and load it into the manifest at module init — e.g. `documentation: await readFile(new URL("../docs/<name>.md", import.meta.url), "utf-8")` (top-level await; `../` resolves identically from `src/` in test and `dist/` once built). Ship it by adding `docs/**/*` to `files`. This keeps prose out of the handler source and gives editors real Markdown; the consumer materializes it at `worker://plurnk/skills/plurnk/<name>.md`. A missing file fails-hard at import (no silent empty doc).

## §2 Interface

Sister scheme handlers implement op methods consumed by plurnk-service via
dispatch. The consumer owns READ for every `category: "data"` scheme and owns
exact-target FIND over its canonical representation; no handler method can
replace either projection. Other absent operation methods return **501**. The
exported **`SchemeHandler`** interface gives operation methods their grammar
statement and `ctx`, while representation preparation receives a deliberately
narrower request. `editBatch` returns the typed `EditBatchResult`
specialization:

```ts
import type { EditBatchResult, ResolvedEditStatement, SchemeHandler } from "@plurnk/plurnk-schemes";

export interface SchemeHandler {
    ready?(): Promise<void>;
    close?(): Promise<void>;
    resolveEntryAddress?(target: ParsedPath, ctx: SchemeCtx): Promise<EntryAddress | SchemeResult | null>;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;
}
```

§resolved-edit-statement `ResolvedEditStatement` is the scheme-facing EDIT
shape: its `lineMarker` is `LineMarker | null` and therefore contains numbers
only. Core resolves the model-facing {§text-line-anchor-syntax} before invoking
`SchemeHandler.editBatch` or `EntryOperationCaps.editBatch`; an unresolved
anchor crossing that boundary is an internal contract violation. The barrel's
compatibility export named `EditStatement` aliases this resolved shape, so
existing plugins do not inherit the model parser's anchor representation.
The anchor precondition remains core-private. A public handler declaring
`textEditScopes: true` MUST route its standard textual mutation through
`ctx.entries.operations.editBatch`, which rechecks that precondition at the
snapshot owner and lands with the consumer's compare-and-swap. Applying the
numeric coordinates independently would discard the declared collision
contract. Core-owned special resources enforce the equivalent invariant inside
their mutation adapter.

§read-preparation `prepareRepresentation?` is the optional, operation-neutral
acquisition seam for one exact resource. Core first resolves its canonical
authority, pathname, and owner, binds `ctx.entries`/channels/subscriptions to
that exact coordinate and owner, and removes the channel fragment. The request
is exactly `{ target, authority, pathname }`: READ coordinates, FIND matchers,
the selected channel, and operation intent are structurally unavailable.

A stored scheme omits the hook. An acquired scheme writes its complete channel
topology through `ctx.entries` and returns `200` readiness. A live scheme first
seeds those same canonical channels, opens a subscription, and may return `102`
only while production remains live. Other statuses are exact terminal results.
Per-channel producer status belongs durably on that channel as
`producerResult`; no transient preparation result may carry content, channel
selection, or channel outcomes. After `200`, core alone selects the authored
channel, applies tag/binary/text rules (including markerless `<1,16>`), and
composes that channel's producer evidence. Cold and warm reads therefore have
identical semantics.

Exact FIND uses the same `prepareRepresentation?` seam and then the standard
entry query; the queried default channel's durable producer result composes
with that exact query just as it does with exact READ. `prepareFind?` is only
the optional broad-scope discovery seam
used before standard entry selection when no custom broad `find()` exists. A
custom `find()` may own genuinely different candidate enumeration, but never
exact-resource materialization or READ coordinates. Every standard query uses
the same canonical identity as `ctx.entries`; URL authority cannot disappear
between preparation and lookup.

An exact COPY/MOVE source also resolves and prepares through this seam before
core selects its canonical stored channel. COPY/MOVE retain their own source
scope algebra: an absent source scope means the complete channel and an explicit
scope preserves raw source separators. Neither distinction is exposed to the
producer. A live `102` leaves the composition unapplied; a ready representation
is selected from the same channels used by READ and exact FIND. A selected
channel's producer failure aborts before destination mutation; successful
non-`200` content remains eligible for transfer.

§entry-address-resolution `resolveEntryAddress?` gives a client observation the
same address law as model-facing operations without creating a second CRUD
protocol. Core removes the channel fragment and target-slot pathname aliases
{§path-parentheses} before invocation; query and other identity components
remain exact. The hook returns the canonical stored `authority`, `pathname`,
and a semantic owner:

| Return                                  | Meaning                                           |
|-----------------------------------------|---------------------------------------------------|
| `{ authority, pathname, owner: "commons" }` | Resolve the exact resource in the shared workspace namespace |
| `{ authority, pathname, owner: "worker" }` | Resolve the exact resource in the calling worker's namespace |
| Non-success `SchemeResult`              | Preserve an expected address refusal exactly      |
| `null`                                  | The selector names no client-visible entry        |
| Hook absent                             | Use the standard pathname and `commons` ownership |

The consumer supplies the observing worker through `SchemeCtx`, lowers the
semantic owner to its private storage identity, and performs the read. A plugin
never receives or returns database owner IDs. Schemes implement the hook only
when their standard operation path has scheme-specific canonicalization or
caller ownership; the hook must apply that same rule rather than inventing a
client-only address vocabulary.

A sibling does `export default class X implements SchemeHandler` (with `static manifest: SchemeManifest`) and gets compile-time signature checking. Every registered handler exposes either that static manifest or an instance `manifest` for dynamically derived identities; `Manifest.of` validates the complete resolved declaration and its registration name before the handler becomes dispatchable. The interface is the handler-delegable subset of grammar's operation union. `LOOK`/`BUFF` are client-facing operations, OPEN/FOLD are core-owned log curation, and WORK/FORK/PLAN are core-owned worker/program operations; none is dispatchable to a plugin scheme. **The statement + path types (`ReadStatement`, `SendStatement`, `UrlPath`, …) are re-exported from this barrel**, so a sibling depends on and peers (`^1`) ONLY `@plurnk/plurnk-schemes` — grammar rides underneath as the framework's transitive dep (§3).

§handler-lifecycle A registered handler object is a process-lived shared
instance and may receive overlapping operation calls. Retained handler state is
ordinary; handlers must make concurrent access and semantic isolation explicit.

| Concern            | Contract |
| ------------------ | -------- |
| Readiness          | `ready?()` runs after registration and before capability advertisement. It establishes that advertised resources are usable. |
| Hook cardinality   | The consumer invokes each hook once per unique handler object identity, even when multiple registered names share that object. |
| Operation context  | `SchemeCtx` and capabilities extracted from it remain operation-owned under {§scheme-ctx-lifetime}; only the `StreamSubscription` returned by `subscriptions.open` is retainable. |
| Retained state     | Tenant- or address-selectable state keys every semantic isolation coordinate. A global pool is valid only when it carries no cross-tenant session state. |
| Live ownership     | An address-selectable live resource has one unambiguous owner. Conflicting acquisition fails explicitly; it never overwrites the existing owner. |
| Shutdown           | After in-flight scheme work drains and before backing stores close, `close?()` releases partially or fully initialized handler resources. The consumer attempts and awaits every unique handler close, then aggregates every failure. |

Handlers without initialization or retained resources omit the corresponding
hook.

The entry CRUD primitives (`readEntry`/`writeEntry`/`deleteEntry`) are not handler operations; schemes use `ctx.entries`. Proposal application is the optional `applyResolution` handler hook described in §3.bis.

OPEN and FOLD are not handler methods. They curate visibility by filtering tags
on the core-owned log; an entry scheme has no visibility or tag state and
receives 501.

§scheme-edit-batch-receipt **Regional mutation receipts.** COPY and MOVE are not
handler methods. The engine composes their source and
destination resource selections over `ctx.entries` and uses `editBatch` for a
scoped destination or source mutation. This keeps channel selection, snapshot
ordering, cross-scheme failures, and proposal sequencing uniform for every data
scheme. Scheme hooks return their ordinary mutation result and, for a regional
`editBatch`, an `EditBatchResult` carrying its aggregate `EditBatchReceipt`:

```ts
type EditReceiptUnit = "lines" | "codePoints";

interface EditEffectReceipt {
    readonly requested: string;
    readonly source: string;
    readonly result: string;
    readonly removed: number;
    readonly inserted: number;
    readonly context: string;
}

interface AppliedEditBatchReceipt {
    readonly revision: string;
    readonly unit: EditReceiptUnit;
    readonly before: number;
    readonly after: number;
    readonly parseIssues?: number;
    readonly effects: readonly EditEffectReceipt[];
}

interface ReviewerReplacementEditBatchReceipt {
    readonly revision: string;
    readonly unit: EditReceiptUnit;
    readonly before: number;
    readonly after: number;
    readonly parseIssues?: number;
    readonly disposition: "reviewer-replaced";
    readonly superseded: readonly string[];
    readonly replacement: EditEffectReceipt;
}

type EditBatchReceipt =
    | AppliedEditBatchReceipt
    | ReviewerReplacementEditBatchReceipt;

interface EditBatchResult extends SchemeResult {
    readonly editReceipt?: EditBatchReceipt | null;
}
```

| Batch outcome                        | Authored correlation                              | Landed effects                                                        |
| ------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| Applied as proposed                  | `effects[N]` describes authored EDIT `N`          | One truthful effect per authored EDIT                                 |
| Resolver replaced the proposed body  | `superseded[N]` retains authored marker `N`       | One `replacement` effect describes the bytes that actually landed     |

The replacement form is not a heuristic attribution. An arbitrary resolver
body supersedes every authored EDIT because its correspondence to those edits
cannot be known. The consumer projects the replacement once on the durable
proposal-owning row and projects each authored marker's superseded disposition
on its own row.

`context` is an ordered, source-numbered projection of the landed result. For a
consumer-selected count `C`, it contains up to `C` surrounding lines and the
first and last `C` landed lines at each result boundary. Overlapping windows
coalesce and coordinate jumps expose an omitted middle. A deletion instead
contains up to `C` lines on each side of its join.

The engine validates that receipt and owns the ordered COPY/MOVE resource
effects shown to consumers; plugins do not invent a second effect envelope.
`parseIssues`, when present, is the positive parser-recovery count for the
complete resulting revision. Zero and unavailable evidence are omitted. The
hint is advisory: inspection failure does not reverse a landed mutation.

## §3 Helpers exported by this repo

### Types

- Manifest/flags: `SchemeManifest`, `SchemeAuthority`, `EntryCoordinate`, `SchemeFlagAffinity`, and `WriterTier`; contracts-owned `LoopFlags` and `DEFAULT_LOOP_FLAGS` are re-exported for compatibility.
- Mutation receipts: `EditBatchResult`, `EditBatchReceipt`, `EditReceipt`, `EditEffectReceipt`, and `EditReceiptUnit`.
- §scheme-packet-transform **Packet-section transformation.** A scheme may implement `transformSections(sections: PacketSectionDraft[]) → PacketSectionDraft[] | Promise<…>` to add, remove, or reorder sections before core measures the packet. The exact draft shape is `{ name; slot: "system"|"user"; header: string|null; content }`; no token measurement exists at this boundary. Core invokes implementations in registration order and applies `PacketSections.assertDrafts` to the initial list and every returned list. Names are non-empty and unique within the packet.
- Behavior contract: `SchemeHandler` (§2). Scheme-facing grammar types re-exported here so siblings pin only this package: `PlurnkStatement` + the per-op statement types (`ReadStatement`, `FindStatement`, `OpenStatement`, `FoldStatement`, `CopyStatement`, `MoveStatement`, `SendStatement`, `ExecStatement`, `WorkStatement`, `ForkStatement`, `KillStatement`, `PlanStatement`) and path types (`ParsedPath` = `LocalPath` | `UrlPath`). EDIT uses `ResolvedEditStatement`, also exported under the compatibility name `EditStatement`, under {§resolved-edit-statement}.
- Target syntax: contracts-owned `PathSyntax` is re-exported for the shared exact-versus-path-glob classifier {§path-glob}.
- Discovery: `SchemeDiscovery` (behavior class) with `SchemeInfo` / `SchemeDiscoveryResult` / `DiscoverOptions` (§6).
- §executor-scheme-output Executor-scheme ("an executor is a scheme"): `OutputScheme.manifestFromRuntime(decl)` derives a read-only-output `SchemeManifest` from an executor's `RuntimeDecl` (zero scheme-authoring). Executor output is a canonical entry and therefore inherits core's exact READ projection under {§read-preparation}; no executor-specific READ helper exists. `Summarize.summarize(content, mimetype)` -> `OrientIndex` is the structural-only EXEC-receipt index (no content - universal-receipt containment). A per-tag executor-scheme supplies its manifest via instance `get manifest()` (§2 `SchemeHandler.manifest?`).
- Results: `SchemeResult` is the universal operation-result contract. Statuses below 400 carry no `problem`; statuses 400–599 require RFC 9457 `ProblemDetails`, and the legacy `error` member is forbidden. `EntryResult`, `ProposalResult`, and `PassthroughResult` are optional conventional shapes, not engine routing discriminators. Guards inspect those optional shapes; proposal routing itself is engine-owned and follows status plus operation semantics.
- Standard `EntryFindResult` exposes only its paged `results`, complete `matchingPathCount` / `matchLocationCount`, `itemsWeightTotal` / `returnedItemsWeightTotal`, and typed range. `EntryCatalogChannel.weight` and `EntryCatalogScope.weight` are model-independent curation weights; model-facing JSON may project them under its own vocabulary. Each resource-mode `EntryCatalogItem` is a nonempty, default-first array of flat `EntryCatalogChannel` objects; a scope is the one-element `EntryCatalogScopeGroup`. Exact matcher mode returns flat `MatchEvidence` locations. Pagination is the materialization bound; no path-owning channel wrapper, hidden `matches`, `pathnames`, or overflow-only result collection exists.
- §scheme-catalog-parse-issues An `EntryCatalogChannel` may carry a positive `parseIssues` count when its exact content projection reported parser recovery sites. Zero and unavailable evidence are omitted. This is advisory metadata and never a validity gate or operation failure.
- Capability ctx (see §3.bis): `SchemeCtx`, `StreamSubscription`, and the domain capabilities. Entry authors additionally receive `EntryOperationCaps`, semantic `EntryOwner`/`EntryAddress`, and typed standard-operation results. `editBatch` receives every same-turn EDIT for one canonical resource and channel; it validates against one snapshot and commits one revision or none. There is no sequential single-EDIT fallback.

Behavior ships as `export default class` (one class per file, static methods) — the ecosystem class paradigm. Type-only modules, the barrel, and the frozen `DEFAULT_LOOP_FLAGS` constant are the only non-class files.

### §network-address Network address identity

`NetworkAddress.from(target)` is the single non-secret normalization path for
HTTP and WebSocket targets. It returns the exact addressed `scheme`, canonical
entry `authority` and `pathname`, a fragmentless and credential-free transport
`url`, and whether userinfo was present so the handler can reject it.

| Component        | Entry identity                                      | Transport URL | Plurnk channel |
|------------------|-----------------------------------------------------|---------------|----------------|
| Scheme           | Exact `http`, `https`, `ws`, or `wss`               | Yes           | No             |
| Host             | Canonical WHATWG hostname                            | Yes           | No             |
| Port             | Non-default port                                     | Yes           | No             |
| Path             | Canonical pathname                                   | Yes           | No             |
| Query            | Serialized order, duplicates, and explicit empty `?` | Yes           | No             |
| Fragment         | No                                                   | No            | Yes            |
| Userinfo/headers | No                                                   | No            | No             |

The canonical storage coordinate is authority `<host>[:<port>]` plus pathname
`<path>[?<query>]`, keyed together with workspace, owner, and the exact
addressed scheme. `NetworkAddress.render({ scheme, authority, pathname })` is
its model-facing inverse: it applies the Plurnk lexical target spelling
{§path-parentheses} after reconstructing the exact address. Transport URLs and
storage identity never carry that syntax layer. Routing aliases select a
handler; they do not collapse resource identity.

### Active-scheme resolution — `SchemeResolver`

- `SchemeResolver.forLoop(handlers: ReadonlyMap<string, object>, flags: LoopFlags): Set<string>` — applies `manifest.flags` affinity to each handler and returns names of schemes active under the loop's flags.

### §mimetype-classifier Mimetype classification — `MimetypeClassifier`

- `MimetypeClassifier.isBinary(mimetype)` — pure taxonomy for a registry-free boundary. Delegates to `classifyMimetype` from `@plurnk/plurnk-mimetypes`; a consumer with a configured `Mimetypes` service uses `Mimetypes.classify()` so installed handler declarations remain authoritative ({§mimetype-classification}).
- `MimetypeClassifier.isHtml(mimetype)` — recognizes the normalized web-projection family: `text/html` and `application/xhtml+xml`.
- `MimetypeClassifier.isJson(mimetype)` - `application/json` plus `+json` variants, used only by result summarization.
- `MimetypeClassifier.normalizeAutoText(mimetype)` — `text/plain` / null / undefined → `TEXT_PRIMITIVE_MIMETYPE` (`text/markdown`).
- `TEXT_PRIMITIVE_MIMETYPE` — `"text/markdown"` (named export from the same module).

### §scheme-projection Projection capability

Acquisition schemes delegate model-facing projection to the consumer's one
configured mimetype family. They neither instantiate readers nor widen durable
entry channels beyond Unicode text.

| Surface                           | Contract                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `readable(content, mimetype)`     | Project an acquired Unicode representation.                                                           |
| `readableBytes(chunks, mimetype)` | Project one async byte source under the mimetype family's bounded-input policy.                       |
| `identity(mimetype)`              | Return the opaque identity of configured projection behavior for cache and materialization freshness. |
| `isBinary(mimetype)`              | Classify through the configured registry; installed handler declarations remain authoritative.        |
| `parseIssues(content, mimetype)`  | Return positive parser-recovery evidence, or omit unavailable/clean evidence, under {§mimetype-parse-issues}. |
| `ProjectedText`                   | Derived Unicode plus its output mimetype, source mimetype, and opaque projection identity.            |

A returned object is present even when its `content` is `""`; only `null`
denotes absence. Consumers must not infer projection presence from content
length. Thrown readable, identity, and classification calls are execution
failures whose causes propagate; they must never be converted to `null`.
Parser-recovery inspection is deliberately non-gating: its implementation
surfaces tooling failure as a Notice and returns `undefined`.
`ProjectionInputLimitError` is the projection boundary's exported name for the
configured mimetype family's typed bounded-input failure.

### §slicer-text-algebra Text-region slicing and replacement - `Slicer`

`Slicer` owns one text algebra for every textual mimetype:

| Scope | Meaning |
|---|---|
| `<N>` | whole physical line `N` |
| `<N,M>` | inclusive whole physical lines `N..M` |
| `<SL,SC,EL,EC>` | exact exclusive-end region using 1-based Unicode code-point columns |
| `<0>` / `<-1>` | mutation anchors before the first / after the final line |

As an unadvertised ingestion tolerance, `Slicer` accepts
`<startLine,startColumn,endLine>` and immediately lowers it to the complete
four-coordinate region ending after the final code point of `endLine`.
Successful results carry schemes-owned, boundary-validated normalization
evidence containing both the authored and canonical coordinates. Producers do
not emit or proactively teach the tolerated form.

A harmless end-bound overshoot clamps rather than erroring: an oversized line
range ends at the final line, an exact end line beyond the content ends at EOF,
and an oversized end column ends at its line's final code point. Start-line and
start-column overshoots remain 416 errors.

- `Slicer.lines(content, marker)` returns the selected text, source
  `startLine`, and complete resolved `region`; `Slicer.linesRaw` preserves
  original newline separators for COPY/MOVE source transfer.
- `Slicer.textReplacement(content, marker, body)` lowers a line shorthand or
  exact region to one `{start,end,body}` replacement against the source
  snapshot.
- `Slicer.lineMarkerEdit` applies one replacement.
- `Slicer.lineMarkerEditBatch` validates all replacements against one snapshot,
  rejects overlaps, and applies all or none.
- `Slicer.page(items, marker, options?)` is the separate ordered-result
  pagination helper; it accepts only one or two integer positions and can name
  an operation-owned range unit. `allowEmpty` preserves an otherwise valid
  positive request when an upstream filter yields no items.
- `Slicer.coversAvailable(range)` derives whether a successful range selected
  the complete available extent; that fact is never serialized separately.

A successful line or pagination selection carries the contracts-owned
`RangeExtent` {§range-extent}; a 416 carries the same extent without
`returned`. Exact regions use `region` instead. An exact-region failure,
including a failed tolerated three-coordinate scope, carries
`requestedCoordinates` exactly as authored; an invalid-arity text scope does
likewise. Both carry `columnKind: "unicodeCodePoints"`.

### §path-extension-mimetype Path-extension mimetype — `PathMimetype`

- `PathMimetype.resolve(pathname, defaultMimetype, mimetypes)` — pathname extension → `Mimetypes.detect({ ext })`; falls back to `defaultMimetype` when no extension. text/plain auto-normalizes to text/markdown.

### Result families — `Results`

- `Results.isEntry` / `Results.isProposal` / `Results.isPassthrough` — guards for the optional conventional result shapes.
- `Results.isErrorStatus(status)` — `status >= 400`.
- `Results.problem(owner, code, status, detail, extensions?)` — build and validate RFC 9457 Problem Details with a stable `https://problems.plurnk.dev/<owner>/<code>` type.
- `Results.failure(owner, code, status, detail, fields?, extensions?)` — build and validate a failed operation result.
- `Results.assert(result)` — validate the complete success/failure discrimination and reject malformed plugin output.
- `Results.assertMatchEvidence(evidence)` / `assertMatchEvidenceList(evidence)` - enforce the exact `{ locator?, region? }` shape and shared `TextRegion` contract.
- `Results.assertReadResult(result)` - validate the universal operation result plus any `region` and `matches` it exposes.
- `Results.attachInstance(result, uri)` — attach the durable occurrence URI to a failed result.

A handler owns its failure classification and explanation. The daemon owns the
durable `instance`, because only it knows the committed log coordinate. A
malformed handler result is a plugin contract violation and fails hard; the
consumer does not invent a fallback error or reinterpret arbitrary fields.
The same discrimination applies to every `SchemeCtx` capability result:
entries and channels never return a bare failure status.

### Matcher dispatch - `Matcher` {§matcher-dispatch}

- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes)` is the body-matcher adapter over `Mimetypes.query` (glob/regex/jsonpath/xpath).
- A match returns status 200 and `matches: MatchEvidence[]`.
  `MatchEvidence` is `{locator?, region?}`. `locator` preserves a structural locator;
  `region` is a complete four-coordinate `TextRegion` only when the finding has
  an honest exact or nearest-enclosing mapping into the text the model can READ.
  Each item must contain at least one of `locator` or `region`; other fields violate
  the shared evidence contract.
- The matcher is a boolean resource selector. It does not replace content with matched values or choose a retrieval window. FIND owns selection and pagination; exact READ owns text projection.
- Empty results return 204 with `matches: []`; `UnsupportedDialectError` maps to 415; `InvalidExpressionError` maps to 400; `QueryParseFailureError` maps to 203 with raw content, text/markdown, and `reason`.
- A multi-resource matcher omits candidates that return 415 when at least one candidate supports the dialect. If no candidate supports it, the matcher returns the first exact 415 Problem. An unreadable binary marker therefore cannot poison a repository-wide text search or masquerade as a match.

### §capability-ctx §3.bis Capability ctx — the stable trusted-extension surface

Scheme plugins are trusted in-process Node.js code. `SchemeCtx` is not a
sandbox or a security boundary; an installed plugin already has the process's
authority. It is the stable semantic API that keeps plugins independent of
database schemas, prepared-statement names, and private service modules.
**Interfaces only**: this repo exports the contract and the consumer injects
its implementation.

`SchemeCtx` carries per-dispatch identity (`workspaceId`/`workerId`/`loopId`/`turnId`/`writer`/`signal`) plus **six live capability namespaces** replacing raw `db`:

- `entries` — direct storage over the scheme and authority already bound by core
  (`read`/`write`/`delete`) plus `operations`, the standard PLURNK
  `READ`/`EDIT`/`FIND`/`SEND` implementation for entry-bearing schemes.
  A write may omit channel state to select the `static` default; a successful
  storage read always returns each channel's persisted lifecycle state.
  Optional `attributes` are scheme-private durable metadata. They are scoped to
  that entry, replaced only when explicitly written, and never projected into
  model content, catalogs, or client entry data.
  Standard operations are bound to the handler's manifest. Their optional
  owner is semantic: `"commons"` (default) or the current `"worker"`; database
  owner IDs are not part of the plugin contract. A handler may implement its
  own op method instead. In particular, a handler with `find()` owns FIND; one
  without it receives the standard stored-entry behavior.
- `channels` — content writes + state (`append`/`replace`/`setState`).
- `notify` — between-turn client signal (`streamEvent`, metadata-only); not model-facing. (No `wakeWorker`: the worker wake carries subscription-close context that only exists at stream completion, so it lives on `subscriptions.close`. Only streaming schemes wake a worker, always via close.)
- `projection` — the text and bounded-byte projection capability in {§scheme-projection}. Acquisition schemes own source representations; they do not instantiate or second-guess the reader family. `null` means no readable projection.
- §scheme-interactions `interactions` — `request(ClientInteractionRequest)`
  awaits the contracts-owned interaction and returns its
  `ClientInteractionResolution` ({§client-interaction-wire}). Core binds the
  current operation identity, persistence, client projection, and cancellation;
  the scheme retains no callback, interaction identity, or private lifecycle.
- §scheme-subscriptions `subscriptions` — one streaming lifecycle:

| Surface                           | Lifetime   | Contract                                                                                                   |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `open(pathname, handle)`          | Operation  | Bind durable and live identity, return the exact object, and route cancellation through its signal/handle. |
| Returned `StreamSubscription`     | Retainable | `AbortSignal` plus fused chunk publication and terminal settlement; the only retainable capability.        |
| `subscriptions.notifyChunk/close` | Operation  | Forward to the exact returned object; own no second state or persistence path.                             |

`notifyChunk` appends and emits one stream event. Its optional stateless
`mimetype` retypes the channel only when the stored type differs.
`close(result, summary?, channelResults?)` validates and persists the exact
universal `ChannelProducerResult`, settles every channel with an exact named
result override or that universal default, unregisters the live handle, and
wakes the worker. Channel state is derived from its settled result.
`summary` is presentation only; it never replaces or reconstructs the result.
An override names an existing channel and is itself an exact
`ChannelProducerResult`; invalid overrides fail before any settlement changes.
This permits one multi-channel producer to preserve successful evidence beside
an independently failed representation without inventing another settlement
path or reducing a result to a state label.

There is **no `visibility` capability**: entry-level SHOW/HIDE was removed in the index/visibility teardown — SHOW/HIDE now collapse/expand `log://` rows, a log-side concern with no entry-visibility for a scheme to set.

The consumer passes exactly this public context to every handler. Bundled
adapters that also implement daemon-owned lifecycle behavior receive those
collaborators separately at construction or binding time; consumers must not
decorate `SchemeCtx` with database handles, registries, tokenizers, notifier
callbacks, or other private service state.

§scheme-ctx-lifetime `SchemeCtx` belongs to one operation call. A handler may
use it for the duration of that call, including asynchronous work awaited by
the call, but must not retain the context or any other extracted capability
after the handler returns. A streaming handler may retain only the exact
`StreamSubscription` returned by `subscriptions.open`; its bound methods carry
that subscription's identity without retaining the general context. Other
retained handler-owned resources follow {§handler-lifecycle}.

**Proposals are not a capability.** A side-effecting scheme proposes by *returning* a `ProposalResult` (status 202); the engine owns the resolution lifecycle. On acceptance it calls the handler's optional `applyResolution({ attrs, body }, ctx)` hook. `attrs` is the payload returned by the proposing operation and `body` is the resolver-approved body, when present. The hook returns a `ProposalApplyResult`: a status below 400 completes the accept; a failure preserves the applying scheme's Problem Details as the proposal's final result.

§scheme-edit-proposal-receipt An accepted EDIT proposal may return its final
aggregate `editReceipt` alongside its per-row model-facing `result`. A resolver
replacement must use the reviewer-replaced form from
{§scheme-edit-batch-receipt}. Core consumes that aggregate as transient batch
coordination and COPY/MOVE composition input; it persists only per-row receipts
or ordered resource effects.

## §4 What's NOT in this repo

DB-coupled entry/channel machinery — CRUD + write-time tokenization, the
standard entry operations, channel writes, and subscription registry — lives
in the consumer. This package defines their stable interfaces and pure helpers.
Raw CRUD methods are not a parallel handler protocol. For `data` schemes whose
handlers omit resource-specific storage hooks, engine-owned COPY/MOVE/KILL
orchestration uses the manifest-bound `ctx.entries` implementation.

## §trusted-extension §5 Trusted extension contract

Installed schemes may legitimately own network connections, subprocesses,
caches, pools, or other host resources under {§handler-lifecycle}. These powers
are why installation is a trust decision and why contained interoperability
belongs in MCP rather than an in-process plugin.

The supported compatibility boundary is `@plurnk/plurnk-schemes`. Plugins
should not import private service modules, depend on database layout, or call
prepared statements directly: those are unstable implementation details, not
additional plugin capabilities. Use `SchemeCtx` or propose a new semantic
capability when the public surface cannot express a coherent extension.

## §scheme-discovery §6 Discovery & registration (third-party)

A scheme handler is discovered and registered with **zero first-party involvement** — install it, it lights up. The contract:

- **Declare** the exact string `plurnk.kind: "scheme"` in `package.json` ({§plugin-family-kind}). Then name the scheme(s) it owns in one of two forms: `plurnk.schemes: [{ name, export }, …]` (canonical — one entry per scheme, `export` naming the handler-class export) or `plurnk.name: "<scheme>"` (one-scheme shorthand for the `default` export). One package may own several names inside this family; each name has exactly one owner.
- **`SchemeDiscovery` owns the scan (this package).** `SchemeDiscovery.discover({ cwd? })` walks *all* of `node_modules` — scoped (`@acme/foo`) and unscoped — and returns `{ schemes: {name, packageName, exportName?, attribution?}[], packageAttributions, skipped }` for every package declaring `plurnk.kind === "scheme"`. Scope-agnostic, so a third party under their own scope is found with no first-party allow-list; two names claiming one prefix fail-hard (across packages or within one), as does a malformed `plurnk.schemes` (locality of error, not a silent skip). It returns **descriptors, not handlers** — contract-only, it never imports a scheme package; the consumer imports each `packageName` and registers `new mod[exportName ?? "default"]()`, applying in-tree precedence. The scan primitives — package enumeration, the `PLURNK_PLUGINS_TRUSTED_ONLY` trust gate, the deployment-root `node_modules` walk — are one implementation in `@plurnk/plurnk-meta`, shared by all four family-head scanners; `SchemeDiscovery` adds only the scheme-descriptor shape on top.
- **Attribution is package-authored.** `packageAttributions` carries one canonical validated static tag list per admitted package. `SchemeInfo.attribution` remains the published per-scheme projection when a declaration exists; a loaded handler may additionally implement the shared runtime hook ({§plugin-attribution}). Neither the descriptor nor the consumer owns another policy.
- **The framework stays contract-only.** `@plurnk/plurnk-schemes` does not depend on scheme plugins. The daemon declares its bundled plugins as direct dependencies, and additional plugins are installed at the application root. Plugins declare the framework as a peer dependency using the repository's normal same-minor compatibility range; the framework itself is ignored by discovery because it has no `plurnk.kind`.
- **The default bundle is the daemon's own `dependencies`**, not an aggregator package (the `-all` metapackages are retired). Installing `plurnk-core` surfaces the first-party schemes; any other leaf — first-party or third-party — is added by installing it, and scope-agnostic discovery lights it up identically. No bundle is ever a gate.
- **Trust.** The scanner enforces the shared predicate before attribution or scheme-field validation and returns withheld package names in `skipped`; the host owns presentation ({§plugin-trust-boundary}).
