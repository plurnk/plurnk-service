# plurnk-schemes — Specification

Contract for `@plurnk/plurnk-schemes-*` sibling packages. Audience: implementer of a URI scheme handler. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §3).

## §1 Manifest {§manifest}

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
| `category` | `"data"` (entry-bearing) \| `"logging"` (`log://` rows) \| `"control"` (addresses sister processes/runs, owns no entries — e.g. `worker://`). |
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

**Self-doc split (terse pushes, depth pulls).** {§manifest-self-doc} `example` + `glyph` are the hot-path listing rendered every turn — keep them terse. `documentation` is the deep prose (every op, channel, status code, gotcha); the consumer materializes it as a pull-able **`worker://plurnk/docs/<name>.md`** entry the model READs on demand, off the hot path. Both live on the manifest; the consumer decides what's pushed vs pulled.

**Authoring convention — `docs/<name>.md`.** The contract field stays a plain `string`, but a sibling SHOULD keep the deep doc in a **`docs/<name>.md`** file at the package root rather than inline, and load it into the manifest at module init — e.g. `documentation: await readFile(new URL("../docs/<name>.md", import.meta.url), "utf-8")` (top-level await; `../` resolves identically from `src/` in test and `dist/` once built). Ship it by adding `docs/**/*` to `files`. This keeps prose out of the handler source and gives editors real Markdown; the contract and the consumer's `worker://plurnk/docs/<name>.md` materialization are unchanged. A missing file fails-hard at import (no silent empty doc).

## §2 Interface

Sister scheme handlers implement op methods consumed by plurnk-service via
dispatch. An absent method returns **501**, except FIND on an entry-bearing
`category: "data"` scheme: the consumer supplies its standard stored-entry
FIND automatically. The op-dispatch surface is the exported
**`SchemeHandler`** interface — every method optional, each
`(statement, ctx) => Promise<SchemeResult>`, the per-op statement type from
grammar:

