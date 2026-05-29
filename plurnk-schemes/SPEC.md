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

- `SchemeManifest`, `SchemeFlagAffinity`, `WriterTier`, `LoopFlags`, `DEFAULT_LOOP_FLAGS`.

### Active-scheme resolution

- `resolveForLoop(handlers: Map<string, object>, flags: LoopFlags): Set<string>` — applies `manifest.flags` affinity to each handler and returns names of schemes active under the loop's flags.

### Mimetype classification

- `isBinaryMimetype(mimetype)` — enforces 415 boundary on binary entries (text/* is text; application/{json,yaml,toml,xml,javascript,typescript,sql} is text; `+json`/`+xml`/`+yaml` suffix variants are text; everything else with a slash is binary).
- `isJsonMimetype(mimetype)` — `application/json` plus `+json` variants. Used by `<L>` dispatch.
- `isLineNavigableMimetype(mimetype)` — render-layer decides whether to prefix lines with `N:\t`.
- `normalizeAutoTextMimetype(mimetype)` — `text/plain` / null / undefined → `TEXT_PRIMITIVE_MIMETYPE` (`text/markdown`).
- `TEXT_PRIMITIVE_MIMETYPE` — `"text/markdown"`.

### `<L>` slicing

- `sliceLines(content, marker)` — line-navigable slice. Returns `{ status, text?, startLine?, error? }`.
- `sliceLinesRaw(content, marker)` — same shape; no `N:\t` prefix.
- `sliceJsonItems(content, marker)` — JSON-source item slice. Returns `{ status, body?, error? }`.
- `applyLineMarkerEdit(content, marker, body)` — line-navigable EDIT.
- `applyJsonItemEdit(content, marker, body)` — structural JSON EDIT.

### Path-extension mimetype

- `resolveEntryMimetype(pathname, defaultMimetype, mimetypes)` — pathname extension → `Mimetypes.detect({ ext })`; falls back to `defaultMimetype` when no extension. text/plain auto-normalizes to text/markdown.

### Matcher dispatch

- `matchAgainstContent(body, content, mimetype, mimetypes, baseLine?)` — body-matcher adapter over `Mimetypes.query`. Maps framework errors:
  - `UnsupportedDialectError` → status 415
  - `InvalidExpressionError` → status 400
  - `QueryParseFailureError` → status 203 (soft fallback: raw content as text/markdown with `reason`)
  - Empty match array → status 204
  - Match array → status 200

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
