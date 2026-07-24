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
| `defaultChannel` | Channel name targeted when path has no `#fragment`. Empty when channels is empty. |
| `category` | `"data"` (entry-bearing) \| `"logging"` (`log://` rows) \| `"control"` (addresses sister processes/runs, owns no entries — e.g. `worker://`). |
| `scope` | `"workspace"` \| `"worker"` (grammar 0.67 `default_scope`; `worker` = per-worker scratch backing `worker://`). |
| `writableBy` | Subset of `["model", "client", "system", "plugin"]`. Consumer returns 403 for outside-set writes. |
| `volatile` | Boolean. |
| `modelVisible` | Boolean. |
| `folderScopes?` | `true` declares that a trailing slash on READ is a collection scope. Absent/false means `/` is ordinary resource syntax. Matcher bodies and explicit globs remain queries independently. |
| `flags?` | Optional `SchemeFlagAffinity`. |
| `example?` | The scheme's terse **hot-path** one-liner (e.g. `"READ(foo://thing/42)"`) — renders in the live catalogue every turn, so keep it to one canonical usage line. Omit → not advertised. Depth goes in `documentation`. |
| `documentation?` | The **deep doc** (semantics / channels / edge cases). Consumer materializes it as a pull-able `worker://plurnk/docs/<name>.md` entry READ on demand; never hits the hot path. Mirrors `ExecInfo.documentation` (schemes#25). |
| `glyph?` | Display icon (emoji / nerdfont). Omit → consumer renders the `name` (`glyph ?? name`). |
| `foldedByDefault?` | Entries land FOLDED, off the ranked manifest surface (READable via address, not poured into the ranked view). For executor-output streams (`<tag>://`) — containment one level up (schemes#20/service#240). Absent/false → ranked/first-class. |
| `storedScheme?` | Value persisted to `entries.scheme`, which may differ from the addressing `name`. Resolution: `storedScheme === undefined ? name : storedScheme`. Absent → defaults to `name` (additive; existing manifests unchanged). Explicit `null` → persists BARE (e.g. File: bare paths, `entries.scheme` NULL, routing name `"file"`). |

**Self-doc split (terse pushes, depth pulls).** {§manifest-self-doc} `example` + `glyph` are the hot-path listing rendered every turn — keep them terse. `documentation` is the deep prose (every op, channel, status code, gotcha); the consumer materializes it as a pull-able **`worker://plurnk/docs/<name>.md`** entry the model READs on demand, off the hot path. Both live on the manifest; the consumer decides what's pushed vs pulled.

**Authoring convention — `docs/<name>.md`.** The contract field stays a plain `string`, but a sibling SHOULD keep the deep doc in a **`docs/<name>.md`** file at the package root rather than inline, and load it into the manifest at module init — e.g. `documentation: await readFile(new URL("../docs/<name>.md", import.meta.url), "utf-8")` (top-level await; `../` resolves identically from `src/` in test and `dist/` once built). Ship it by adding `docs/**/*` to `files`. This keeps prose out of the handler source and gives editors real Markdown; the contract and the consumer's `worker://plurnk/docs/<name>.md` materialization are unchanged. A missing file fails-hard at import (no silent empty doc).

## §2 Interface

Sister scheme handlers implement op methods consumed by plurnk-service via dispatch: the engine calls `handler[statement.op.toLowerCase()](statement, ctx)` and returns **501** for any op whose method is absent. The op-dispatch surface is the exported **`SchemeHandler`** interface — every method optional, each `(statement, ctx) => Promise<SchemeResult>`, the per-op statement type from grammar:

```ts
import type { SchemeHandler } from "@plurnk/plurnk-schemes";

export interface SchemeHandler {
    close?(): Promise<void>;
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    open?(statement: OpenStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    fold?(statement: FoldStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    edit?(statement: EditStatement, ctx: SchemeCtx): Promise<SchemeResult>;
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

A sibling does `export default class X implements SchemeHandler` (with `static manifest: SchemeManifest`) and gets compile-time signature checking. The op set is exactly grammar's `PlurnkStatement` dispatch union and moves with the framework's grammar bump (0.74.57 added `work?`/`fork?`; `LOOK`/`BUFF` are grammar `ClientStatement` ops, client-facing and never dispatched to a scheme, so they're intentionally absent here). **The statement + path types (`ReadStatement`, `SendStatement`, `UrlPath`, …) are re-exported from this barrel**, so a sibling depends on and peers (`^1`) ONLY `@plurnk/plurnk-schemes` — grammar rides underneath as the framework's transitive dep (§3).

`close?()` is the process-lifecycle hook for pooled resources such as browser processes, sockets, and client connections. The consumer calls it once per unique handler instance after in-flight scheme work drains and before backing stores close. Stateless handlers omit it.

The entry CRUD primitives (`readEntry`/`writeEntry`/`deleteEntry`) are not handler operations; schemes use `ctx.entries`. Proposal application is the optional `applyResolution` handler hook described in §3.bis.

## §3 Helpers exported by this repo

### Types

- Manifest/flags: `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
- Optional `PacketSectionTransformer` — a scheme MAY implement `transformSections(sections: PacketSection[]) → PacketSection[] | Promise<…>` to reshape the packet's section list (add/remove/reorder) before the engine measures it; called duck-typed in registration order. `PacketSection` = `{ name; slot: "system"|"user"; header: string|null; content; tokens }`. Contract declares the shape; service conforms (the in-process plugin-packet-control / fork-avoidance seam — schemes#24).
- Behavior contract: `SchemeHandler` (§2). Scheme-facing grammar types re-exported here so siblings pin only this package: `PlurnkStatement` + the per-op statement types (`ReadStatement`, `FindStatement`, `OpenStatement`, `FoldStatement`, `EditStatement`, `CopyStatement`, `MoveStatement`, `SendStatement`, `ExecStatement`, `WorkStatement`, `ForkStatement`, `KillStatement`, `PlanStatement`) and path types (`ParsedPath` = `LocalPath` | `UrlPath` | `RegexPath`).
- Discovery: `SchemeDiscovery` (behavior class) with `SchemeInfo` / `SchemeDiscoveryResult` / `DiscoverOptions` (§6).
- Executor-scheme (RFC schemes#20 — "an executor is a scheme"): `OutputScheme.manifestFromRuntime(decl)` derives a read-only-output `SchemeManifest` from an executor's `RuntimeDecl` (zero scheme-authoring); `DefaultRead.read(content, mimetype, statement, mimetypes)` → `ReadResolution` is the free `<L>`/matcher read over produced output (reuses `Slicer`/`Matcher`); `Summarize.summarize(content, mimetype)` → `OrientIndex` is the structural-only EXEC-receipt index (no content — universal-receipt containment). A per-tag executor-scheme supplies its manifest via instance `get manifest()` (§2 `SchemeHandler.manifest?`).
- Result families: `SchemeResult` (`EntryResult` | `ProposalResult` | `PassthroughResult`), `SchemeResultBase`, `TelemetryEvent`. Keyed on scheme-shape, not op. `error` is a grammar `TelemetryEvent`, present iff `status >= 400`. Guards `isEntryResult` / `isProposalResult` / `isPassthroughResult` / `isErrorStatus`; builders `schemeError(scheme, kind, message?, position?)`, `logCoordinate(coordinate, op?)`.
- Capability ctx (see §3.bis): `SchemeCtx` + `EntryCaps` / `ChannelCaps` / `TagCaps` / `NotifyCaps` / `ProjectionCaps` / `SubscriptionCaps`, plus `EntryData`, `ChannelState`, `SubscriptionHandle`, `ProposalAware`, `ProposalApplyRequest`, and `ProposalApplyResult`.

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

- `Slicer.lines(content, marker)` — line-navigable slice. Returns `{ status, text?, startLine?, error? }`.
- `Slicer.linesRaw(content, marker)` — same shape; no `N:\t` prefix.
- `Slicer.jsonItems(content, marker)` — JSON-source item slice. Returns `{ status, body?, error? }`.
- `Slicer.lineMarkerEdit(content, marker, body)` — line-navigable EDIT.
- `Slicer.jsonItemEdit(content, marker, body)` — structural JSON EDIT.

### Path-extension mimetype — `PathMimetype`

- `PathMimetype.resolve(pathname, defaultMimetype, mimetypes)` — pathname extension → `Mimetypes.detect({ ext })`; falls back to `defaultMimetype` when no extension. text/plain auto-normalizes to text/markdown.

### Result families — `Results`

- `Results.isEntry` / `Results.isProposal` / `Results.isPassthrough` — `shape` discriminator guards over `SchemeResult`.
- `Results.isErrorStatus(status)` — `status >= 400`.
- `Results.error(scheme, kind, message?, position?)` — build a scheme-sourced `TelemetryEvent` (`source: "scheme:<name>"`).
- `Results.logCoordinate(coordinate, op?)` — build a `LogCoordinate` position.

### Matcher dispatch — `Matcher` {§matcher-dispatch}

- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher adapter over `Mimetypes.query` (glob/regex/jsonpath/xpath, all served by the framework). Maps framework errors:
  - `UnsupportedDialectError` → status 415
  - `InvalidExpressionError` → status 400
  - `QueryParseFailureError` → status 203 (soft fallback: raw content as text/markdown with `reason`)
  - Empty match array → status 204
  - Matches → status 200, body rendered as lean `<source-line>:\t<value>` lines (one match per line, the `N:\t` convention READ emits). Value bare for a single-line string, JSON-encoded otherwise so the one-match-per-line invariant holds (preserves `<L><K>` pick-Kth composition). The resolved query path (`matching`) is dropped — the structured `{matched, matching}` wrapper was a model-legibility barrier (schemes#12).

### §3.bis Capability ctx — the DB-free authoring surface {§capability-ctx}

The contract that lets a third-party `@plurnk/plurnk-schemes-*` sibling be authored without importing `@plurnk/plurnk-service` or touching a raw DB handle (forbidden by §5). **Interfaces only**: this repo exports the shapes; the consumer (`plurnk-core`) injects a db-backed implementation behind them. Design converged on [plurnk-service#180](https://github.com/plurnk/plurnk-service/issues/180).

`SchemeCtx` carries per-dispatch identity (`workspaceId`/`workerId`/`loopId`/`turnId`/`writer`/`signal`) plus **six live capability namespaces** replacing raw `db`:

- `entries` — CRUD over the scheme's own namespace (`read`/`write`/`delete`).
- `channels` — content writes + state (`append`/`replace`/`setState`).
- `tags` — entry tags (`add`/`remove`/`list`).
- `notify` — between-turn client signal (`streamEvent`, metadata-only); not model-facing. (No `wakeWorker`: the run-wake carries subscription-close context that only exists at stream completion, so it lives on `subscriptions.close`. Only streaming schemes wake a worker, always via close.)
- `projection` — `readable(content, mimetype)` asks the consumer's configured mimetype family for the model-facing text projection. Acquisition schemes own bytes/DOM; they do not instantiate or second-guess the reader family. `null` means no readable projection.
- `subscriptions` — streaming lifecycle: `open(pathname, handle)` returns a worker+teardown-composed `AbortSignal` and takes a force-cancel `SubscriptionHandle`; `notifyChunk(channel, chunk, mimetype?)` is **fused** (append + stream/event in one call), with an optional per-call `mimetype` that retypes the channel to the content's actual type (passed statelessly per chunk; the impl writes only on change; the manifest channel mimetype is the pre-fetch seed default — plurnk-service#226); `close(reason, outcome?)` composites channel state + registry close + run wake. Designed against Exec (two-channel, cancel-tested).

There is **no `visibility` capability**: entry-level SHOW/HIDE was removed in plurnk-service's index/visibility teardown — SHOW/HIDE now collapse/expand `log://` rows, a log-side concern with no entry-visibility for a scheme to set (plurnk-service#180).

**Proposals are not a capability.** A side-effecting scheme proposes by *returning* a `ProposalResult` (status 202); the engine owns the resolution lifecycle. On acceptance it calls the handler's optional `applyResolution({ attrs, body }, ctx)` hook. `attrs` is the payload returned by the proposing operation and `body` is the resolver-approved body, when present. The hook returns `{ status, outcome?, body? }`: a status below 400 completes the accept; a failure rejects it with the returned outcome.

## §4 What's NOT in this repo

DB-coupled entry/channel machinery — CRUD + write-time tokenization, the SEND/FIND dispatchers, the channel-write/subscription registry, the per-call DB-handle context — lives in the consumer (`plurnk-core`), never here. This package is types + pure helpers only; a scheme reaches the substrate through the §3.bis capability ctx, never a raw DB handle.

## §5 Forbidden (for third-party schemes) {§forbidden}

| ❌ |
|---|
| Imports from `@plurnk/plurnk-service/*` |
| Direct database access |
| Writes outside the scheme's own namespace |
| Direct invocation of peer schemes |
| Mutating `ctx` |
| Holding `ctx` references past the op handler's return |
| Reading or writing `log_entries` directly |
| Calling consumer-internal methods |
| Writing to `console`, stdout, stderr |
| Spawning subprocesses (unless the scheme is specifically a subprocess scheme) |
| Opening network connections (unless specifically a network scheme) |
| Caching across op invocations (state in instance fields beyond config) |

## §6 Discovery & registration (third-party)

A scheme handler is discovered and registered with **zero first-party involvement** — install it, it lights up. The contract:

- **Declare** `plurnk.kind: "scheme"` in `package.json` — or, for a dual-faced package (e.g. MCP: exec + scheme), an array that **includes** `"scheme"` (`kind: ["exec", "scheme"]`, #483); every family scanner accepts a package whose kind is or includes its own, string form as the single-kind sugar. Then name the scheme(s) it owns, in one of two forms: `plurnk.schemes: [{ name, export }, …]` (canonical — one entry per scheme, `export` naming the handler-class export) or `plurnk.name: "<scheme>"` (sugar for exactly one scheme, the `default` export). One package may own several names; each name has exactly one owner (#473). This mirrors execs' `plurnk.runtimes: [{ name, glyph, example }]` — `plurnk.kind` plus a plural family-noun array of named capabilities is the shared manifest covenant across families; `export` is schemes' family-specific field (a scheme instantiates a class per name, where an executor dispatches tags through one).
- **`SchemeDiscovery` owns the scan (this package).** `SchemeDiscovery.discover({ cwd? })` walks *all* of `node_modules` — scoped (`@acme/foo`) and unscoped — and returns `{ schemes: {name, packageName, exportName?, attribution?}[], skipped }` for every package declaring `plurnk.kind === "scheme"`. Scope-agnostic, so a third party under their own scope is found with no first-party allow-list (plurnk-service#227); two names claiming one prefix fail-hard (across packages or within one), as does a malformed `plurnk.schemes` (locality of error, not a silent skip). It returns **descriptors, not handlers** — contract-only, it never imports a scheme package; the consumer imports each `packageName` and registers `new mod[exportName ?? "default"]()`, applying in-tree precedence. The scan primitives — package enumeration, the `PLURNK_PLUGINS_TRUSTED_ONLY` trust gate, the deployment-root `node_modules` walk — are one implementation in `@plurnk/plurnk-meta`, shared by all four family-head scanners; `SchemeDiscovery` adds only the scheme-descriptor shape on top.
- **`attribution` rides the descriptor verbatim.** A package may declare `plurnk.attribution` (a credit string, or an array of them); the scan passes it through untouched as `SchemeInfo.attribution` (`string | string[] | undefined`) — anything that isn't a string or string-array is dropped. The framework neither validates nor normalizes it: the `@plurnk`-tags-only-from-`@plurnk`-packages reservation policy is the **consumer's** to enforce on the surfaced credit (plurnk-service#26).
- **The framework stays contract-only.** `@plurnk/plurnk-schemes` does not depend on scheme plugins. The daemon declares its bundled plugins as direct dependencies, and additional plugins are installed at the application root. Plugins declare the framework as a peer dependency using the repository's normal same-minor compatibility range; the framework itself is ignored by discovery because it has no `plurnk.kind`.
- **The default bundle is the daemon's own `dependencies`**, not an aggregator package (the `-all` metapackages are retired). Installing `plurnk-core` surfaces the first-party schemes; any other leaf — first-party or third-party — is added by installing it, and scope-agnostic discovery lights it up identically. No bundle is ever a gate.
- **Trust.** An operator can require host-level trust before a discovered plugin registers (`PLURNK_PLUGINS_TRUSTED_ONLY`, plurnk-service#229) — the scope-agnostic scan widens reach, the trust gate bounds it.