```ts
import type { SchemeHandler } from "@plurnk/plurnk-schemes";

export interface SchemeHandler {
    close?(): Promise<void>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    open?(statement: OpenStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    fold?(statement: FoldStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<SchemeResult>;
    copy?(statement: CopyStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    move?(statement: MoveStatement, ctx: SchemeCtx): Promise<SchemeResult>;
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
discovery/materialization seam invoked before the consumer's standard FIND
when a data scheme has no custom `find()`. Stored schemes omit it. Acquisition
schemes use it to make an exact requested resource into an ordinary entry,
then receive the same catalog, matcher, span, weight, pagination, and status
semantics as every other entry-bearing scheme. The consumer resolves the
standard query through the same canonical entry identity used by
`ctx.entries`: a URL authority remains part of that identity and cannot be
dropped between preparation and lookup. A custom `find()` replaces the whole
operation only where the scheme owns genuinely different candidate semantics.

A sibling does `export default class X implements SchemeHandler` (with `static manifest: SchemeManifest`) and gets compile-time signature checking. Every registered handler exposes either that static manifest or an instance `manifest` for dynamically derived identities; `Manifest.of` validates the complete resolved declaration and its registration name before the handler becomes dispatchable. The op set is exactly grammar's `PlurnkStatement` dispatch union and moves with the framework's grammar bump (0.74.57 added `work?`/`fork?`; `LOOK`/`BUFF` are grammar `ClientStatement` ops, client-facing and never dispatched to a scheme, so they're intentionally absent here). **The statement + path types (`ReadStatement`, `SendStatement`, `UrlPath`, …) are re-exported from this barrel**, so a sibling depends on and peers (`^1`) ONLY `@plurnk/plurnk-schemes` — grammar rides underneath as the framework's transitive dep (§3).

`close?()` is the process-lifecycle hook for pooled resources such as browser processes, sockets, and client connections. The consumer calls it once per unique handler instance after in-flight scheme work drains and before backing stores close. Stateless handlers omit it.

The entry CRUD primitives (`readEntry`/`writeEntry`/`deleteEntry`) are not handler operations; schemes use `ctx.entries`. Proposal application is the optional `applyResolution` handler hook described in §3.bis.

## §3 Helpers exported by this repo

### Types

- Manifest/flags: `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
- Optional `PacketSectionTransformer` — a scheme MAY implement `transformSections(sections: PacketSection[]) → PacketSection[] | Promise<…>` to reshape the packet's section list (add/remove/reorder) before the engine measures it; called duck-typed in registration order. `PacketSection` = `{ name; slot: "system"|"user"; header: string|null; content; tokens }`. Contract declares the shape; service conforms (the in-process plugin-packet-control / fork-avoidance seam — schemes#24).
- Behavior contract: `SchemeHandler` (§2). Scheme-facing grammar types re-exported here so siblings pin only this package: `PlurnkStatement` + the per-op statement types (`ReadStatement`, `FindStatement`, `OpenStatement`, `FoldStatement`, `EditStatement`, `CopyStatement`, `MoveStatement`, `SendStatement`, `ExecStatement`, `WorkStatement`, `ForkStatement`, `KillStatement`, `PlanStatement`) and path types (`ParsedPath` = `LocalPath` | `UrlPath`).
- Discovery: `SchemeDiscovery` (behavior class) with `SchemeInfo` / `SchemeDiscoveryResult` / `DiscoverOptions` (§6).
- Executor-scheme (RFC schemes#20 — "an executor is a scheme"): `OutputScheme.manifestFromRuntime(decl)` derives a read-only-output `SchemeManifest` from an executor's `RuntimeDecl` (zero scheme-authoring); `DefaultRead.read(content, mimetype, statement, mimetypes)` → `ReadResolution` is the free `<L>`/matcher read over produced output (reuses `Slicer`/`Matcher`); `Summarize.summarize(content, mimetype)` → `OrientIndex` is the structural-only EXEC-receipt index (no content — universal-receipt containment). A per-tag executor-scheme supplies its manifest via instance `get manifest()` (§2 `SchemeHandler.manifest?`).
- Results: `SchemeResult` is the universal operation-result contract. Statuses below 400 carry no `problem`; statuses 400–599 require RFC 9457 `ProblemDetails`, and the legacy `error` member is forbidden. `EntryResult`, `ProposalResult`, and `PassthroughResult` are optional conventional shapes, not engine routing discriminators. Guards inspect those optional shapes; proposal routing itself is engine-owned and follows status plus operation semantics.
- Capability ctx (see §3.bis): `SchemeCtx` and its domain capabilities. Entry authors additionally receive `EntryOperationCaps`, semantic `EntryOwner`, and typed standard-operation results. `editBatch` receives every same-turn EDIT for one canonical resource and channel; it validates against one snapshot and commits one revision or none. There is no sequential single-EDIT fallback.

Behavior ships as `export default class` (one class per file, static methods) — the ecosystem class paradigm. Type-only modules, the barrel, and the frozen `DEFAULT_LOOP_FLAGS` constant are the only non-class files.

### Active-scheme resolution — `SchemeResolver`

- `SchemeResolver.forLoop(handlers: ReadonlyMap<string, object>, flags: LoopFlags): Set<string>` — applies `manifest.flags` affinity to each handler and returns names of schemes active under the loop's flags.

### Mimetype classification — `MimetypeClassifier` {§mimetype-classifier}

- `MimetypeClassifier.isBinary(mimetype)` — enforces 415 boundary on binary entries. Delegates to `classifyMimetype` from @plurnk/plurnk-mimetypes (the framework owns the text/binary taxonomy — mimetypes#43; the former local allowlists were absorbed upstream verbatim and retired).
- `MimetypeClassifier.isJson(mimetype)` — `application/json` plus `+json` variants. Used by `<L>` dispatch. Scheme semantics — stays local, not delegated.
- `MimetypeClassifier.isLineNavigable(mimetype)` — render-layer decides whether to prefix lines with `N:\t`. Delegates to `classifyMimetype`.
- `MimetypeClassifier.normalizeAutoText(mimetype)` — `text/plain` / null / undefined → `TEXT_PRIMITIVE_MIMETYPE` (`text/markdown`).
- `TEXT_PRIMITIVE_MIMETYPE` — `"text/markdown"` (named export from the same module).

### `<L>` slicing — `Slicer`

- `Slicer.lines(content, marker)` — line-navigable slice. Returns `{ status, text?, startLine?, error?, range? }`.
- `Slicer.linesRaw(content, marker)` — same shape; no `N:\t` prefix.
- `Slicer.jsonItems(content, marker)` — JSON-source item slice. Returns `{ status, body?, error?, range? }`.
- `Slicer.page(items, marker)` — ordered result pagination under the same positional rules. Returns `{ status, items?, error?, range? }`.
- `Slicer.lineMarkerEdit(content, marker, body)` — line-navigable EDIT.
- `Slicer.jsonItemEdit(content, marker, body)` — structural JSON EDIT.

Every 416 carries `range: { unit, requested: { first, last }, available:
{ first, last, total } }`. Empty sources use `null` available endpoints and
`total: 0`. A consumer puts this object in the RFC 9457 Problem extensions so
the caller can recover from the actual extent without parsing prose.

### Path-extension mimetype — `PathMimetype`

- `PathMimetype.resolve(pathname, defaultMimetype, mimetypes)` — pathname extension → `Mimetypes.detect({ ext })`; falls back to `defaultMimetype` when no extension. text/plain auto-normalizes to text/markdown.

### Result families — `Results`

- `Results.isEntry` / `Results.isProposal` / `Results.isPassthrough` — guards for the optional conventional result shapes.
- `Results.isErrorStatus(status)` — `status >= 400`.
- `Results.problem(owner, code, status, detail, extensions?)` — build and validate RFC 9457 Problem Details with a stable `https://problems.plurnk.dev/<owner>/<code>` type.
- `Results.failure(owner, code, status, detail, fields?, extensions?)` — build and validate a failed operation result.
- `Results.assert(result)` — validate the complete success/failure discrimination and reject malformed plugin output.
- `Results.attachInstance(result, uri)` — attach the durable occurrence URI to a failed result.

A handler owns its failure classification and explanation. The daemon owns the
durable `instance`, because only it knows the committed log coordinate. A
malformed handler result is a plugin contract violation and fails hard; the
consumer does not invent a fallback error or reinterpret arbitrary fields.
The same discrimination applies to every `SchemeCtx` capability result:
entries, channels, and tags never return a bare failure status.

### Matcher dispatch — `Matcher` {§matcher-dispatch}

- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher adapter over `Mimetypes.query` (glob/regex/jsonpath/xpath, all served by the framework). Maps framework errors:
  - `UnsupportedDialectError` → status 415
  - `InvalidExpressionError` → status 400
  - `QueryParseFailureError` → status 203 (soft fallback: raw content as text/markdown with `reason`)
  - Empty match array → status 204
  - Matches → status 200, body rendered as lean `<source-line>:\t<value>` lines (one match per line, the `N:\t` convention READ emits). Value bare for a single-line string, JSON-encoded otherwise so the one-match-per-line invariant holds (preserves `<L><K>` pick-Kth composition). The resolved query path (`matching`) is dropped — the structured `{matched, matching}` wrapper was a model-legibility barrier (schemes#12).

### §3.bis Capability ctx — the stable trusted-extension surface {§capability-ctx}

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
- `notify` — between-turn client signal (`streamEvent`, metadata-only); not model-facing. (No `wakeWorker`: the run-wake carries subscription-close context that only exists at stream completion, so it lives on `subscriptions.close`. Only streaming schemes wake a worker, always via close.)
- `projection` — `readable(content, mimetype)` asks the consumer's configured mimetype family for the model-facing text projection. Acquisition schemes own bytes/DOM; they do not instantiate or second-guess the reader family. `null` means no readable projection.
- `subscriptions` — streaming lifecycle: `open(pathname, handle)` atomically binds durable subscription identity to the consumer's process-local live-handle registry, returns a worker+teardown-composed `AbortSignal`, and takes a force-cancel `SubscriptionHandle`; routed cancellation both invokes the handle and aborts that signal. `notifyChunk(channel, chunk, mimetype?)` is **fused** (append + stream/event in one call), with an optional per-call `mimetype` that retypes the channel to the content's actual type (passed statelessly per chunk; the impl writes only on change; the manifest channel mimetype is the pre-fetch seed default — plurnk-service#226). `close(result, summary?)` validates and persists the exact universal `SchemeResult`, composites channel state, unregisters the live handle, and wakes the worker. `summary` is presentation only; it never replaces or reconstructs the result. Designed against Exec (two-channel, cancel-tested).

There is **no `visibility` capability**: entry-level SHOW/HIDE was removed in plurnk-service's index/visibility teardown — SHOW/HIDE now collapse/expand `log://` rows, a log-side concern with no entry-visibility for a scheme to set (plurnk-service#180).

The consumer passes exactly this public context to every handler. Bundled
adapters that also implement daemon-owned lifecycle behavior receive those
collaborators separately at construction or binding time; consumers must not
decorate `SchemeCtx` with database handles, registries, tokenizers, notifier
callbacks, or other private service state.

**Proposals are not a capability.** A side-effecting scheme proposes by *returning* a `ProposalResult` (status 202); the engine owns the resolution lifecycle. On acceptance it calls the handler's optional `applyResolution({ attrs, body }, ctx)` hook. `attrs` is the payload returned by the proposing operation and `body` is the resolver-approved body, when present. The hook returns a `SchemeResult`: a status below 400 completes the accept; a failure preserves the applying scheme's Problem Details as the proposal's final result.

## §4 What's NOT in this repo

DB-coupled entry/channel machinery — CRUD + write-time tokenization, the
standard entry operations, channel writes, and subscription registry — lives
in the consumer. This package defines their stable interfaces and pure helpers.
Raw CRUD methods are not a parallel handler protocol. For `data` schemes whose
handlers omit resource-specific storage hooks, engine-owned COPY/MOVE/KILL
orchestration uses the manifest-bound `ctx.entries` implementation.

## §5 Trusted extension contract {§trusted-extension}

Installed schemes may legitimately own network connections, subprocesses,
caches, pools, or other host resources. Use `close()` to release resources
owned by the handler. These powers are why installation is a trust decision and
why contained interoperability belongs in MCP rather than an in-process plugin.

The supported compatibility boundary is `@plurnk/plurnk-schemes`. Plugins
should not import private service modules, depend on database layout, or call
prepared statements directly: those are unstable implementation details, not
additional plugin capabilities. Use `SchemeCtx` or propose a new semantic
capability when the public surface cannot express a coherent extension.

## §6 Discovery & registration (third-party)

A scheme handler is discovered and registered with **zero first-party involvement** — install it, it lights up. The contract:

- **Declare** `plurnk.kind: "scheme"` in `package.json` — or, for a package owning multiple capability families, an array that **includes** `"scheme"` (`kind: ["exec", "scheme"]`, #483); every family scanner accepts a package whose kind is or includes its own, string form as the single-kind sugar. Then name the scheme(s) it owns, in one of two forms: `plurnk.schemes: [{ name, export }, …]` (canonical — one entry per scheme, `export` naming the handler-class export) or `plurnk.name: "<scheme>"` (sugar for exactly one scheme, the `default` export). One package may own several names; each name has exactly one owner (#473). This mirrors execs' `plurnk.runtimes: [{ name, glyph, example }]` — `plurnk.kind` plus a plural family-noun array of named capabilities is the shared manifest covenant across families; `export` is schemes' family-specific field (a scheme instantiates a class per name, where an executor dispatches tags through one).
- **`SchemeDiscovery` owns the scan (this package).** `SchemeDiscovery.discover({ cwd? })` walks *all* of `node_modules` — scoped (`@acme/foo`) and unscoped — and returns `{ schemes: {name, packageName, exportName?, attribution?}[], skipped }` for every package declaring `plurnk.kind === "scheme"`. Scope-agnostic, so a third party under their own scope is found with no first-party allow-list (plurnk-service#227); two names claiming one prefix fail-hard (across packages or within one), as does a malformed `plurnk.schemes` (locality of error, not a silent skip). It returns **descriptors, not handlers** — contract-only, it never imports a scheme package; the consumer imports each `packageName` and registers `new mod[exportName ?? "default"]()`, applying in-tree precedence. The scan primitives — package enumeration, the `PLURNK_PLUGINS_TRUSTED_ONLY` trust gate, the deployment-root `node_modules` walk — are one implementation in `@plurnk/plurnk-meta`, shared by all four family-head scanners; `SchemeDiscovery` adds only the scheme-descriptor shape on top.
- **`attribution` rides the descriptor verbatim.** A package may declare `plurnk.attribution` (a credit string, or an array of them); the scan passes it through untouched as `SchemeInfo.attribution` (`string | string[] | undefined`) — anything that isn't a string or string-array is dropped. The framework neither validates nor normalizes it: the `@plurnk`-tags-only-from-`@plurnk`-packages reservation policy is the **consumer's** to enforce on the surfaced credit (plurnk-service#26).
- **The framework stays contract-only.** `@plurnk/plurnk-schemes` does not depend on scheme plugins. The daemon declares its bundled plugins as direct dependencies, and additional plugins are installed at the application root. Plugins declare the framework as a peer dependency using the repository's normal same-minor compatibility range; the framework itself is ignored by discovery because it has no `plurnk.kind`.
- **The default bundle is the daemon's own `dependencies`**, not an aggregator package (the `-all` metapackages are retired). Installing `plurnk-core` surfaces the first-party schemes; any other leaf — first-party or third-party — is added by installing it, and scope-agnostic discovery lights it up identically. No bundle is ever a gate.
- **Trust.** An operator can require host-level trust before a discovered plugin registers (`PLURNK_PLUGINS_TRUSTED_ONLY`, plurnk-service#229) — the scope-agnostic scan widens reach, the trust gate bounds it.
