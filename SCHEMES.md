# SCHEMES.md

Contract for `@plurnk/plurnk-schemes-*` packages. Audience: implementer of a URI scheme handler. Companion contracts: MIMETYPES.md (content interpreters), PROVIDERS.md (LLM transports). Engine surface: SPEC.md.

---

## §1 Role

A scheme is an addressable resource handler. Every URI in plurnk has a scheme prefix (`known://`, `file://`, `https://`, `exec://`); the scheme handler interprets paths under that prefix. Schemes are the engine's primary extension surface — adding new addressable resources means adding new schemes.

A scheme owns:

- The interpretation of paths under its prefix.
- The storage substrate for entries it persists (SQL rows, filesystem, subprocess output, remote endpoint).
- The op handlers for each DSL operation it accepts (`edit`, `read`, `show`, `hide`, `find`, `send`, `exec`).
- The CRUD primitives the engine drives for cross-scheme orchestration (COPY/MOVE/SEND[410]).

A scheme does NOT own:

- The database connection.
- The engine, dispatch, packet assembly, log writing, or any peer scheme.
- Cross-scheme operations — those are engine-orchestrated.
- Permission enforcement — the engine checks `manifest.writableBy` before invoking the scheme.

---

## §2 Manifest

`package.json`:

```json
{
    "name": "@plurnk/plurnk-schemes-<name>",
    "plurnk": {
        "kind": "scheme",
        "name": "<scheme name>"
    }
}
```

- `kind` MUST be `"scheme"`.
- `name` is the URI scheme without `://` (`known`, `wiki`, `sse`, `exec`).

Class-level manifest (static field on the default export):

```ts
static manifest: SchemeManifest = {
    name: "known",
    channels: { body: "text/markdown", preview: "text/markdown" },
    defaultChannel: "body",
    category: "data",
    scope: "session",
    writableBy: ["model", "client"],
    volatile: false,
    modelVisible: true,
};
```

| Field | Constraint |
|---|---|
| `name` | Matches `package.json#plurnk.name`. Engine throws on mismatch at registration. |
| `channels` | `Record<channelName, mimetype>`. Non-empty. Channel names lowercase, `[a-z][a-z0-9_-]*`. The mimetype string MUST match a registered mimetype handler at boot, else fail-hard. Dynamic-mimetype schemes (file, exec) declare an empty manifest channel and supply mimetype per-call (§4.1). |
| `defaultChannel` | Channel name. Targeted when an op's path has no `#fragment`. MUST be a key in `channels` (or empty when channels are dynamic). |
| `category` | `"data"` \| `"logging"`. Data entries render as `<index>` tiles; logging entries render as `<log>` rows. |
| `scope` | `"agent"` \| `"session"`. Default scope for new entries written under this scheme. Per-call overrides require explicit context. |
| `writableBy` | Subset of `["model", "client", "system", "plugin"]`. Engine rejects writes from identities outside this set with 403; the rejection is logged as the action-entry. |
| `volatile` | Boolean. `true` for schemes whose content changes rapidly (`sh`, `env`, `sse`). Engine sorts volatile schemes to the bottom of `<index>` for cache stability. |
| `modelVisible` | Boolean. `false` hides entries from the model's index/log rendering (audit schemes like `instructions://`, `system://`). Default `true`. |

Collision on `(kind: "scheme", name)` at discovery: fail-hard. SPEC §9.

---

## §3 Interface

