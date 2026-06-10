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
| `name` | Matches `package.json#plurnk.name`. |
| `channels` | `Record<channelName, mimetype>`. Channel names lowercase. Empty = dynamic per-call. |
| `defaultChannel` | Channel name targeted when path has no `#fragment`. Empty when channels is empty. |
| `category` | `"data"` \| `"logging"`. |
| `scope` | `"agent"` \| `"session"`. |
| `writableBy` | Subset of `["model", "client", "system", "plugin"]`. Consumer returns 403 for outside-set writes. |
| `volatile` | Boolean. |
| `modelVisible` | Boolean. |
| `flags?` | Optional `SchemeFlagAffinity`. |

## §2 Interface

Sister scheme handlers implement op methods consumed by plurnk-service via dispatch. The expected method shape (per consumer-side §3 of plurnk-service's SPEC):

```ts
interface PlurnkScheme {
    // CRUD primitives — REQUIRED for entry-bearing schemes.
    readEntry(pathname, ctx): Promise<ReadEntryResult>;
    writeEntry(pathname, entry, ctx): Promise<WriteEntryResult>;
    deleteEntry(pathname, ctx): Promise<DeleteEntryResult>;

    // Op handlers — OPTIONAL. Absent op = 501.
    edit?(statement, ctx): Promise<EditResult>;
    read?(statement, ctx): Promise<ReadResult>;
    show?(statement, ctx): Promise<ShowHideResult>;
    hide?(statement, ctx): Promise<ShowHideResult>;
    find?(statement, ctx): Promise<FindResult>;
    send?(statement, ctx): Promise<SendResult>;
    exec?(statement, ctx): Promise<ExecResult>;

    // Proposal lifecycle — OPTIONAL.
    onProposalAccepted?(pathname, proposal, ctx): Promise<OpResult>;
    onProposalRejected?(pathname, proposal, ctx): Promise<void>;
}
```

Default export: a class implementing the shape with `static manifest: SchemeManifest`.

Result-type definitions (`EditResult`, `ReadResult`, etc.) live in plurnk-service v0 alongside the helpers that produce them. Forward-spec: these migrate to this repo when the namespaced ctx API lands.

## §3 Helpers exported by this repo

### Types

- Manifest/flags: `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.
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
- `subscriptions` — streaming lifecycle: `open(pathname, handle)` returns a run+teardown-composed `AbortSignal` and takes a force-cancel `SubscriptionHandle`; `notifyChunk(channel, chunk)` is **fused** (append + stream/event in one call); `close(reason, outcome?)` composites channel state + registry close + run wake. Designed against Exec (two-channel, cancel-tested).

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
