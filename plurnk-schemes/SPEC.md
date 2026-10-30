# `@plurnk/plurnk-schemes` Specification

Contract for `@plurnk/plurnk-schemes-*` sibling packages, entry/channel handler dispatch, text/window slicing, and third-party scheme discovery.

## §manifest Scheme manifest

Every scheme package declares `plurnk: { "kind": "scheme", "name": "<scheme>" }` (or `plurnk.schemes: [{ name, export }]`) in `package.json` and exposes a static or instance `manifest: SchemeManifest` validated by `Manifest.of`:

| Field | Constraint |
|---|---|
| `name` | Matches `package.json#plurnk.name` (the addressing/routing URI prefix). |
| `authority?` | `"namespace"` (default — folds authored authority into pathname) or `"resource"` (preserves it as the entry authority). |
| `channels` | `Record<channelName, mimetype>` for declared channel types. Channel names are lowercase; an untyped default may coexist with typed siblings. |
| `defaultChannel` | Lowercase channel targeted when a path has no `#fragment`. Omission from `channels` means its type is determined per resource; empty string means no default. |
| `category` | `"data"` (entry-bearing), `"logging"` (`log://` rows), or `"control"` (owns no entries). |
| `writableBy` | Subset of `["model", "client", "_plurnk"]`; empty declares a scheme no operation writes (such as runtime output). Consumer returns `403` for outside-set writes. |
| `volatile` | Boolean. |
| `modelVisible` | Boolean. |
| `folderScopes?` | `true` declares that a trailing slash on `FIND` is a collection scope; absent/`false` treats `/` as ordinary resource syntax. |
| `lineAnchors?` | `true` publishes and accepts shared line anchors for stable textual representations without declaring `EDIT` support. |
| `textEditScopes?` | `true` declares the shared textual `EDIT` coordinate and collision contract (`{§line-anchors}`). Handlers receive numeric coordinates only and route standard entry mutation through `ctx.entries.operations.editBatch`. |
| `metadataModifier?` | `true` opts into `[metadata]` on resource operations (`{§slot-order}`). Absent/`false` rejects `[metadata]` at dispatch with non-retryable `400 scheme-metadata-unsupported`. |
| `traits?` | Unique lowercase capability facts matching `^[a-z][a-z0-9-]*$` (e.g. `web`, `interaction`) consumed by `{§capability-admission}`. |
| `documentation?` | Deep reference Markdown (loaded from `docs/<name>.md`) with an exact H2 `Summary`, materialized on demand at `plurnk:///<name>.md` (`FIND` projects H2 `Summary`; `READ` retrieves the body). |
| `glyph?` | Non-empty opaque client presentation glyph projected through `{§mcp-server-definition}`; never enters model teaching. |
| `storedScheme?` | Non-null string persisted to `entries.scheme` when different from `name` (defaults to `name`). |

- The manifest is closed: unknown top-level fields fail admission.
- **Reserved service metadata keys:** `MetadataOptions.SERVICE_KEYS` (`["lifetime"]`) are stripped from every owner's `options` and surfaced raw beside `options` so no scheme or executor interprets or refuses `lifetime` (`{§exec-lifetime}`).

## §scheme-operation-dispatch Handler interface and operation dispatch

```ts
export interface SchemeHandler {
    ready?(): Promise<void>;
    close?(): Promise<void>;
    resolveEntryAddress?(target: ParsedPath, ctx: SchemeAddressCtx, access?: "read" | "write"): Promise<EntryAddress | SchemeResult | null>;
    prepareRepresentation?(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;
}
```