```ts
import type {
    EditStatement, ReadStatement, ShowStatement, HideStatement,
    FindStatement, SendStatement, ExecStatement,
} from "@plurnk/plurnk-grammar";

interface SchemeFlagAffinity {
    readonly excludedInAsk?: boolean;        // scheme excluded when mode === "ask"
    readonly requiresWeb?: boolean;           // scheme excluded when noWeb
    readonly requiresInteraction?: boolean;   // scheme excluded when noInteraction
    readonly proposes?: boolean;              // scheme excluded when noProposals
}

interface SchemeManifest {
    name: string;
    channels: Record<string, string>;
    defaultChannel: string;
    category: "data" | "logging";
    scope: "agent" | "session";
    writableBy: ReadonlyArray<"model" | "client" | "system" | "plugin">;
    volatile: boolean;
    modelVisible: boolean;
    flags?: SchemeFlagAffinity;
}

interface EntryData {
    channels: Record<string, { content: string; mimetype: string }>;
    tags: string[];
}

interface PlurnkScheme {
    // CRUD primitives — REQUIRED for any scheme that holds entries.
    // Engine drives these for cross-scheme COPY/MOVE/SEND[410].
    readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult>;
    writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult>;
    deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult>;

    // Op handlers — OPTIONAL. Absent op = 501.
    edit?(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult>;
    read?(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult>;
    show?(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult>;
    hide?(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult>;
    find?(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult>;
    send?(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<SendResult>;
    exec?(statement: ExecStatement, ctx: PlurnkSchemeContext): Promise<ExecResult>;

    // Proposal lifecycle — OPTIONAL. Implement when the scheme defers side
    // effects to client resolution. (Phase E.)
    onProposalAccepted?(pathname: string, proposal: ProposalRecord, ctx: PlurnkSchemeContext): Promise<OpResult>;
    onProposalRejected?(pathname: string, proposal: ProposalRecord, ctx: PlurnkSchemeContext): Promise<void>;
}
```

Default export: a class implementing the scheme shape with `static manifest: SchemeManifest`. Engine instantiates once at boot, reuses across calls.

Convention: `(input, ctx)` arg order across all methods. The op-specific input (statement / pathname / entry) is first; `ctx` is the per-call helper bundling everything else.

---

## §4 PlurnkSchemeContext

The per-call helper. Engine constructs a fresh context for every op invocation.

**v0 shape (current, `src/core/scheme-types.ts`):**

```ts
interface PlurnkSchemeContext {
    readonly db: Db;
    readonly sessionId: number;
    readonly runId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: "model" | "client" | "system" | "plugin";
    readonly signal: AbortSignal | undefined;
}
```

Flat struct bundling the per-call params. Scheme handlers receive this directly; bundled in-tree schemes (Known/Unknown/Skill/File/Log) use `ctx.db` to call shared helpers in `src/schemes/_entry-*.ts`. The contract pragma is that third-party schemes do NOT touch `ctx.db`, but the interface doesn't enforce it yet — convention only.

**v1 shape (aspirational, lands when third-party plugin schemes are an actual concern):**

```ts
interface PlurnkSchemeContext {
    readonly sessionId: number;
    readonly runId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: "model" | "client" | "system" | "plugin";
    readonly signal: AbortSignal;

    // Namespaced operations (§4.1–§4.8)
    readonly entries: EntriesApi;
    readonly channels: ChannelsApi;
    readonly visibility: VisibilityApi;
    readonly tags: TagsApi;
    readonly subscriptions: SubscriptionsApi;
    readonly proposals: ProposalsApi;
    readonly crossScheme: CrossSchemeApi;
    readonly notify: NotifyApi;
}
```

The v1 surface seals out direct DB access by exposing namespaced primitives that wrap the same underlying SQL. The sub-sections below (§4.1–§4.8) document the v1 APIs as designed; treat them as forward-spec until the migration lands.

### §4.1 `entries`

Entry-level CRUD over the scheme's own entries. Engine restricts reads/writes to the calling scheme's namespace; cross-scheme reads go through `ctx.crossScheme`.

```ts
interface EntriesApi {
    read(pathname: string): Promise<EntryData | null>;
    write(pathname: string, entry: EntryData, opts?: { state?: ChannelState }): Promise<WriteResult>;
    delete(pathname: string): Promise<DeleteResult>;
    findByPattern(pattern: string, filters?: {
        tags?: string[];
        scopePathname?: string;
    }): Promise<string[]>;  // returns pathnames (not full entries)
}

interface WriteResult { status: 200 | 201 | 409; entryId: number; created: boolean; }
interface DeleteResult { status: 200 | 404; }
```

