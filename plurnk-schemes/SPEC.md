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

class Known {
    static manifest: SchemeManifest = {
        name: "known",
        channels: { body: "text/markdown", preview: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        flags: { /* optional SchemeFlagAffinity */ },
    };
}
```

| Field | Constraint |
|---|---|
| `name` | Matches `package.json#plurnk.name`. Addressing/routing identity (the URI prefix). |
| `channels` | `Record<channelName, mimetype>`. Channel names lowercase. Empty = dynamic per-call. |
| `defaultChannel` | Channel targeted when path has no `#fragment`. Dynamic-channel schemes may name it without fixing a mimetype; empty means no default. |
| `category` | `"data"` (entry-bearing) \| `"logging"` (`log://` rows) \| `"control"` (addresses sister workers, owns no entries — e.g. `worker://`). |
| `scope` | `"workspace"` \| `"worker"` (grammar 0.67 `default_scope`; `worker` = per-worker scratch backing `worker://`). |
| `writableBy` | Subset of `["model", "client", "plurnk", "plugin"]`; empty declares an immutable scheme. Consumer returns 403 for outside-set writes. |
| `volatile` | Boolean. |
| `modelVisible` | Boolean. |
| `folderScopes?` | `true` declares that a trailing slash on FIND or READ is a collection scope. Absent/false means `/` is ordinary resource syntax. Matcher bodies and explicit globs remain queries independently. |
| `flags?` | Optional `SchemeFlagAffinity`. |
| `example?` | The scheme's terse **hot-path** one-liner (e.g. `"READ(foo://thing/42)"`) — renders in the live catalogue every turn, so keep it to one canonical usage line. Omit → not advertised. Depth goes in `documentation`. |
| `documentation?` | The **deep doc** (semantics / channels / edge cases). Consumer materializes it as a pull-able `worker://plurnk/docs/<name>.md` entry READ on demand; never hits the hot path. Mirrors `ExecInfo.documentation` (schemes#25). |
| `glyph?` | Display icon (emoji / nerdfont). Omit → consumer renders the `name` (`glyph ?? name`). |
| `foldedByDefault?` | Entries land FOLDED, off the ranked manifest surface (READable via address, not poured into the ranked view). For executor-output streams (`<tag>://`) — containment one level up (schemes#20/service#240). Absent/false → ranked/first-class. |
| `storedScheme?` | Value persisted to `entries.scheme`, which may differ from the addressing `name`. Absent defaults to `name`. It must be a non-null string because every persisted identity component is non-null. |

§manifest-self-doc **Self-doc split (terse pushes, depth pulls).** `example` + `glyph` are the hot-path listing rendered every turn — keep them terse. `documentation` is the deep prose (every op, channel, status code, gotcha); the consumer materializes it as a pull-able **`worker://plurnk/docs/<name>.md`** entry the model READs on demand, off the hot path. Both live on the manifest; the consumer decides what's pushed vs pulled.

**Authoring convention — `docs/<name>.md`.** The contract field stays a plain `string`, but a sibling SHOULD keep the deep doc in a **`docs/<name>.md`** file at the package root rather than inline, and load it into the manifest at module init — e.g. `documentation: await readFile(new URL("../docs/<name>.md", import.meta.url), "utf-8")` (top-level await; `../` resolves identically from `src/` in test and `dist/` once built). Ship it by adding `docs/**/*` to `files`. This keeps prose out of the handler source and gives editors real Markdown; the contract and the consumer's `worker://plurnk/docs/<name>.md` materialization are unchanged. A missing file fails-hard at import (no silent empty doc).

## §2 Interface

Sister scheme handlers implement op methods consumed by plurnk-service via
dispatch. An absent method returns **501**, except FIND on an entry-bearing
`category: "data"` scheme: the consumer supplies its standard stored-entry
FIND automatically. The op-dispatch surface is the exported
**`SchemeHandler`** interface — every method optional, each
`(statement, ctx) => Promise<SchemeResult>`, the per-op statement type from
grammar. `editBatch` returns the typed `EditBatchResult` specialization:

```ts
import type { EditBatchResult, SchemeHandler } from "@plurnk/plurnk-schemes";

export interface SchemeHandler {
    ready?(): Promise<void>;
    close?(): Promise<void>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    work?(statement: WorkStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    fork?(statement: ForkStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    plan?(statement: PlanStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;
}
```

`prepareFind?` is not a second query implementation. It is the optional
discovery/materialization seam invoked before the consumer's standard resource
selection when a data scheme has no custom `find()`. Stored schemes omit it.
FIND and matcher READ both invoke it before selecting entries. Acquisition
schemes use it to make an exact requested resource into an ordinary entry,
then receive the same catalog, matcher evidence, weight, pagination, and status
semantics as every other entry-bearing scheme. The consumer resolves the
standard query through the same canonical entry identity used by
`ctx.entries`: a URL authority remains part of that identity and cannot be
dropped between preparation and lookup. A custom `find()` replaces the whole
operation only where the scheme owns genuinely different candidate semantics.

A sibling does `export default class X implements SchemeHandler` (with `static manifest: SchemeManifest`) and gets compile-time signature checking. Every registered handler exposes either that static manifest or an instance `manifest` for dynamically derived identities; `Manifest.of` validates the complete resolved declaration and its registration name before the handler becomes dispatchable. The interface is the handler-delegable subset of grammar's operation union. `LOOK`/`BUFF` are client-facing operations, while OPEN/FOLD are core-owned log curation; none is dispatchable to a plugin scheme. **The statement + path types (`ReadStatement`, `SendStatement`, `UrlPath`, …) are re-exported from this barrel**, so a sibling depends on and peers (`^1`) ONLY `@plurnk/plurnk-schemes` — grammar rides underneath as the framework's transitive dep (§3).

§handler-lifecycle A registered handler object is a process-lived shared
instance and may receive overlapping operation calls. Retained handler state is
ordinary; handlers must make concurrent access and semantic isolation explicit.

| Concern            | Contract |
| ------------------ | -------- |
| Readiness          | `ready?()` runs after registration and before capability advertisement. It establishes that advertised resources are usable. |
| Hook cardinality   | The consumer invokes each hook once per unique handler object identity, even when multiple registered names share that object. |
| Operation context  | `SchemeCtx` and capabilities extracted from it remain operation-owned under {§scheme-ctx-lifetime}. |
| Retained state     | Tenant- or address-selectable state keys every semantic isolation coordinate. A global pool is valid only when it carries no cross-tenant session state. |
| Live ownership     | An address-selectable live resource has one unambiguous owner. Conflicting acquisition fails explicitly; it never overwrites the existing owner. |
| Shutdown           | After in-flight scheme work drains and before backing stores close, `close?()` releases partially or fully initialized handler resources. The consumer attempts and awaits every unique handler close, then aggregates every failure. |

Handlers without initialization or retained resources omit the corresponding
hook.

The entry CRUD primitives (`readEntry`/`writeEntry`/`deleteEntry`) are not handler operations; schemes use `ctx.entries`. Proposal application is the optional `applyResolution` handler hook described in §3.bis.

OPEN and FOLD are not handler methods. They curate visibility and tags on the
core-owned log; an entry scheme has no visibility state and receives 501.

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

interface EditBatchReceipt {
    readonly revision: string;
    readonly unit: EditReceiptUnit;
    readonly before: number;
    readonly after: number;
    readonly effects: readonly EditEffectReceipt[];
}

interface EditBatchResult extends SchemeResult {
    readonly editReceipt?: EditBatchReceipt | null;
}
```

The engine validates that receipt and owns the ordered COPY/MOVE resource
effects shown to consumers; plugins do not invent a second effect envelope.

## §3 Helpers exported by this repo

### Types

- Manifest/flags: `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
- Mutation receipts: `EditBatchResult`, `EditBatchReceipt`, `EditReceipt`, `EditEffectReceipt`, and `EditReceiptUnit`.
- §scheme-packet-transform **Packet-section transformation.** A scheme may implement `transformSections(sections: PacketSection[]) → PacketSection[] | Promise<…>` to add, remove, or reorder sections before core measures the packet. Core invokes implementations in registration order. The current `PacketSection` shape is `{ name; slot: "system"|"user"; header: string|null; content; tokens }`; #73 tracks its conflation of pre-measure drafts with measured sections.
- Behavior contract: `SchemeHandler` (§2). Scheme-facing grammar types re-exported here so siblings pin only this package: `PlurnkStatement` + the per-op statement types (`ReadStatement`, `FindStatement`, `OpenStatement`, `FoldStatement`, `EditStatement`, `CopyStatement`, `MoveStatement`, `SendStatement`, `ExecStatement`, `WorkStatement`, `ForkStatement`, `KillStatement`, `PlanStatement`) and path types (`ParsedPath` = `LocalPath` | `UrlPath`).
- Target syntax: contracts-owned `PathSyntax` is re-exported for the shared exact-versus-path-glob classifier {§path-glob}.
- Discovery: `SchemeDiscovery` (behavior class) with `SchemeInfo` / `SchemeDiscoveryResult` / `DiscoverOptions` (§6).
- Executor-scheme (RFC schemes#20 - "an executor is a scheme"): `OutputScheme.manifestFromRuntime(decl)` derives a read-only-output `SchemeManifest` from an executor's `RuntimeDecl` (zero scheme-authoring); `DefaultRead.read(content, mimetype, statement, mimetypes)` -> `ReadResolution` is the free text-scope/matcher read over produced output (reuses `Slicer`/`Matcher`). A matcher selects the complete output resource before `<scope>` projects text; without a scope, READ returns the complete resource. Match evidence remains metadata for a model-chosen follow-up READ. `Summarize.summarize(content, mimetype)` -> `OrientIndex` is the structural-only EXEC-receipt index (no content - universal-receipt containment). A per-tag executor-scheme supplies its manifest via instance `get manifest()` (§2 `SchemeHandler.manifest?`).
- Results: `SchemeResult` is the universal operation-result contract. Statuses below 400 carry no `problem`; statuses 400–599 require RFC 9457 `ProblemDetails`, and the legacy `error` member is forbidden. `EntryResult`, `ProposalResult`, and `PassthroughResult` are optional conventional shapes, not engine routing discriminators. Guards inspect those optional shapes; proposal routing itself is engine-owned and follows status plus operation semantics.
- Standard FIND results may carry `omittedItems` and `maximumItems` when a selected catalog is too large to enumerate. `omittedItems` is the exact selected-resource count and `maximumItems` is the active materialization limit. These names cannot collide with the model-facing string `overflow` metadata used for truncated packet bodies.
- Capability ctx (see §3.bis): `SchemeCtx` and its domain capabilities. Entry authors additionally receive `EntryOperationCaps`, semantic `EntryOwner`, and typed standard-operation results. `editBatch` receives every same-turn EDIT for one canonical resource and channel; it validates against one snapshot and commits one revision or none. There is no sequential single-EDIT fallback.

Behavior ships as `export default class` (one class per file, static methods) — the ecosystem class paradigm. Type-only modules, the barrel, and the frozen `DEFAULT_LOOP_FLAGS` constant are the only non-class files.

### §network-address Network address identity

`NetworkAddress.from(target)` is the single non-secret normalization path for
HTTP and WebSocket targets. It returns the exact addressed `scheme`, the
canonical entry `pathname`, a fragmentless and credential-free transport
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

The canonical storage form is
`/<host>[:<port>]<path>[?<query>]`, keyed together with workspace, owner, and
the exact addressed scheme. `NetworkAddress.render(scheme, pathname)` is its
model-facing inverse. Routing aliases select a handler; they do not collapse
resource identity.

### Active-scheme resolution — `SchemeResolver`

- `SchemeResolver.forLoop(handlers: ReadonlyMap<string, object>, flags: LoopFlags): Set<string>` — applies `manifest.flags` affinity to each handler and returns names of schemes active under the loop's flags.

### §mimetype-classifier Mimetype classification — `MimetypeClassifier`

- `MimetypeClassifier.isBinary(mimetype)` — enforces 415 boundary on binary entries. Delegates to `classifyMimetype` from @plurnk/plurnk-mimetypes (the framework owns the text/binary taxonomy — mimetypes#43; the former local allowlists were absorbed upstream verbatim and retired).
- `MimetypeClassifier.isHtml(mimetype)` — recognizes the normalized web-projection family: `text/html` and `application/xhtml+xml`.
- `MimetypeClassifier.isJson(mimetype)` - `application/json` plus `+json` variants, used only by result summarization.
- `MimetypeClassifier.normalizeAutoText(mimetype)` — `text/plain` / null / undefined → `TEXT_PRIMITIVE_MIMETYPE` (`text/markdown`).
- `TEXT_PRIMITIVE_MIMETYPE` — `"text/markdown"` (named export from the same module).

`ProjectionCaps.readable(content, mimetype)` returns the configured
model-facing projection. A returned object is present even when its `content`
is `""`; only `null` denotes absence. Consumers must not infer projection
presence from content length.

### Text-region slicing and replacement - `Slicer`

`Slicer` owns one text algebra for every textual mimetype:

| Scope | Meaning |
|---|---|
| `<N>` | whole physical line `N` |
| `<N,M>` | inclusive whole physical lines `N..M` |
| `<SL,SC,EL,EC>` | exact exclusive-end region using 1-based Unicode code-point columns |
| `<0>` / `<-1>` | mutation anchors before the first / after the final line |

- `Slicer.lines(content, marker)` returns the selected text, source
  `startLine`, and complete resolved `region`; `Slicer.linesRaw` preserves
  original newline separators for COPY/MOVE source transfer.
- `Slicer.textReplacement(content, marker, body)` lowers a line shorthand or
  exact region to one `{start,end,body}` replacement against the source
  snapshot.
- `Slicer.lineMarkerEdit` applies one replacement.
- `Slicer.lineMarkerEditBatch` validates all replacements against one snapshot,
  rejects overlaps, and applies all or none.
- `Slicer.page(items, marker)` is the separate ordered-result pagination
  helper; it accepts only one or two integer positions.

A line/pagination 416 carries `range: { unit, requested: { first, last },
available: { first, last, total } }`. An exact-region 416 carries the four
`requestedCoordinates` and `columnKind: "unicodeCodePoints"`. Empty sources use
`null` line-range endpoints and `total: 0`.

### §path-extension-mimetype Path-extension mimetype — `PathMimetype`

- `PathMimetype.resolve(pathname, defaultMimetype, mimetypes)` — pathname extension → `Mimetypes.detect({ ext })`; falls back to `defaultMimetype` when no extension. text/plain auto-normalizes to text/markdown.

### Result families — `Results`

- `Results.isEntry` / `Results.isProposal` / `Results.isPassthrough` — guards for the optional conventional result shapes.
- `Results.isErrorStatus(status)` — `status >= 400`.
- `Results.problem(owner, code, status, detail, extensions?)` — build and validate RFC 9457 Problem Details with a stable `https://problems.plurnk.dev/<owner>/<code>` type.
- `Results.failure(owner, code, status, detail, fields?, extensions?)` — build and validate a failed operation result.
- `Results.assert(result)` — validate the complete success/failure discrimination and reject malformed plugin output.
- `Results.assertMatchEvidence(evidence)` / `assertMatchEvidenceList(evidence)` - enforce the exact `{ path?, region? }` shape and shared `TextRegion` contract.
- `Results.assertReadResult(result)` - validate the universal operation result plus any `region` and `matches` it exposes.
- `Results.attachInstance(result, uri)` — attach the durable occurrence URI to a failed result.

A handler owns its failure classification and explanation. The daemon owns the
durable `instance`, because only it knows the committed log coordinate. A
malformed handler result is a plugin contract violation and fails hard; the
consumer does not invent a fallback error or reinterpret arbitrary fields.
The same discrimination applies to every `SchemeCtx` capability result:
entries, channels, and tags never return a bare failure status.

### Matcher dispatch - `Matcher` {§matcher-dispatch}

- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes)` is the body-matcher adapter over `Mimetypes.query` (glob/regex/jsonpath/xpath).
- A match returns status 200 and `matches: MatchEvidence[]`.
  `MatchEvidence` is `{path?, region?}`. `path` preserves a structural locator;
  `region` is a complete four-coordinate `TextRegion` only when the finding has
  an honest exact or nearest-enclosing mapping into the text the model can READ.
  Each item must contain at least one of `path` or `region`; other fields violate
  the shared evidence contract.
- The matcher is a boolean resource selector. It does not replace content with matched values or choose a retrieval window. `DefaultRead` returns the complete selected resource unless the authored READ supplies `<L>`.
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

- `entries` — direct storage over the scheme's own namespace
  (`read`/`write`/`delete`) plus `operations`, the standard PLURNK
  `READ`/`EDIT`/`FIND`/`SEND` implementation for entry-bearing schemes.
  Standard operations are bound to the handler's manifest. Their optional
  owner is semantic: `"commons"` (default) or the current `"worker"`; database
  owner IDs are not part of the plugin contract. A handler may implement its
  own op method instead. In particular, a handler with `find()` owns FIND and
  fan-out; one without it receives the standard stored-entry behavior.
- `channels` — content writes + state (`append`/`replace`/`setState`).
- `tags` — entry tags (`add`/`remove`/`list`).
- `notify` — between-turn client signal (`streamEvent`, metadata-only); not model-facing. (No `wakeWorker`: the worker wake carries subscription-close context that only exists at stream completion, so it lives on `subscriptions.close`. Only streaming schemes wake a worker, always via close.)
- `projection` — `readable(content, mimetype)` asks the consumer's configured mimetype family for the model-facing text projection. Acquisition schemes own bytes/DOM; they do not instantiate or second-guess the reader family. `null` means no readable projection.
- `subscriptions` — streaming lifecycle: `open(pathname, handle)` atomically binds durable subscription identity to the consumer's process-local live-handle registry, returns a worker+teardown-composed `AbortSignal`, and takes a force-cancel `SubscriptionHandle`; routed cancellation both invokes the handle and aborts that signal. `notifyChunk(channel, chunk, mimetype?)` is **fused** (append + stream/event in one call), with an optional per-call `mimetype` that retypes the channel to the content's actual type (passed statelessly per chunk; the impl writes only on change; the manifest channel mimetype is the pre-fetch seed default — plurnk-service#226). `close(result, summary?)` validates and persists the exact universal `SchemeResult`, composites channel state, unregisters the live handle, and wakes the worker. `summary` is presentation only; it never replaces or reconstructs the result. Designed against Exec (two-channel, cancel-tested).

There is **no `visibility` capability**: entry-level SHOW/HIDE was removed in plurnk-service's index/visibility teardown — SHOW/HIDE now collapse/expand `log://` rows, a log-side concern with no entry-visibility for a scheme to set (plurnk-service#180).

The consumer passes exactly this public context to every handler. Bundled
adapters that also implement daemon-owned lifecycle behavior receive those
collaborators separately at construction or binding time; consumers must not
decorate `SchemeCtx` with database handles, registries, tokenizers, notifier
callbacks, or other private service state.

§scheme-ctx-lifetime `SchemeCtx` belongs to one operation call. A handler may
use it for the duration of that call, including asynchronous work awaited by
the call, but must not retain the context after the handler returns. Retained
handler-owned resources follow {§handler-lifecycle}; they are not retained
contexts.

**Proposals are not a capability.** A side-effecting scheme proposes by *returning* a `ProposalResult` (status 202); the engine owns the resolution lifecycle. On acceptance it calls the handler's optional `applyResolution({ attrs, body }, ctx)` hook. `attrs` is the payload returned by the proposing operation and `body` is the resolver-approved body, when present. The hook returns a `SchemeResult`: a status below 400 completes the accept; a failure preserves the applying scheme's Problem Details as the proposal's final result.

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

## §6 Discovery & registration (third-party)

A scheme handler is discovered and registered with **zero first-party involvement** — install it, it lights up. The contract:

- **Declare** the exact string `plurnk.kind: "scheme"` in `package.json` ({§plugin-family-kind}). Then name the scheme(s) it owns in one of two forms: `plurnk.schemes: [{ name, export }, …]` (canonical — one entry per scheme, `export` naming the handler-class export) or `plurnk.name: "<scheme>"` (one-scheme shorthand for the `default` export). One package may own several names inside this family; each name has exactly one owner.
- **`SchemeDiscovery` owns the scan (this package).** `SchemeDiscovery.discover({ cwd? })` walks *all* of `node_modules` — scoped (`@acme/foo`) and unscoped — and returns `{ schemes: {name, packageName, exportName?, attribution?}[], skipped }` for every package declaring `plurnk.kind === "scheme"`. Scope-agnostic, so a third party under their own scope is found with no first-party allow-list (plurnk-service#227); two names claiming one prefix fail-hard (across packages or within one), as does a malformed `plurnk.schemes` (locality of error, not a silent skip). It returns **descriptors, not handlers** — contract-only, it never imports a scheme package; the consumer imports each `packageName` and registers `new mod[exportName ?? "default"]()`, applying in-tree precedence. The scan primitives — package enumeration, the `PLURNK_PLUGINS_TRUSTED_ONLY` trust gate, the deployment-root `node_modules` walk — are one implementation in `@plurnk/plurnk-meta`, shared by all four family-head scanners; `SchemeDiscovery` adds only the scheme-descriptor shape on top.
- **`attribution` rides the descriptor verbatim.** A package may declare `plurnk.attribution` (a credit string, or an array of them); the scan passes it through untouched as `SchemeInfo.attribution` (`string | string[] | undefined`) — anything that isn't a string or string-array is dropped. The framework neither validates nor normalizes it: the `@plurnk`-tags-only-from-`@plurnk`-packages reservation policy is the **consumer's** to enforce on the surfaced credit (plurnk-service#26).
- **The framework stays contract-only.** `@plurnk/plurnk-schemes` does not depend on scheme plugins. The daemon declares its bundled plugins as direct dependencies, and additional plugins are installed at the application root. Plugins declare the framework as a peer dependency using the repository's normal same-minor compatibility range; the framework itself is ignored by discovery because it has no `plurnk.kind`.
- **The default bundle is the daemon's own `dependencies`**, not an aggregator package (the `-all` metapackages are retired). Installing `plurnk-core` surfaces the first-party schemes; any other leaf — first-party or third-party — is added by installing it, and scope-agnostic discovery lights it up identically. No bundle is ever a gate.
- **Trust.** The scanner enforces the shared predicate before import and returns withheld package names in `skipped`; the host owns presentation ({§plugin-trust-boundary}).