| Seam / helper | Contract |
|---|---|
| Operation dispatch | Core owns `READ` for every `category: "data"` scheme and exact-resource `FIND` over its canonical representation; unimplemented optional methods return `501`. Log-targeted `KILL`, `WORK`, `FORK`, and native dispositions (`NOTE`, `WAIT`) are core-owned and never dispatch to scheme handlers. |
| `prepareRepresentation?(request, ctx)` | Operation-neutral acquisition seam for one exact resource (`{ target, metadata, authority, pathname }`, with no scope, matcher, or channel fragment). Writes canonical channels via `ctx.entries` and returns `200`, `102` while a live `StreamSubscription` remains active (`{§exec-stream}`), or an exact terminal result. Shared by exact `READ`, exact `FIND`, and exact `COPY`/`MOVE` sources. |
| `prepareFind?(statement, ctx)` | Broad-scope discovery seam invoked before standard entry selection when no custom `find()` is implemented. |
| `ResourceNames` | Allocates one URI-encoded component per published resource: preserves supplied names, generates 8-hex characters when unnamed, and appends an 8-hex hash suffix on collision without overwriting siblings. |
| `ByteSource` (`FileByteSource`, `GeneratedByteSource`) | Supplies `size()` (byte count or `null` when absent), 1-based inclusive `read(first, last)`, and optional `nativePath()` (original regular file path or `null`, never creating a copy). Binary channels preserve exact bytes; textual channels require valid UTF-8. |
| `webMaterializer` | Optional handler capability (`{ fetch, materialize, materializedChannels }` returning `WebFetchResult`, `WebMaterializedResult`, or `WebMaterializationError`) published by `https` and resolved through the scheme registry without hardcoding an extension package name. |

`resolveEntryAddress?(target, ctx, access)` receives capability-free `SchemeAddressCtx` and `access` (`"read"` default, or `"write"`). Core strips `#fragment` and `{§path-syntax}` target parentheses before invocation:

| Return | Meaning |
|---|---|
| Hook absent | Use the standard coordinate from `{§manifest}` `authority`. |
| `{ authority, pathname }` | Bind this exact resource in the operation's workspace. |
| Non-success `SchemeResult` | Preserve the expected address or mutability refusal exactly. |
| `null` | No resource at this selector. |

Handler lifecycle invariants for process-lived `SchemeHandler` instances:

| Concern | Contract |
|---|---|
| Readiness (`ready?`) | Runs after registration and before capability advertisement; establishes that advertised resources are usable. |
| Hook cardinality | Invoked once per unique handler object identity, even when multiple registered names share that object. |
| Operation context | `SchemeCtx` and capabilities extracted from it are operation-owned; only `StreamSubscription` from `subscriptions.open` is retainable. |
| Retained state & live ownership | Tenant- or address-selectable state keys every isolation coordinate; conflicting live acquisition fails explicitly without overwriting the existing owner. |
| Shutdown (`close?`) | Runs after in-flight scheme work drains and before backing stores close; the consumer awaits every unique handler close and aggregates failures. |

Regional mutation receipts (`ResolvedEditStatement`, `EditBatchResult`): Core resolves `{§matcher-prefix-claims}` line anchors and `{§zero-width-column-one-insert}` bodies before calling `editBatch`, so `ResolvedEditStatement.lineMarker` contains numbers only. Regional `editBatch` returns `EditBatchResult` carrying `EditBatchReceipt` (`revision`, `unit: "lines" | "codePoints"`, `before`, `after`, optional advisory `parseIssues: { before, after }`, `{§op-shapes}`):

| Batch outcome | Authored correlation | Landed effects |
|---|---|---|
| Applied as proposed (`AppliedEditBatchReceipt`) | `effects[N]` describes authored `EDIT` `N` (`requested`, `source`, `result`, `removed`, `inserted`, source-numbered `context`) | One truthful effect per authored `EDIT` |
| Resolver replaced proposed body (`ReviewerReplacementEditBatchReceipt`) | `disposition: "reviewer-replaced"`; `superseded[N]` retains authored marker `N` | One `replacement` effect describes the bytes that actually landed |

## §network-address Network address and media helpers

`NetworkAddress.from(target)` normalizes `http`, `https`, `ws`, and `wss` targets into `{ scheme, authority, pathname, url, hasCredentials }`, and `NetworkAddress.render({ scheme, authority, pathname })` reconstructs the model-facing address with `{§path-syntax}` target escaping:

| Component | Entry identity (`authority` / `pathname`) | Transport `url` | Plurnk channel |
|---|---|---|---|
| Scheme (`http`, `https`, `ws`, `wss`) | Exact addressed scheme | Yes | No |
| Host & non-default port | `<host>[:<port>]` in `authority` (WHATWG canonical host) | Yes | No |
| Path (`%28`/`%29` $\to$ `(` / `)`) & query | `<path>[?<query>]` in `pathname` (preserving order, duplicates, and empty `?`) | Yes | No |
| `#fragment` | No | No | Yes |
| Userinfo | Rejected (`hasCredentials: true`) | No | No |

Additional framework helpers:

- **`MimetypeClassifier` & `PathMimetype`:** `isBinary(mimetype)` (delegates to `@plurnk/plurnk-mimetypes`), `isHtml(mimetype)` (`text/html`, `application/xhtml+xml`), `isJson(mimetype)` (`application/json` and `+json`, excluding NDJSON), `normalizeAutoText(mimetype)` (`text/plain` / `null` / `undefined` $\to$ `TEXT_PRIMITIVE_MIMETYPE` `"text/markdown"`), and `isTransferCompatible(source, destination, sourceClassification?)` (permits verbatim `COPY`/`MOVE` between equal mimetypes or from any textual source into `text/plain` or `text/markdown`, `{§mimetype-content}`). `PathMimetype.resolve(pathname, defaultMimetype, mimetypes)` detects by extension and auto-normalizes `text/plain` to `text/markdown`.
- **Packet transformation (`PacketSections`):** A scheme implementing `transformSections(sections: PacketSectionDraft[])` may add, remove, or reorder `{ name, slot: "system" | "user" | "assistant", header: string | null, content }` drafts before core token measurement (`{§packet-assembly}`), validated before and after by `PacketSections.assertDrafts` (unique non-empty names).
- **Executor output schemes (`OutputScheme`, `Summarize`):** `OutputScheme.manifestFromRuntime(decl)` derives a read-only volatile data `SchemeManifest` from an executor `RuntimeDecl` (preserving `glyph` and `traits`); `Summarize.summarize(content, mimetype) -> OrientIndex` produces structural-only receipt indices.
- **Resource capture (`ctx.resources.capture`, `MessageAttachments`):** Acquires ordered snapshots (`{ name, mediaType, contentHash, target, bytes }`) without performing `SEND` or transferring ownership (`{§op-methods-op-dispatch}`).

`ctx.projection` delegates model-facing projection to the configured mimetype framework (`ProjectionInputLimitError` exports its bounded-input failure):

| Surface | Contract |
|---|---|
| `readable(content, mimetype)` | Project an acquired Unicode representation (`""` is present; only `null` denotes absence). |
| `binary(chunks, mimetype)` | Return bounded source `bytes`, nullable `readable: ProjectedText`, and `projectionIdentity`, consuming one async byte source under `{§mimetype-binary-input}`. |
| `identity(mimetype)` | Return opaque identity of configured projection behavior for cache and materialization freshness. |
| `isBinary(mimetype)` | Classify through the configured registry so installed handler declarations remain authoritative. |
| `parseIssues(content, mimetype)` | Return nonnegative parser-recovery count, or `undefined` when unavailable (`{§mimetype-channel-selection}`). |
| `ProjectedText` | Derived Unicode plus output mimetype, source mimetype, and opaque projection identity. |

## §slicer-text-algebra Text, window, and pagination slicing

`Slicer` owns one coordinate algebra across textual lines, code-point regions, positional byte windows (`Slicer.window`), and ordered result pagination (`Slicer.page`):

| Scope | Meaning |
|---|---|
| `<N>` | Whole 1-based physical line, byte (`unit: "byte"`), or result item `N` |
| `<N,M>` | Inclusive 1-based range `N..M` (`M = -1` selects through the end) |
| `<SL,SC,EL,EC>` | Exact exclusive-end text region using 1-based Unicode code-point columns (`{§text-region}`) |
| `<0>` / `<-1>` | Single-position mutation anchors before the first / after the final line (`start: null` on `window()`) |