Implementation note: `write` enforces the scheme's `channels` manifest. If `entry.channels` contains a channel name not in the manifest, returns 400. If a channel's mimetype doesn't match the manifest (when the manifest declares the mimetype), returns 415. Schemes with dynamic mimetypes (file, exec) declare empty `channels: {}` and supply mimetype per-call inside `entry.channels[name].mimetype`.

### §4.2 `channels`

Per-channel content manipulation. Used by streaming schemes (`sse`, `exec`) that append content incrementally.

```ts
interface ChannelsApi {
    append(entryId: number, channel: string, chunk: string): Promise<void>;
    setState(entryId: number, channel: string, state: ChannelState): Promise<void>;
    get(entryId: number, channel: string): Promise<ChannelContent | null>;
    list(entryId: number): Promise<Array<{ name: string; mimetype: string; state: ChannelState; tokens: number }>>;
}

type ChannelState = "static" | "active" | "closed" | "errored";
interface ChannelContent { content: string; mimetype: string; state: ChannelState; tokens: number; }
```

`append` MUST fire a `stream/event` notification scoped to the entry's session (engine wires this through `ctx.notify`; schemes do not call `notify` directly for content appends). `setState` MUST fire the same notification.

### §4.3 `visibility`

The `indexed | hidden` lattice per `(run, entry, channel)`.

```ts
interface VisibilityApi {
    show(entryId: number, channel?: string): Promise<ShowHideResult>;  // omit channel = all channels
    hide(entryId: number, channel?: string): Promise<ShowHideResult>;
    get(entryId: number, channel: string): Promise<{ indexed: 0 | 1 } | null>;
}

interface ShowHideResult { status: 200 | 304 | 404; }
```

Visibility writes are per-run (`ctx.runId`); the entry itself doesn't have global visibility, only per-run views.

### §4.4 `tags`

Entry tag management. Tags are entry-attached; visible across runs.

```ts
interface TagsApi {
    add(entryId: number, tags: string[]): Promise<void>;  // idempotent
    remove(entryId: number, tags: string[]): Promise<void>;
    list(entryId: number): Promise<string[]>;
}
```

### §4.5 `subscriptions`

Cancellation routing for streaming schemes. The subscription record is the engine's handle for `SEND[499](path)` cancellation.

```ts
interface SubscriptionsApi {
    open(entryId: number, handle: string): Promise<number>;  // returns subscription id; handle is opaque, owned by scheme
    close(subscriptionId: number, status: number): Promise<void>;  // idempotent
    findActive(entryId: number): Promise<{ id: number; scheme: string; handle: string } | null>;
}
```

