# plurnk-schemes — Specification

Contract for `@plurnk/plurnk-schemes-*` sibling packages. Audience: implementer of a URI scheme handler. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §3).

## §1 Manifest

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
        scope: "session",
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
| `category` | `"data"` (entry-bearing) \| `"logging"` (`log://` rows) \| `"control"` (addresses sister processes/runs, owns no entries — e.g. `run://`). |
| `scope` | `"session"` \| `"run"` (grammar 0.67 `default_scope`; `run` = per-run scratch backing `run://`). |
| `writableBy` | Subset of `["model", "client", "system", "plugin"]`. Consumer returns 403 for outside-set writes. |
| `volatile` | Boolean. |
| `modelVisible` | Boolean. |
| `flags?` | Optional `SchemeFlagAffinity`. |
| `example?` | One self-documenting usage line, surfaced verbatim in the model's packet listing; may carry a short trailing explanation (e.g. `"READ(foo://thing/42) — read entry 42"`). Omit → not advertised with a usage line. Deep docs do NOT live here — see below. |
| `glyph?` | Display icon (emoji / nerdfont). Omit → consumer renders the `name` (`glyph ?? name`). |
| `foldedByDefault?` | Entries land FOLDED, off the ranked manifest surface (READable via address, not poured into the ranked view). For executor-output streams (`<tag>://`) — containment one level up (schemes#20/service#240). Absent/false → ranked/first-class. |
| `storedScheme?` | Value persisted to `entries.scheme`, which may differ from the addressing `name`. Resolution: `storedScheme === undefined ? name : storedScheme`. Absent → defaults to `name` (additive; existing manifests unchanged). Explicit `null` → persists BARE (e.g. File: bare paths, `entries.scheme` NULL, routing name `"file"`). |

**Self-doc split.** The manifest carries only the terse listing (`example` + `glyph`). Detailed documentation — every op, channel, status code, gotcha — is a markdown the model reads on demand at **`plurnk://schemes/<name>.md`** (the consumer serves it), bypassing the manifest. Keep the manifest a one-liner; the deep doc carries the prose.

## §2 Interface

Sister scheme handlers implement op methods consumed by plurnk-service via dispatch: the engine calls `handler[statement.op.toLowerCase()](statement, ctx)` and returns **501** for any op whose method is absent. The op-dispatch surface is the exported **`SchemeHandler`** interface — every method optional, each `(statement, ctx) => Promise<SchemeResult>`, the per-op statement type from grammar:

```ts
import type { SchemeHandler } from "@plurnk/plurnk-schemes";

export interface SchemeHandler {
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    open?(statement: OpenStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    fold?(statement: FoldStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    edit?(statement: EditStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    copy?(statement: CopyStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    move?(statement: MoveStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    plan?(statement: PlanStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}
```

A sibling does `export default class X implements SchemeHandler` (with `static manifest: SchemeManifest`) and gets compile-time signature checking. The op set tracks the pinned grammar (0.53.0) and moves with the framework's grammar bump. **The statement + path types (`ReadStatement`, `SendStatement`, `UrlPath`, …) are re-exported from this barrel**, so a sibling depends on and exact-pins ONLY `@plurnk/plurnk-schemes` — grammar rides underneath as the framework's transitive pin (§3).

Two surfaces are NOT yet in `SchemeHandler`, pending their result types migrating here from plurnk-service v0: the **CRUD primitives** (`readEntry`/`writeEntry`/`deleteEntry`, required for entry-bearing schemes) and the **proposal lifecycle** (the optional `ProposalAware.applyResolution` hook, already exported via §3.bis). Until then a scheme declares those methods directly.

## §3 Helpers exported by this repo

### Types

- Manifest/flags: `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
- Behavior contract: `SchemeHandler` (§2). Scheme-facing grammar types re-exported here so siblings pin only this package: `PlurnkStatement` + the per-op statement types (`ReadStatement`, `FindStatement`, `OpenStatement`, `FoldStatement`, `EditStatement`, `CopyStatement`, `MoveStatement`, `SendStatement`, `ExecStatement`, `KillStatement`, `PlanStatement`) and path types (`ParsedPath` = `LocalPath` | `UrlPath` | `RegexPath`).
- Discovery: `SchemeDiscovery` (behavior class) with `SchemeInfo` / `SchemeDiscoveryResult` / `DiscoverOptions` (§6).
- Executor-scheme (RFC schemes#20 — "an executor is a scheme"): `OutputScheme.manifestFromRuntime(decl)` derives a read-only-output `SchemeManifest` from an executor's `RuntimeDecl` (zero scheme-authoring); `DefaultRead.read(content, mimetype, statement, mimetypes)` → `ReadResolution` is the free `<L>`/matcher read over produced output (reuses `Slicer`/`Matcher`); `Summarize.summarize(content, mimetype)` → `OrientIndex` is the structural-only EXEC-receipt index (no content — universal-receipt containment). A per-tag executor-scheme supplies its manifest via instance `get manifest()` (§2 `SchemeHandler.manifest?`).
- Result families: `SchemeResult` (`EntryResult` | `ProposalResult` | `PassthroughResult`), `SchemeResultBase`, `TelemetryEvent`. Keyed on scheme-shape, not op. `error` is a grammar `TelemetryEvent`, present iff `status >= 400`. Guards `isEntryResult` / `isProposalResult` / `isPassthroughResult` / `isErrorStatus`; builders `schemeError(scheme, kind, message?, position?)`, `logCoordinate(coordinate, op?)`.
- Capability ctx (PR-2, see §3.bis): `SchemeCtx` + `EntryCaps` / `ChannelCaps` / `TagCaps` / `NotifyCaps` / `SubscriptionCaps` / `CrossSchemeCaps`, plus `EntryData`, `ChannelState`, `SubscriptionHandle`, `ProposalAware`.

Behavior ships as `export default class` (one class per file, static methods) — the ecosystem class paradigm. Type-only modules, the barrel, and the frozen `DEFAULT_LOOP_FLAGS` constant are the only non-class files.

### Active-scheme resolution — `SchemeResolver`

- `SchemeResolver.forLoop(handlers: ReadonlyMap<string, object>, flags: LoopFlags): Set<string>` — applies `manifest.flags` affinity to each handler and returns names of schemes active under the loop's flags.

### Mimetype classification — `MimetypeClassifier`

- `MimetypeClassifier.isBinary(mimetype)` — enforces 415 boundary on binary entries (text/* is text; application/{json,yaml,toml,xml,javascript,typescript,sql} is text; `+json`/`+xml`/`+yaml` suffix variants are text; everything else with a slash is binary).
- `MimetypeClassifier.isJson(mimetype)` — `application/json` plus `+json` variants. Used by `<L>` dispatch.
- `MimetypeClassifier.isLineNavigable(mimetype)` — render-layer decides whether to prefix lines with `N:\t`.
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

### Matcher dispatch — `Matcher`

- `Matcher.matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher adapter over `Mimetypes.query` (glob/regex/jsonpath/xpath, all served by the framework). Maps framework errors:
  - `UnsupportedDialectError` → status 415
  - `InvalidExpressionError` → status 400
  - `QueryParseFailureError` → status 203 (soft fallback: raw content as text/markdown with `reason`)
  - Empty match array → status 204
  - Matches → status 200, body rendered as lean `<source-line>:\t<value>` lines (one match per line, the `N:\t` convention READ emits). Value bare for a single-line string, JSON-encoded otherwise so the one-match-per-line invariant holds (preserves `<L><K>` pick-Kth composition). The resolved query path (`matching`) is dropped — the structured `{matched, matching}` wrapper was a model-legibility barrier (schemes#12).

### §3.bis Capability ctx — the DB-free authoring surface

The contract that lets a third-party `@plurnk/plurnk-schemes-*` sibling be authored without importing `@plurnk/plurnk-service` or touching a raw DB handle (forbidden by §5). **Interfaces only**: this repo exports the shapes; plurnk-service injects a db-backed implementation behind them (the `scheme-types.ts` seam, widened). In-tree schemes keep using `db` directly during transition and cut over scheme-by-scheme. Design converged on [plurnk-service#180](https://github.com/plurnk/plurnk-service/issues/180).

`SchemeCtx` carries per-dispatch identity (`sessionId`/`runId`/`loopId`/`turnId`/`writer`/`signal`) plus **five live capability namespaces** replacing raw `db`:

- `entries` — CRUD over the scheme's own namespace (`read`/`write`/`delete`).
- `channels` — content writes + state (`append`/`replace`/`setState`).
- `tags` — entry tags (`add`/`remove`/`list`).
- `notify` — between-turn client signal (`streamEvent`, metadata-only); not model-facing. (No `wakeRun`: the run-wake carries subscription-close context that only exists at stream completion, so it lives on `subscriptions.close`. Only streaming schemes wake a run, always via close.)
- `subscriptions` — streaming lifecycle: `open(pathname, handle)` returns a run+teardown-composed `AbortSignal` and takes a force-cancel `SubscriptionHandle`; `notifyChunk(channel, chunk, mimetype?)` is **fused** (append + stream/event in one call), with an optional per-call `mimetype` that retypes the channel to the content's actual type (passed statelessly per chunk; the impl writes only on change; the manifest channel mimetype is the pre-fetch seed default — plurnk-service#226); `close(reason, outcome?)` composites channel state + registry close + run wake. Designed against Exec (two-channel, cancel-tested).

There is **no `visibility` capability**: entry-level SHOW/HIDE was removed in plurnk-service's index/visibility teardown — SHOW/HIDE now collapse/expand `log://` rows, a log-side concern with no entry-visibility for a scheme to set (plurnk-service#180).

`crossScheme` is a **deferred** placeholder — no FROM/TO methods committed until the first real cross-scheme COPY/MOVE forces the shape.

**Proposals are not a capability.** A side-effecting scheme proposes by *returning* a `ProposalResult` (status 202); the engine owns the resolution lifecycle (await/accept/reject, YOLO/noProposals auto-resolve, timeout) and it is invisible to the sibling. The only sibling-side surface is the optional `ProposalAware.applyResolution(pathname, proposal, ctx)` hook the engine calls on accept.

## §4 What's NOT in this repo

DB-coupled helpers stay in plurnk-service for v0:

- `_entry-ops.ts` (read/edit/show/hide session entries)
- `_entry-crud.ts` (CRUD primitives + write-time tokenization helper)
- `_entry-send.ts` (SEND[410]/[499] dispatcher)
- `_entry-find.ts` (pathname-glob FIND)
- `ChannelWrite.ts` (channel append + subscription registry)
- `PlurnkSchemeContext` (per-call helper with DB handle)

These migrate when the v1 namespaced ctx API lands (entries / channels / visibility / tags / subscriptions / proposals / crossScheme / notify). v0 scope: types + pure helpers only.

## §5 Forbidden (for third-party schemes)

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

- **Declare** `plurnk.kind: "scheme"` and `plurnk.name: "<scheme>"` in `package.json`, and `export default` the handler class.
- **`SchemeDiscovery` owns the scan (this package).** `SchemeDiscovery.discover({ cwd? })` walks *all* of `node_modules` — scoped (`@acme/foo`) and unscoped — and returns `{ schemes: {name, packageName}[], skipped }` for every package declaring `plurnk.kind === "scheme"` + `plurnk.name`. Scope-agnostic, so a third party under their own scope is found with no first-party allow-list (plurnk-service#227); two externals claiming one prefix fail-hard. It returns **descriptors, not handlers** — contract-only, it never imports a scheme package; the consumer imports each `packageName` and registers `new mod.default()`, applying in-tree precedence. Co-located with its tests here, parallel to `plurnk-execs`/`plurnk-mimetypes`/`plurnk-providers` discover().
- **The framework stays contract-only.** `@plurnk/plurnk-schemes` never depends on a scheme package — that would nest daughters under it and the top-level scan would miss them. Daughters peer-pin the framework (exact); it arrives transitively and is itself ignored by the scan (no `plurnk.kind`).
- **`@plurnk/plurnk-schemes-all`** is the first-party convenience bundle: it deps the first-party siblings flat so one install surfaces them all. It is never a gate — operators install individual packages or third-party ones identically.
- **Trust.** An operator can require host-level trust before a discovered plugin registers (`PLURNK_PLUGINS_TRUSTED_ONLY`, plurnk-service#229) — the scope-agnostic scan widens reach, the trust gate bounds it.