- **One-based ranges (`range-starts-at-one`):** A two-coordinate range starts at `1`. `<0,M>` is refused `416 range-not-satisfiable` by `lines()`, `linesRaw()`, `textReplacement()`, `lineMarkerEdit[Batch]()`, `window()`, and `page()` (even on empty content/results) and never clamped to `<1,M>`. As a shared `READ` projection tolerance, `<0,M>` (for positive safe integer `M` or `-1`) selects `<1,M>`, retains `[0,M]` as requested, and emits scope-normalization evidence.
- **3-coordinate lowering and end clamping:** `<startLine,startColumn,endLine>` lowers to `<startLine,startColumn,endLine,endCol>` with boundary-validated normalization evidence. Harmless end-bound overshoots clamp to EOF / final code point; start-bound overshoots and inverted ranges fail `416`.
- **`Slicer.wholeLineBody(content, marker, body)`:** Appends the content's line separator only for a non-empty body without a trailing newline at a zero-width column-1 region (`{§zero-width-column-one-insert}`).
- **Batch edits (`lineMarkerEditBatch`):** Validates all replacements against one snapshot; resolves identical twins, co-located insertions, and evidenced 1-line shared endpoints (recorded in `merges`); rejects any other overlap with `409 overlapping-edits` (`conflicts`, `cleanRegions`, `conflictingRegions`, `editCount`, `applied: 0`) and applies all or none.
- **Results and Matcher (`Results`, `Matcher`):** `Results.isErrorStatus(status)` is `status >= 400`; `Results.isEntry`, `isProposal`, and `isPassthrough` guard optional result shapes; `Results.assert`, `assertReadResult`, and `assertMatchEvidenceList` enforce RFC 9457 `ProblemDetails` on `400..599` and `{ locator?, region?, enclosingRegion?, matched? }` on matches. `Matcher.matchAgainstContent(body, content, mimetype, mimetypes, diagnostic?)` adapts `Mimetypes.query` (`200` matches, `204` empty, `400 invalid-expression` with bounded `diagnostic`, `415 unsupported-dialect`, `203` raw-text fallback with `reason`, `{§matcher-dispatch}`).

| Problem code | Status | Contract & pinned wording |
|---|---:|---|
| `range-not-satisfiable` | `416` | Range lies outside available extent (`Lines and columns count from 1.`, `An exact region names its earlier position first: <SL,SC,EL,EC>.`, `-1 is the only position counted from the end; lines run 1..N.`, `Choose positions within 1..N.`, or ``Range <0,end> starts at 0, which is not a line; lines are numbered from 1 and 0 is only the `<0>` prepend position. Recovery: `<L,M>` selects lines L through M; `<0>` prepends and `<-1>` appends without replacing anything.`` / `Range <0,end> starts at 0; <unit> positions are numbered from 1.`). Unsupported scope arity: `A scope requires one position or an inclusive two-position range.` |
| `overlapping-edits` | `409` | Two `EDIT` regions overlap, or a whole-resource replacement coexists with another `EDIT`. `Recovery: Submit the whole-resource replacement by itself.` |
| `invalid-expression` | `400` | `The <dialect> matcher expression is invalid. Recovery: Revise the matcher expression.` |
| `unsupported-dialect` | `415` | `The <dialect> matcher is not supported for <mimetype>. Recovery: Use a matcher supported by the resource mimetype.` |
| `metadata-invalid` | `400` | `[metadata] must be a JSON array.` or `[metadata] must be a JSON array of option objects; every element is an object.` |
| `metadata-unsupported` | `400` | `Message metadata accepts only attachments.` |
| `attachments-invalid` | `400` | `attachments must be an array of non-empty resource addresses.` |

## §capability-ctx Capability context and subscriptions