`handle` is the scheme's own teardown identifier (subprocess pid, WebSocket id, fetch AbortController key). The engine doesn't interpret it — when `SEND[499](path)` arrives, engine resolves the entry, finds the active subscription, returns the handle to the scheme via the cancellation path (typically the scheme's own `send` handler with status 499).

### §4.6 `proposals`

Side-effect deferral. A scheme that defers (sh, file edits, ask_user) emits a proposed entry; the client accepts/rejects via RPC; engine routes the resolution back to the scheme's `onProposalAccepted` / `onProposalRejected` hooks.

```ts
interface ProposalsApi {
    create(pathname: string, proposal: ProposalRecord): Promise<{ status: 202; proposalId: number; entryId: number }>;
}

interface ProposalRecord {
    body: string;
    attributes: Record<string, unknown>;  // e.g., { command: "ls -la" } for sh, { patch: "..." } for file
    summary?: string;  // optional client-facing summary
}
```

Lifecycle:

1. Scheme's op handler calls `ctx.proposals.create(pathname, {body, attributes})` and returns `{status: 202, ...}`.
2. Engine writes a state=proposed entry at `pathname`, emits `proposal/pending` notification.
3. Client receives, calls `op.resolve(pathname, accept: boolean)` via RPC.
4. On accept: engine invokes `scheme.onProposalAccepted(pathname, proposalRecord, ctx)`. The scheme executes the side effect and returns an `OpResult`. Engine transitions entry to `state=resolved` with the returned status.
5. On reject: engine invokes `scheme.onProposalRejected(pathname, proposalRecord, ctx)` (cleanup hook; usually empty). Engine transitions entry to `state=cancelled`. No re-invocation of the op handler.

`yolo` flag short-circuits proposals: when set, engine treats every `{status: 202}` return as immediate execution by calling `onProposalAccepted` inline.

### §4.7 `crossScheme`

Read-only access to entries owned by other schemes. Used in COPY/MOVE source-reads; engine wires this through the destination scheme's `readEntry`.

```ts
interface CrossSchemeApi {
    readEntry(scheme: string, pathname: string): Promise<EntryData | null>;
}
```

No write access. Cross-scheme writes are orchestrated by the engine, not initiated by schemes.

### §4.8 `notify`

Stream-event notification for content changes. Schemes that append content or transition state outside the `channels` API (rare; usually `channels.append` does it automatically) can fire manually.

```ts
interface NotifyApi {
    streamEvent(entryId: number, channel: string, state: ChannelState, contentLength: number): void;
}
```

---

## §5 Op handler contracts

Each op method receives `(statement, ctx)` and returns `Promise<OpResult>`. Op-specific result shapes:

### §5.1 `edit(statement: EditStatement, ctx): Promise<EditResult>`

Create or update an entry's body channel (or fragment-targeted channel).

```ts
interface EditResult {
    status: 200 | 201 | 400 | 404 | 415 | 501;
    entryId: number | null;
    channel: string | null;
}
```

- 201: new entry created.
- 200: existing entry updated (body replaced).
- 400: bad statement shape (null path, unknown channel via fragment).
- 404: fragment-targeted EDIT against non-existent entry.
- 415: mimetype mismatch against scheme manifest.
- 501: `lineMarker` present (line-targeted EDIT not in v0).

Default-channel EDIT writes the scheme's `defaultChannel` plus a `preview` companion (when the scheme manifest declares one). Fragment-targeted EDIT writes only the named channel.

### §5.2 `read(statement: ReadStatement, ctx): Promise<ReadResult>`

Return a channel's content.

```ts
interface ReadResult {
    status: 200 | 400 | 404 | 501;
    content: string | null;
    mimetype: string | null;
    channel: string | null;
}
```

- 200: returns `content`, `mimetype`, `channel`.
- 400: bad statement.
- 404: no entry or no channel at path.
- 501: `lineMarker`, body matcher, or non-empty tag filter on READ.

### §5.3 `show(statement, ctx): Promise<ShowHideResult>` / `hide(statement, ctx)`

Flip visibility. Fragment-less = all channels of the entry; fragment-targeted = named channel only.

```ts
interface ShowHideResult { status: 200 | 304 | 400 | 404 | 501; }
```

- 200: flipped at least one channel.
- 304: no change (already at requested state).
- 400: bad statement.
- 404: entry doesn't exist.
- 501: lineMarker / body / non-empty tag signal on SHOW/HIDE.

### §5.4 `find(statement: FindStatement, ctx): Promise<FindResult>`

Search the scheme's namespace by glob + tag filter.

```ts
interface FindResult {
    status: 200 | 400 | 501;
    content: string | null;  // newline-joined `scheme://pathname` list
    mimetype: "text/plain";
    results: string[];  // pathnames as `scheme://...`
}
```

- 200: returns results (possibly empty).
- 400: null path.
- 501: matcher dialect other than `glob` (regex/xpath/jsonpath are reserved for v1).

### §5.5 `send(statement: SendStatement, ctx): Promise<SendResult>`

Status-coded interaction. Semantics per SPEC §3.5 catalogue:

- `SEND[410](path)`: delete the resource. Returns 200/404/400.
- `SEND[499](path)`: cancel active subscription. Returns 200/404/501.
- `SEND[200|499](no path)`: turn broadcast (engine-handled, not scheme-handled).
- Other status codes against entry-bearing schemes: 501 by default.

```ts
interface SendResult {
    status: number;
    error?: string;
    [key: string]: unknown;
}
```

### §5.6 `exec(statement: ExecStatement, ctx): Promise<ExecResult>`

Execute (subprocess, remote call, etc.). Specific to `exec://`-style schemes. Returns status + reference to output channels.

```ts
interface ExecResult {
    status: number;
    entryId?: number;
    error?: string;
}
```

---

## §6 CRUD primitives (cross-scheme orchestration)

`readEntry`, `writeEntry`, `deleteEntry` are the engine's uniform handles for cross-scheme COPY/MOVE/SEND[410] (SPEC §3.2, §6.4, §6.5). Every entry-bearing scheme MUST implement them.

```ts
interface ReadEntryResult { status: 200 | 404; entry: EntryData | null; }
interface WriteEntryResult { status: 200 | 201 | 409 | 415; entryId: number | null; created: boolean; }
interface DeleteEntryResult { status: 200 | 404; }
```

Promises:

- `readEntry` returns the full entry shape (all channels, all tags) or `{status: 404, entry: null}`.
- `writeEntry` accepts a full entry shape and persists. 201 = new, 200 = replaced, 409 = scheme policy forbids overwrites, 415 = mimetype mismatch against manifest.
- `deleteEntry` removes the entry (and all related rows via CASCADE).

Logging-only schemes (`log://`) MAY omit CRUD primitives — they're not COPY/MOVE destinations. The engine returns 501 for cross-scheme ops against schemes without CRUD.

---

## §7 Lifecycle

### §7.1 Action-entry-as-outcome

Iron rule (from rummy SPEC §failure_reporting). The action's log entry IS its outcome. The scheme finalizes the log_entries row with body, state, and outcome. Success and failure are two values of the same shape — only field values change.

```
EDIT(known://x):body:EDIT → log entry at log://<L>/<T>/<S>/EDIT
                            success: status=201, rx={status:201, entryId:N, channel:"body"}
                            failure: status=400, rx={status:400, error:"..."}
```

The scheme handler does not call a separate `error.log.emit`. The handler returns its result; engine writes the log entry with that result.

**Actionless failures** — failures with no action context to bind to — are not stored as scheme entries. They surface as transient telemetry in the NEXT turn's `packet.user.telemetry.errors[]` (see SPEC §15 Packet shape). Sources:

- Dispatch crashes (handler threw before producing a result; engine catches and surfaces).
- Parser failures (no statement could be parsed; turn produced no actions).
- Watchdog firings (abort timeout, stream timeout).
- Budget overflow (pre-dispatch rejection).
- Engine rail violations (cycle detected, strike threshold reached, missing terminal SEND).

The model is forced to confront these — they sit in `user.telemetry`, prominently, at the bottom of the user-section of the next packet. No `error://` namespace exists.

### §7.2 Channel state machine

`ChannelContent.state ∈ {static, active, closed, errored}`. Scheme owns transitions.

- `static`: write-once content. EDIT-written entries default here.
- `active`: streaming, content appending. Streaming schemes (sse, exec) transition body channel to `active` at start.
- `closed`: stream completed cleanly.
- `errored`: stream terminated abnormally.

Engine does NOT branch on state during render (SPEC §5.6 {§5.6-engine-does-not-branch-on-state}). The model sees current content and current state on every turn.

### §7.3 Proposal state machine

Entry state for proposal lifecycle:

- `proposed`: entry exists with body + attributes + status 202. Visible to client (for review) but not yet enacted.
- `resolved`: client accepted; scheme's `onProposalAccepted` ran; side effect happened. Entry status = whatever the accepted op returned (200/201/etc.).
- `cancelled`: client rejected. Scheme's `onProposalRejected` ran (cleanup). Entry kept for forensics.

---

## §8 Engine → scheme guarantees