`SchemeCtx` is the operation-scoped capability surface (`{ workspaceId, sessionId, loopId, turnId, writer, signal, logEntryId? }`, `{§execution-output-identity}`) injected by the consumer:

| Capability | Contract |
|---|---|
| `entries` & `channels` | Direct storage (`address`, `read`, `write`, `delete`, optional scheme-private `attributes`) and standard `operations` (`editBatch`, `find`, `send`), plus `channels` (`append`, `replace`, `setState`), bound by Core to the resolved workspace coordinate (`{§scheme-surface}`). |
| `notify`, `projection`, `resources`, `messages` | `notify.streamEvent` (between-turn client metadata signal), `projection`, `resources.capture`, and `messages`. |
| `interactions` | `request(ClientInteractionRequest, signal?) -> Promise<ClientInteractionResolution>` (`{§provider-request-accounting}`). |
| `subscriptions` | `open(pathname, handle)` returns the sole capability retainable after the handler call returns: `StreamSubscription` (`AbortSignal` + `notifyChunk(channel, chunk, mimetype?)` + `close(result, summary?, channelResults?)` that validates `ChannelProducerResult` overrides, settles channel states, unregisters the live handle, and wakes the session). |
| Proposals (`applyResolution`) | A side-effecting scheme proposes by returning `status: 202`; on acceptance, Core calls `applyResolution({ attrs, metadata, body }, ctx)` (`{§log-wire-format}`). Accepted `EDIT` proposals may return an aggregate `editReceipt` (using `reviewer-replaced` when the resolver replaced the body). |

## §resource-tree-scheme Module slice and resource trees

| Type / concern | Contract |
|---|---|
| `SchemeRegistrationSeam` | `registerScheme(name, handler)` registers a process-wide `SchemeHandler` (`{§module-seam-slices}`). |
| `RuntimeSchemeFacet` | Claims a path subtree under an executor or Functionality scheme (`{§executor-role}`, `{§functionality-adapter}`) with its own `manifest` (`authority`, `channels`, `defaultChannel`, `writableBy`) and live `prepareRepresentation`, `prepareFind`, `find`, `editBatch`, `send`, and `kill` hooks while unclaimed coordinates keep standard executor-output behavior. |
| `ResourceTreeRegistrationSeam` | `registerResourceTreeScheme(name, source)` exposes read-only `ResourceTreeSource.trees(workspaceId)` keyed by URI authority (`name://authority/path`, resource authority, folder scopes, dynamic MIME `body` channel). |
| Tree publication & projection | Demand-loaded entries on `READ` and `COPY`; model/client writes are forbidden (`403`). The host detects MIME, applies the input bound, and runs the installed MIME projection while keeping original `ByteSource` bytes for byte views, transfers, and attachments. |
| Tree `FIND`, withdrawal & failures | `FIND` refreshes resources in the requested authority/path scope and evicts withdrawn authorities or absent paths (an exact missing `READ` never returns cached content). Optional `refusal(cause, address)` translates recognized source errors into failure results (`status >= 400`). |

## §scheme-discovery Third-party discovery

`SchemeDiscovery.discover({ cwd? })` scans `node_modules` via `@plurnk/plurnk-meta` (`{§extension-discovery}`, `{§extension-discovery}`, `{§extension-discovery}`) for packages declaring `plurnk.kind === "scheme"` (`plurnk.schemes: [{ name, export }]` or `plurnk.name`), failing hard on duplicate scheme prefixes or malformed declarations and returning `{ schemes, packageAttributions, skipped }` descriptors without importing handler modules.

## §message-source-scheme Message sources

Protocol modules register `MessageScheme` or compose its hooks so `SchemeCtx.messages` materializes retained inbound messages for `READ`, `FIND`, and `COPY` and routes exact-address `SEND` replies under `{§message-completion}`. Any `EDIT`, `COPY`/`MOVE` onto, or `KILL` of a message address is refused `405 message-immutable` with no `recovery` (`{§diagnostic-observation}`): `` `<address>` is a received message; it cannot be edited, moved or killed. ``