- `ctx` is constructed fresh per call. No mutation across calls.
- `ctx.writer` reflects the actual writer at this dispatch (`"model"` when the model emitted the op, `"client"` for RPC origin, etc.).
- `manifest.writableBy` is checked BEFORE the scheme is called. A scheme handler is never invoked for a writer outside the allowed set; the engine returns 403 directly.
- `ctx.signal` is wired to the run's AbortController. Scheme honors it for any long-running work.
- The engine catches exceptions from scheme handlers and finalizes the action-entry with status 500 (action-entry-as-outcome §7.1). A summary line is also added to the next turn's `packet.user.telemetry.errors[]`. The scheme MAY rely on the engine's catch but SHOULD return result-shaped errors when possible.
- Cross-scheme orchestration (COPY/MOVE) goes through `readEntry` + `writeEntry` + `deleteEntry`. The op-method `copy`/`move` does NOT exist on schemes; engine drives the primitives.

---

## §9 Scheme → engine guarantees

- **Manifest is truthful.** `name`, `channels`, `defaultChannel`, `writableBy` reflect actual behavior.
- **No engine access (in third-party packages).** No imports from `@plurnk/plurnk-service`. Sanctioned imports: `@plurnk/plurnk-grammar`, `node:` built-ins, pure-function NPM dependencies. (In-tree bundled schemes import from sibling scheme helpers — `_entry-*.ts` — which is a v0 convention; v1 ctx absorbs these via the namespaced API.)
- **No direct DB (v1).** In v1, schemes touch `ctx.entries`/`ctx.channels`/etc., not raw SQL. In v0, in-tree schemes use `ctx.db` via the shared `_entry-*.ts` helpers; third-party schemes should still avoid raw `Db` even now (the toolkit functions are the supported surface).
- **No cross-scheme writes.** Schemes can `crossScheme.readEntry` but cannot write or delete in another scheme's namespace. Cross-scheme COPY/MOVE goes through engine orchestration via this scheme's `readEntry` and the destination scheme's `writeEntry`.
- **CRUD primitives are mandatory** for entry-bearing schemes. `readEntry`/`writeEntry`/`deleteEntry` MUST be implemented; logging-only schemes MAY omit them.
- **Op handlers honor `ctx.signal`.** Long-running work checks `signal.throwIfAborted()` periodically; aborted ops reject (or return an aborted-status result).
- **Action-entry-as-outcome.** Scheme returns its op result; engine writes the log. No side-channel logging.
- **Proposal hooks are paired.** If `onProposalAccepted` is implemented, `onProposalRejected` SHOULD be too (even if no-op) for cleanup symmetry.

---

## §10 Forbidden

| ❌ |
|---|
| Direct database access (`node:sqlite`, `@possumtech/sqlrite`) — in-tree schemes use `ctx.db` via the `_entry-*.ts` toolkit; third-party schemes await the v1 namespaced API |
| Imports from `@plurnk/plurnk-service/*` (third-party schemes) |
| Writes outside the scheme's own namespace (`ctx.crossScheme.readEntry` is read-only) |
| Direct invocation of peer schemes |
| Direct mutation of `ctx` |
| Holding `ctx` references past the op handler's return |
| Reading or writing log_entries directly (engine owns the log; scheme's outcome flows back through return value) |
| Calling engine-internal methods, even via reflection |
| Writing to `console`, stdout, stderr |
| Spawning subprocesses unless the scheme is specifically a subprocess scheme (`exec://`-style) |
| Opening network connections unless the scheme is specifically a network scheme (`http://`-style) |
| Caching across ops invocations (state in instance fields beyond config) |

---

## §11 Reference — `known` (entry-bearing, in-tree)

Bundled at `src/schemes/Known.ts` plus shared toolkit in `src/schemes/_entry-*.ts`. Pattern:

```ts
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";

export default class Known {
    static manifest: SchemeManifest = {
        name: "known",
        channels: { body: "text/markdown", preview: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
    };

    async readEntry(pathname: string, ctx: PlurnkSchemeContext) {
        return readEntry(pathname, ctx, MyScheme.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext) {
        return writeEntry(pathname, entry, ctx, MyScheme.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext) {
        return deleteEntry(pathname, ctx, MyScheme.manifest.name);
    }

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext) {
        return editSessionEntry(statement, ctx, MyScheme.manifest);
    }
    async read(statement: ReadStatement, ctx) {
        return readSessionEntry(statement, ctx, MyScheme.manifest);
    }
    async show(statement: ShowStatement | HideStatement, ctx) {
        return showSessionEntry(statement, ctx, MyScheme.manifest);
    }
    async hide(statement: ShowStatement | HideStatement, ctx) {
        return hideSessionEntry(statement, ctx, MyScheme.manifest);
    }
    async find(statement: FindStatement, ctx) {
        return findSessionEntries(statement, ctx, MyScheme.manifest.name);
    }
    async send(statement: SendStatement, ctx) {
        return sendToSessionEntry(statement, ctx, MyScheme.manifest.name);
    }
}
```

The shared `_entry-crud.ts` / `_entry-ops.ts` / `_entry-send.ts` / `_entry-find.ts` helpers in plurnk-service are the toolkit a session-entry scheme uses (look at `Known.ts` / `Unknown.ts` / `Skill.ts` for the actual pattern). When schemes are extracted to separate packages, these helpers either ship as `@plurnk/plurnk-schemes-toolkit` or get folded into v1's `ctx.entries` namespace.

---

## §12 Reference — `log` (logging, read-only)

Bundled at `src/schemes/Log.ts`. Logging-only schemes implement no CRUD primitives (logs are not COPY/MOVE destinations) and only the `read` op:

```ts
static manifest: SchemeManifest = {
    name: "log",
    channels: {},  // logs render through scheme.read, not channel storage
    defaultChannel: "",
    category: "logging",
    scope: "session",
    writableBy: ["system"],  // only engine writes logs
    volatile: false,
    modelVisible: true,
};

async read(statement: ReadStatement, ctx: PlurnkSchemeContext) {
    // Parse log://<L>/<T>/<S> coordinate, return the log entry's contents.
}
```

---

## §13 Reference — streaming scheme (future `sse` shape)

Pattern for streaming schemes — append content to an active channel, register a subscription handle, transition state on close:

```ts
async send(statement, ctx) {
    // SEND[499] = cancel
    if (statement.signal === 499) {
        const entry = await ctx.entries.read(pathnameOf(statement));
        const sub = await ctx.subscriptions.findActive(entry.entryId);
        if (sub) {
            this.#teardown.get(sub.handle)?.();  // scheme-local cleanup map
            await ctx.subscriptions.close(sub.id, 499);
            await ctx.channels.setState(entry.entryId, "data", "closed");
        }
        return { status: 200 };
    }
    return { status: 501 };
}

async startStream(ctx, pathname) {
    // EDIT-time or proposal-accept-time entry creation + subscription open
    const entry = await ctx.entries.write(pathname, { ... }, { state: "active" });
    const handle = `${Date.now()}`;
    const subId = await ctx.subscriptions.open(entry.entryId, handle);
    const controller = new AbortController();
    this.#teardown.set(handle, () => controller.abort());

    // Drive the wire protocol; on each chunk:
    //   await ctx.channels.append(entry.entryId, "data", chunk);  // fires stream/event
    // On natural close:
    //   await ctx.channels.setState(entry.entryId, "data", "closed");
    //   await ctx.subscriptions.close(subId, 200);
}
```

---

## §14 Conformance

`@plurnk/plurnk-scheme-conformance` (TBD) verifies:

1. `Class.manifest.name === packageJson.plurnk.name`.
2. Manifest validates: `channels` non-empty (or empty for dynamic-mimetype schemes), `defaultChannel` is a channel key (or empty), `writableBy` is a non-empty subset of valid writers, `category` ∈ {data, logging}, `scope` ∈ {agent, session}.
3. For entry-bearing schemes: `readEntry`, `writeEntry`, `deleteEntry` exist and return the documented shapes.
4. Op handlers (when present) return result shapes documented in §5.
5. Writing through `ctx.entries.write` then reading through `ctx.entries.read` returns the same data round-trip.
6. `writableBy` enforcement: engine rejects writes from unauthorized writer; the scheme handler is NOT invoked.
7. Cross-scheme: `crossScheme.readEntry(other_scheme, path)` returns valid `EntryData` or `null`.
8. No filesystem, network, env, subprocess, or `console` access during the pack (excepting schemes whose role is filesystem/network/subprocess).
9. No imports from `@plurnk/plurnk-service`.
10. Action handlers honor `ctx.signal`: aborted op returns within 5s.

Scheme-specific behavioral tests live in the scheme package's own test surface.

---

## §15 Bundled

| Path | Scheme | Category | Notes |
|---|---|---|---|
| `src/schemes/Known.ts` | `known` | data | Session-scoped, model-writable, body+preview channels |
| `src/schemes/Unknown.ts` | `unknown` | data | Session-scoped open questions; same shape as known |
| `src/schemes/Skill.ts` | `skill` | data | Session-scoped skill docs; same shape as known |
| `src/schemes/Log.ts` | `log` | logging | Read-only; logs addressable as `log://<L>/<T>/<S>` |
| `src/schemes/File.ts` | `file` | data | Filesystem-backed; dynamic mimetype per file extension |
| `src/schemes/Exec.ts` | `exec` | data (volatile) | Subprocess execution; streaming stdout/stderr channels |
| `src/schemes/Plurnk.ts` | `plurnk` | logging | Meta-scheme; protocol management, scheme registration |

Note: actionless-failure routing does NOT use a scheme. Failures with no action context surface in `packet.user.telemetry.errors[]` (SPEC §15.1) — presentation concern, not storage namespace.

Future schemes expected (separate packages):

| Package | Scheme | Notes |
|---|---|---|
| `@plurnk/plurnk-schemes-https` | `https` | Web fetch; body + headers channels |
| `@plurnk/plurnk-schemes-sse` | `sse` | Server-Sent Events streams; volatile |
| `@plurnk/plurnk-schemes-wiki` | `wiki` | Wikipedia / external knowledge; agent-scoped |
| `@plurnk/plurnk-schemes-search` | `search` | Web search — fills the RAG-style retrieval gap |

---

## §16 Open

- **v1 PlurnkSchemeContext (namespaced).** v0 ctx is the flat struct (§4). The v1 namespaced surface (`ctx.entries`, `ctx.channels`, `ctx.visibility`, `ctx.tags`, `ctx.subscriptions`, `ctx.proposals`, `ctx.crossScheme`, `ctx.notify`) is forward-spec until third-party plugin schemes are an actual concern. Migration: wrap the existing toolkit functions in namespaced methods; seal `db` out of the public ctx surface.
- **Proposal lifecycle wiring.** RPC `op.resolve(pathname, accept)`, `proposal/pending` notification, engine routing. Phase E.
- **Scheme-toolkit boundary at extraction time.** When schemes extract to separate packages, the question is whether `_entry-crud.ts` etc. ship as `@plurnk/plurnk-schemes-toolkit` or get absorbed entirely into `ctx.entries`/`ctx.channels`. Probably the latter — the toolkit's surface IS the context's surface; the helpers' implementations belong in plurnk-service as the context backend.
- **Dynamic mimetype schemes.** File and exec carry per-call mimetypes. Manifest `channels: {}` is one signal; per-call mimetype in `entry.channels[name].mimetype` is another. The shape needs a clean expression — possibly `channels: { body: null }` to mean "this channel exists, mimetype is dynamic per-call."
- **`onProposalAccepted` return shape.** Currently typed as `OpResult` (status + arbitrary fields). The exact shape depends on the original op being proposed — a `set` proposal accept returns `{status: 200, entryId}`; an `sh` proposal accept returns subprocess result. May need to be op-specific or remain loose.
