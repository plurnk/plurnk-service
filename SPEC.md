# plurnk-service — Specification

Single source of truth for what plurnk-service IS — the contracts it exposes, the architecture it implements, the promises it makes to the rest of the constellation (`plurnk-grammar`, `plurnk-providers-*`, `plurnk-schemes-*`, `plurnk-mimetypes-*`, the user-facing `plurnk` CLI). `AGENTS.md` covers how we work on it; this file covers what we're working on.

Section numbers are stable. Future anchor-to-test wiring binds individual promises here to integration / live / demo tests, giving semi-deterministic specification-testing alignment.

Floor scope is green (capstone intg test exercises every non-EXEC DSL op end-to-end). This document evolves with each phase; the upcoming mimetype / channel-state / transaction-lifecycle work will surface refinements to §4 / §5 / §7.

---

## §1 Architecture

`plurnk-service` is an engine library plus an admin CLI. The engine orchestrates a model's interaction with a workspace through three plug points:

- **Providers** (§2) — LLM transports. The engine asks a provider for the next assistant turn; the provider returns parsed plurnk ops.
- **Schemes** (§3) — addressable resources. Every plurnk op targets a URI; the URI's scheme picks the handler. Schemes own their storage substrate (SQL entries for `known`/`unknown`/`skill`; filesystem for `file`; subprocess for `exec`; remote endpoints for future `http`/`ws`/`sse`/etc.).
- **Mimetypes** (§4) — content interpretation. Schemes produce content with a declared mimetype; mimetype handlers validate, summarize, and render that content for the model's index view.

The engine itself is small. It dispatches ops, persists state to SQLite, orchestrates cross-scheme operations (COPY/MOVE — see §6.4/§6.5), and writes the log. All substantive behavior lives in the three plug points.

The grammar — `@plurnk/plurnk-grammar` — is the parser and AST contract. Engine receives parsed `PlurnkStatement[]` from providers; engine does not re-parse. Schemes receive statement fragments via dispatch.

Client/server posture: this package is the server / core / agent runtime. The user-facing CLI lives in a separate `plurnk` repo and consumes plurnk-service through its public library API (`src/index.ts` + `PATHS` helper).

---

## §2 Provider Contract

A provider transports model interactions. It exposes one required method (generate) and one mandatory token-counting method. Every `@plurnk/plurnk-providers-*` package implements this contract.

### §2.1 Manifest

Each provider package declares itself in its `package.json`:

```json
{
  "name": "@plurnk/plurnk-providers-<name>",
  "plurnk": { "kind": "provider", "name": "<name>" }
}
```

`name` is the lookup key. Collisions on `(kind, name)` are fail-hard at boot per §9.

### §2.2 generate(args) — required

```ts
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ProviderResponse = {
    assistant: {
        tokens: number;                  // completion-token count for this turn
        content: string;                 // raw text from the model
        ops: PlurnkStatement[];          // parsed plurnk ops; see grammar AST
        reasoning: string | null;        // thinking/reasoning payload if the model emitted one
    };
    assistantRaw: unknown;               // provider's raw wire response for forensic capture
};

generate({ messages, signal? }: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse>;
```

Promises:
- The provider returns parsed `PlurnkStatement[]` in `assistant.ops`. The engine does NOT re-parse. Provider is responsible for invoking `@plurnk/plurnk-grammar`'s parser against `assistant.content`.
- `assistant.tokens` is the completion token count for THIS turn — used for cost accounting and packet token tracking.
- `assistantRaw` preserves the wire response verbatim for log forensics. Schema-free; provider's discretion.
- If `signal` aborts, the provider MUST tear down its connection and reject the promise. AbortController lifecycle is the provider's responsibility.

### §2.3 countTokens(text) — required

```ts
countTokens(text: string): Promise<number>;
```

Promises:
- Returns the token count for `text` according to the active model's tokenizer.
- The engine treats this as authoritative — there is no fallback estimator at the engine layer.
- Provider implementations MAY cache by content hash; the engine ALSO caches by `(provider_id, content_hash)` in a `token_counts` table.
- Mock provider returns a deterministic length-based estimate (e.g., `len/4`) sufficient for integration tests.

### §2.4 Cancellation

Every provider call accepts an optional `AbortSignal`. When aborted:
- The provider's outbound connection MUST tear down.
- The promise MUST reject (not resolve with partial content).
- Any provider-internal streams MUST close cleanly.

---

## §3 Scheme Contract

A scheme is an addressable resource handler. Every URI in plurnk has a scheme prefix (`known://`, `file://`, `https://`, etc.); the scheme handler interprets paths under that prefix.

Every `@plurnk/plurnk-schemes-*` package implements this contract.

### §3.1 Manifest

Each scheme package declares itself in its `package.json`:

```json
{
  "name": "@plurnk/plurnk-schemes-<name>",
  "plurnk": { "kind": "scheme", "name": "<name>" }
}
```

The class additionally declares its channel topology statically:

```ts
class Known {
    static channels: Record<string, string> = {
        body: "text/markdown",
        preview: "text/markdown",
    };
    static defaultChannel = "body";
    // ...
}
```

Each entry in `channels` names a channel and pins its mimetype. The engine consults this manifest before writing channels. Schemes whose mimetypes are content-dynamic (file, eventually exec) supply mimetype per-call instead; the engine accepts either path but never accepts an unset mimetype (see §5).

`defaultChannel` is REQUIRED for any scheme that accepts EDIT or READ on fragment-less paths. It names which channel of the entry is targeted when the path has no `#fragment`. See §5.5 for the channel-selection semantic.

### §3.2 CRUD Primitives (uniform across schemes)

The canonical surface a scheme exposes for engine orchestration. Every entry-bearing scheme MUST implement these three methods. The engine uses them to drive cross-scheme operations (§6.4 COPY, §6.5 MOVE) and the SEND[410] delete pattern (§6.8).

```ts
type EntryShape = {
    channels: Record<string, { content: string; mimetype: string }>;
    tags: string[];
};

read({ db, path, ctx }): Promise<{ status: number; entry: EntryShape | null }>;
write({ db, path, entry, ctx }): Promise<{ status: number; created: boolean }>;
delete({ db, path, ctx }): Promise<{ status: number }>;
```

Promises:
- `read` returns the full entry shape at `path` or `{ status: 404, entry: null }`.
- `write` accepts a full entry shape and persists it under `path`. Returns `{ status: 201, created: true }` for new entries; `{ status: 200, created: false }` for replaces — UNLESS the scheme's policy forbids overwrites, in which case it returns `{ status: 409, created: false }`. See §6.4 for the COPY/MOVE conflict policy.
- `delete` removes the entry at `path`. Returns 200 on success, 404 if absent.
- Validation: `write` MUST verify channel mimetypes against the scheme's manifest (§3.1) and crash on mismatch. No defaults, no coercion (see §5 Channel Topology).
- Atomicity: each method is a single SQL transaction. Engine orchestration (COPY = read + write) is responsible for its own outer transaction.

### §3.3 Op Methods (layered over CRUD)

The DSL-facing methods the engine dispatches based on parsed `PlurnkStatement.op`. Each method receives a context object including the parsed statement, the DB handle, and run/session IDs.

```ts
edit(ctx):   Promise<{ status: number; entryId: number | null }>;
read_op(ctx): Promise<{ status: number; channels: ...; mimetype: string | null }>;
show(ctx):   Promise<{ status: number }>;
hide(ctx):   Promise<{ status: number }>;
find(ctx):   Promise<{ status: number; results: string }>;
send(ctx):   Promise<{ status: number }>;
```

Note: `read_op` is the op-level method; the CRUD primitive is also named `read`. In practice the engine routes `op === "READ"` to the op method; cross-scheme orchestration uses the CRUD primitive. Implementations MAY share code between them.

COPY and MOVE are NOT scheme methods. They are engine orchestrations over CRUD primitives (§6.4, §6.5).

### §3.4 Cross-scheme orchestration

The engine — not any individual scheme — handles cross-scheme COPY and MOVE:

```
copy(source_path, dest_path, signal_tags):
    src_scheme = scheme_for(source_path)
    dst_scheme = scheme_for(dest_path)
    entry = src_scheme.read({ path: source_path })
    if entry == null: return 404
    if dst_scheme already has dest_path: return 409
    if not mimetype_compatible(entry, dst_scheme): return 415
    new_entry = { ...entry, tags: signal_tags ?? entry.tags }
    dst_scheme.write({ path: dest_path, entry: new_entry })

move(source_path, dest_path, signal_tags):
    copy(source_path, dest_path, signal_tags)
    src_scheme.delete({ path: source_path })
```

Same- and cross-scheme operations follow the identical orchestration. Same-scheme COPY (e.g., `known://a` → `known://b`) is NOT a special case — it is COPY where src_scheme and dst_scheme happen to be the same handler. The engine does not optimize this case; uniformity beats local efficiency at this layer.

For v0 (known/unknown/skill, all sharing the `entries` table), CRUD primitives are thin wrappers over entry-table operations. For future schemes (file, exec, http), the same orchestrator drives the same primitives over different storage substrates.

### §3.5 SEND dispatch (status-code-as-verb)

When the engine dispatches a `SEND` op with a non-null path (recipient-directed SEND), the target scheme's `send` method receives the statement. The scheme interprets the status code as an intent:

- `SEND[200](path)` — write the body into the resource at `path` (e.g., WebSocket message, exec stdin).
- `SEND[410](path)` — delete the resource at `path`. Scheme calls its own `delete` primitive.
- `SEND[499](path)` — cancel any active subscription bound to `path` (§7).

Other status codes are scheme-specific. The engine does not interpret SEND status codes for directed (non-broadcast) sends.

`SEND` with null path is broadcast (§6.7) — engine-handled, not scheme-handled.

---

## §4 Mimetype Contract

A mimetype handler interprets channel content for validation, structural extraction, and preview rendering. Every `@plurnk/plurnk-mimetypes-*` package implements this contract.

### §4.1 Manifest

```json
{
  "name": "@plurnk/plurnk-mimetypes-<name>",
  "plurnk": { "kind": "mimetype", "name": "<mimetype-id>" }
}
```

`<mimetype-id>` follows IANA conventions (`text/plain`, `application/json`, `text/vnd.<vendor>`, etc.). Collisions fail-hard at boot per §9.

The handler class declares two required identifiers as instance properties:

```ts
class TextMarkdown implements MimetypeHandler {
    readonly mimetype = "text/markdown";
    readonly glyph = "📝";
    // ... methods (§4.2)
}
```

`mimetype` is the IANA-shaped identifier — must match the manifest `name`. `glyph` is a single emoji representing this mimetype, used by clients rendering log waterfalls, channel tiles, and any structural index. Every handler MUST declare both. The engine treats an absent `glyph` as a contract violation at registration time, parallel to absent `mimetype`.

### §4.2 Methods

```ts
validate(content: string): void;
symbols(content: string): string;
preview(content: string, budget: number): string;
```

Promises:
- `validate` throws on shape mismatch. For text/plain and text/markdown, every string validates (identity). For application/json, content must parse via `JSON.parse`. For text/vnd.plurnk, content must parse via the grammar.
- `symbols` returns a structural index of the content — what goes in the preview channel (§5). For text/markdown, this is the heading outline. For application/json, the top-level key tree. For text/plain, an empty string (no structure).
- `preview` returns a budget-bounded structural summary. `budget` is a character-count hint (not strictly enforced; handler does its best). For text/plain, head-truncation. For text/markdown, heading outline. For application/json, depth-limited key tree.

### §4.3 What mimetype handlers do NOT do

- **Tokenization.** Token counting is provider-bound (§2.3). Mimetype handlers describe structure; tokenizers count tokens.
- **Storage.** Mimetype handlers are pure functions over content strings. They neither read nor write the DB.
- **Streaming.** Mimetype handlers operate on whatever content is current when invoked. The streaming relationship (§7) is between schemes and the subscription registry; mimetype handlers don't see it.

### §4.4 Bundled handlers

`text/plain` and `text/markdown` ship in `plurnk-service`'s `src/mimetypes/`. `application/json` and the DSL mimetype (`text/vnd.plurnk` pending grammar issue #6; currently `text/x-plurnk`) land when they have consumers — not before. See §10.

Locked glyph assignments for the bundled set:

| Mimetype                          | Glyph | Rationale                                                       |
|-----------------------------------|-------|-----------------------------------------------------------------|
| `text/plain`                      | 📄    | Page-facing-up — generic content, no structure                  |
| `text/markdown`                   | 📝    | Memo with pencil — narrative writing                            |
| `application/json` *(deferred)*   | 🗂    | Card index dividers — structured data                           |
| `text/vnd.plurnk` *(deferred)*    | 📜    | Scroll — a scripted instruction set, HEREDOC-shaped             |

Deferred handlers reserve their glyphs now so external packages don't collide.

---

## §5 Channel Topology

Every entry has named channels. Channels are the unit of stored content; mimetype handlers operate on channels; visibility is per-channel.

### §5.1 Per-entry channels

EDIT writes a minimum of two channels per entry, in one transaction:

- **`body`** — the raw content.
- **`preview`** — the structural summary. For v0, populated as `preview = body` verbatim (placeholder); the mimetype handler's `symbols(content)` populates it once handlers land for the relevant mimetype.

Schemes MAY declare additional channels (exec will declare `stdout`/`stderr`; file may declare an `outline` channel; etc.). Each additional channel goes in the scheme's `channels` manifest (§3.1) and has its mimetype pinned there.

### §5.2 Visibility lattice

Visibility is per-`(run, entry, channel)` — a bit per cell in the `visibility` table. EDIT-creating-new sets `indexed=1` for every channel of the new entry in the current run. SHOW flips all channels of the target entry to `indexed=1`; HIDE flips all to `indexed=0`. (Channel-specific SHOW/HIDE selectors are out of scope for v0 — the grammar lacks the surface.)

### §5.3 Mimetype is a (scheme, channel) property — never a default

The mimetype of a channel is declared by the scheme's manifest (§3.1) or — for dynamic schemes — supplied per-call. If the engine attempts to write a channel without a declared mimetype, it throws. There is no default mimetype anywhere in the system. This is a reinforcement of the no-fallbacks rule at the channel layer.

Implications:
- Cross-mimetype COPY/MOVE crashes (`415 Unsupported Media Type`) — never coerces. See §6.4.

### §5.4 Orientation hint

The grammar's `SchemeRegistration.channel_orientations` declares each scheme's channels as `head` or `tail` — "which end of the content matters for preview." Mimetype handlers consult this hint when truncating. Channels not listed default to `head`. Per grammar 0.3.0.

### §5.5 Channel selection in the DSL

The DSL targets a specific channel of an entry via the URL **fragment** — the `#name` segment of the path. Per the grammar's `UrlPath` shape (0.3.0+), every parsed path has a nullable `fragment` field; this section defines its semantic for the engine.

Rules:

1. **Fragment-less paths target the scheme's `defaultChannel`.** For `known` / `unknown` / `skill` that's `body`. The path `known://philosophy/meaning` writes/reads the body channel of that entry; equivalent to `known://philosophy/meaning#body` made explicit.
2. **Paths with a fragment target the named channel.** `known://philosophy/meaning#preview` targets the preview channel.
3. **Unknown channel name → 404 (channel not found) or 400 (bad request) per the scheme's error policy.** The channel name must appear in the scheme's `channels` manifest (§3.1). Engine never writes to an undeclared channel.
4. **Schemes without `defaultChannel` reject fragment-less EDIT/READ.** Streaming schemes like `sse://feed/x` may require an explicit fragment (`#data`, `#error`, etc.) and have no default.

Examples:

| URI | Scheme's interpretation |
|---|---|
| `known://france/capital` | body channel of the entry (text/markdown) |
| `known://france/capital#preview` | preview channel (text/markdown structural summary) |
| `exec://run/abc#stdout` | stdout channel of the exec invocation |
| `exec://run/abc#stderr` | stderr channel |
| `sse://feed/y#data` | named channel for the SSE "data" event type (§7) |
| `log://N/T/A` | log entry at coordinates; no channel concept (log entries are atomic rows) |

Implications for operations:

- **EDIT** writes the body to the resolved channel. If the channel doesn't exist in the manifest → 400. If the scheme doesn't support EDIT to that channel (e.g., exec stdout is read-only) → 405.
- **READ** returns content + mimetype from the resolved channel.
- **SHOW / HIDE** flip visibility for the resolved channel only — channel-specific visibility is achievable via fragments. Fragment-less SHOW/HIDE flips ALL channels of the entry per §5.2 (existing behavior).
- **COPY / MOVE** with a fragment is a per-channel operation; deferred design pass needed before specifying (out of scope for v0).

The clean-shape RPC params (§13.5) carry the fragment naturally inside the `path` string: `{ path: "known://x#preview" }` works as expected. No new RPC parameter needed; the URL surface handles it.

---

## §6 Op Surface

Per-op semantics for `FIND | READ | EDIT | COPY | MOVE | SHOW | HIDE | SEND | EXEC`. Each subsection includes the AST shape (per `@plurnk/plurnk-grammar`'s `PlurnkStatement` schema), the engine's dispatch behavior, and the promises returned to callers.

### §6.1 EDIT

AST: `{ op: "EDIT", path: ParsedPath, body: string | null, signal: tags | null, lineMarker?: LineMarker }`.

Engine dispatches to `scheme.edit(ctx)`. Scheme:
- Resolves the target channel from the path's fragment (§5.5). Fragment absent → scheme's `defaultChannel`. Unknown channel → 400. Channel manifest-undeclared → engine crashes per §5.3.
- Writes the body to the resolved channel.
- For entry-bearing schemes (known/unknown/skill), also writes the `preview` channel in the same transaction when writing `body` (engine-managed companion; v0 is `preview = body` verbatim per §5.1).
- Indexes the written channels in the current run (visibility = 1).
- Returns `{ status: 201, entryId }` for new entries; `{ status: 200, entryId }` for updates.
- `body: null` clears the content (writes empty string).
- Tags from `signal[]` are applied via `entry_tags` (additive on update for the v0 entry schemes; final policy may vary by scheme).

### §6.2 READ

AST: `{ op: "READ", path: ParsedPath, body: MatcherBody | null, signal: tags | null, lineMarker?: LineMarker }`.

Engine dispatches to `scheme.read_op(ctx)`. Scheme:
- Returns the body channel content + mimetype for `path`, or `{ status: 404 }`.
- `lineMarker` selects a line range (e.g., `<10-20>` for lines 10-20).
- `body` (matcher) is for streaming-scheme deep reads (§7) — not v0 surface for entry schemes.

### §6.3 SHOW / HIDE

AST: `{ op: "SHOW"|"HIDE", path: ParsedPath, body: MatcherBody | null, signal: tags | null, lineMarker?: LineMarker }`.

Engine dispatches to `scheme.show(ctx)` / `scheme.hide(ctx)`. Scheme:
- Flips `visibility.indexed` for every channel of the targeted entry to 1 (SHOW) or 0 (HIDE).
- Returns 200 on transition, 304 on no-op, 404 if entry not found.
- No channel-specific selectors in v0; SHOW/HIDE always affects all channels of the entry.

### §6.4 COPY (engine-orchestrated)

AST: `{ op: "COPY", path: ParsedPath (source), body: ParsedPath (destination), signal: tags | null, lineMarker?: LineMarker }`.

Engine orchestrates over CRUD primitives (§3.2, §3.4):

1. `src_scheme.read({ path: source })` → entry or 404.
2. `dst_scheme.read({ path: dest })` to check conflict — if exists, return **409 Conflict** (no overwrite). Per fail-hard discipline.
3. Mimetype compatibility check — channels of `entry` MUST have mimetypes accepted by `dst_scheme`'s manifest. Mismatch returns **415 Unsupported Media Type**.
4. Tag resolution: if `signal` is non-null, dest tags = signal_tags (REPLACE). If signal is null/empty, dest tags = source tags (CARRY).
5. `dst_scheme.write({ path: dest, entry: { ...entry, tags } })`.
6. Dest visibility indexed=1 in current run (parity with EDIT-creating-new).

Returns `{ status: 201 }` on success.

### §6.5 MOVE (engine-orchestrated)

AST: `{ op: "MOVE", path: ParsedPath (source), body: ParsedPath | null (destination), signal: tags | null, lineMarker?: LineMarker }`.

Two modes:

**Relocation** (`body` non-null): engine runs §6.4 COPY then `src_scheme.delete({ path: source })`. One transaction. Returns 201 on success.

**Deletion** (`body` is null): engine runs `src_scheme.delete({ path: source })` directly. The null-body MOVE expresses "relocate to nowhere" = delete. Returns 200 on success, 404 if source absent.

Log history is preserved through MOVE because `log_entries.target_*` columns store the path tuple as text, not FK to `entries.id`.

### §6.6 FIND

AST: `{ op: "FIND", path: ParsedPath (scope), body: MatcherBody | null (predicate), signal: tags | null (tag filter), lineMarker?: LineMarker }`.

Engine dispatches to `scheme.find(ctx)`. Scheme:
- Filters entries within the path's scope (scheme + pathname prefix).
- Applies `body` matcher if present. v0 supports `glob` dialect over pathname. Other dialects (regex over content, xpath, jsonpath) return **501 Not Implemented** until the relevant infrastructure exists.
- Applies `signal` as a tag filter: only entries with ALL listed tags pass.
- Returns `{ status: 200, results: string }` where `results` is `text/plain` with newline-separated matching paths.

### §6.7 SEND

AST: `{ op: "SEND", path: ParsedPath | null, body: SendBody | null, signal: number | null }`.

Two modes:

**Broadcast** (`path` is null): terminal status (200/499) updates `loop.status` and ends the loop. Other status codes return `{ status }` without state change. The model's universal "talk to the orchestrator" surface.

**Directed** (`path` is non-null): engine dispatches `scheme.send(ctx)`. Scheme interprets `signal` as an intent per §3.5:
- 200 → write `body` into the resource (stream-write, exec stdin, etc.)
- 410 → delete the resource at `path` (scheme calls its own `delete` primitive)
- 499 → cancel active subscription (§7)
- Other → scheme-specific

### §6.8 EXEC

AST: `{ op: "EXEC", path: ParsedPath (cwd), body: string | null (command), signal: string | null (runtime tag) }`.

Deferred. The `exec` scheme is in §10's bundled set but lacks a working handler; calls return 501. Sandboxing design and process-lifecycle semantics are the substance to figure out, drawing on rummy's exec plugin as prior art.

---

## §7 Stream Model

The model can't poll and can't wait for streams to complete. It must stay passively informed of ongoing streams between turns. Fully implementable against grammar 0.3.0 — no contract changes needed.

### §7.1 Subscriptions

READ on a streaming scheme is a subscription, not a one-shot. The scheme handler opens the connection (SSE, WS, exec subprocess, etc.), returns a `102 Processing` log row immediately, and stays alive. The engine wires the open connection into a **run-scoped subscription registry** — plurnk-service runtime state in its own SQLite table; NOT in the grammar's schema.

### §7.2 Chunk accumulation

SSE event types, WS message types, exec stdout/stderr — each maps to a named channel on the entry. Channel record (per grammar's `ChannelContent`): `content`, `mimetype`, `tokens`. Whether a connection is currently feeding the channel is tracked in the subscription registry, not on the channel itself.

### §7.3 No per-chunk log rows

Channels are the single source of truth for chunk content. Log captures **lifecycle events** only: open (`102`), graceful close (`200`), explicit cancel (`499`), errors (`5xx`), scheme-significant transitions.

### §7.4 Index tile rendering

Per-channel previews use `SchemeRegistration.channel_orientations` (grammar 0.3.0). The scheme declares each channel as `"head"` (front-anchored — render from beginning) or `"tail"` (append-temporal — render most recent). Channels not listed default to `"head"`. The renderer (plurnk-service code) decides token budget via `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` (§12).

### §7.5 Deep slices on demand

`<<READ(sse://feed/x#data)<N-M>:…:READ` pulls a specific slice of the channel's content into a log row when the model wants depth beyond the preview.

### §7.6 HIDE is pure archive

`<<HIDE(sse://feed/x)::HIDE` demotes the entry from the index. The connection persists silently; channels keep updating in the background; the model can `SHOW` it back later. HIDE never tears down a subscription.

### §7.7 SEND for stream control

- **Cancel:** `<<SEND[499](sse://feed/x)::SEND` — scheme interprets 499 as "tear down." Subscription registry transitions to closed; the AbortController fires; channel stops accumulating.
- **Write:** `<<SEND[200](wss://feed/x):message body:SEND` — pipes body into an active WS connection, exec stdin, etc.

### §7.8 Backpressure

`PLURNK_SUBSCRIPTION_BURST` (§12) caps per-turn chunk delivery into `packet.system.log[]`. When truncated, a synthesized log row carries `status_rx: 206 Partial Content` with a body describing what was dropped. All chunks remain in the channel; only the per-turn surface is bounded. Under context pressure the burst adapts down. Runtime backpressure; not in the contract.

---

## §8 Storage Model

SQLite (`node:sqlite`) with WAL mode and STRICT tables. Hand-written DDL, validated against grammar schemas via a CI test.

### §8.1 DDL strategy — hand-written, STRICT, indexed

No generator. The value-add of JSON-Schema-to-DDL generation tops out at ~30% (table skeletons with NOT NULL columns and naive types); the remaining 70% — FK semantics, indexes, triggers, generated columns, FTS5, `WITHOUT ROWID`, defaults, decomposition decisions — is hand-written regardless. The generator's only real win is drift detection, which a CI alignment test handles at a fraction of the complexity.

- All `migrations/*.sql` files are authored deliberately. SQLite-optimal: STRICT tables (3.37+), `INTEGER PRIMARY KEY` aliasing where appropriate, explicit `NOT NULL`, indexed query paths, FKs with deliberate `ON DELETE`/`ON UPDATE` semantics, `WITHOUT ROWID` where access pattern warrants, generated columns for materialized derivations, FTS5 virtual tables where text search is load-bearing.
- One migration file per cohesive concern. Numbered for deterministic apply order.
- `migrate` CLI subcommand applies in numeric order. Idempotent — runner skips migrations whose marker is in the `applied_migrations` meta table.
- **Schema-alignment test** loads `@plurnk/plurnk-grammar/schema/*.json`, parses DDL via `node:sqlite` introspection, and asserts every required schema field has a corresponding `NOT NULL` column. Grammar drift fails CI; hand-written DDL catches up before the alignment goes green again.
- **Storage shape ≠ wire shape.** DDL is source of truth for storage; JSON schemas are source of truth for wire format. Tested-aligned, but allowed to differ where SQLite ergonomics demand it.

### §8.2 SQL/TS responsibility boundary

**Lives-in-SQL:**
- The visibility / index / archive lattice (CTEs per run computing the projected entry list).
- Cross-scope path collision detection (CHECK or trigger producing the `409 Conflict` response).
- Cost rollups (denormalized integer pico-units; updated atomically on turn close via triggers).
- Sequence number issuance (1-based per the grammar spec).
- Entry-vs-log integrity (channels carry latest state; log carries every interaction).

**Lives-in-TS:**
- All status-bubble rules (`turn.status` → `loop.status` → `run.status` → `session.status`). Engine UPDATEs status explicitly when it observes terminal turn semantics. CHECK constraints enforce contract; trigger doesn't have to compute it. Triggers were tried and explicitly removed — they fight branching state machines.
- Tokenization (active model's tokenizer; provider-bound; hot-swap requires re-tokenize on switch).
- Provider dispatch and response normalization to `{ assistant, assistantRaw }`.
- Scheme-handler invocation (open connections, run subprocesses, fetch URLs).
- Plugin loading (boot-time scan per §9).
- Stream AbortController lifecycle.
- The CLI surface and the long-running daemon.

When SQL becomes onerous for a specific case, retreat for that case and document the retreat.

---

## §9 Plugin Discovery

External `@plurnk/*` npm packages register at boot via the **scoped-package scan with manifest field** pattern:

1. Each external package declares its kind in its `package.json`:
   ```json
   { "name": "@plurnk/plurnk-providers-openrouter",
     "plurnk": { "kind": "provider", "name": "openrouter" } }
   ```
2. On boot, `plurnk-service` reads every `node_modules/@plurnk/*/package.json`, filters for those with a `plurnk` field, dynamic-imports the matches.
3. Load order: deterministic, alphabetical by name.
4. Collision on `(kind, name)` is fail-hard at boot.
5. The user's flow: `npm i @plurnk/plurnk-<kind>-<name> && plurnk start`. Zero config.

Env vars are reserved for *configuring* installed plugins (API keys, endpoints, throttles), never for *declaring their existence*. The filesystem is the source of truth for what's installed.

Versioning: a `plurnkContractVersion` field on each plugin's `plurnk` manifest declares which version of this SPEC the plugin targets. Engine refuses incompatible plugins at boot. (Wired up post-v1.0 of this document.)

---

## §10 Bundled Set

These ship in `plurnk-service` directly, not as separate `@plurnk/*` packages:

**Providers:**
- `mock` — fake provider used exclusively in `intg` for deterministic engine tests. Also serves as a minimal worked example for authors of external `@plurnk/plurnk-providers-*` packages.

**Mimetypes** (in `src/mimetypes/`):
- `text/plain` — landed (#80). Identity validate; head-truncated preview.
- `text/markdown` — landed (#80). Identity validate; heading-outline `symbols()` extractor; preview falls back to heading outline or head-truncated content.
- `application/json` — deferred; lands when first consumer arrives.
- DSL mimetype (`text/vnd.plurnk` pending grammar #6; currently `text/x-plurnk`) — deferred; lands when log-rendering structural summaries become necessary.

**Schemes** (in `src/schemes/`):
- `plurnk` — meta-scheme for scheme registration ops.
- `log` — coordinate-addressed run/turn/action log reads.
- `known` — primary narrative entries.
- `unknown` — decomposition / open questions.
- `skill` — sibling of known/unknown; semantics provisional.
- `exec` — deferred; subprocess invocation.
- `file` — currently in-tree but flagged for extraction to `@plurnk/plurnk-schemes-file`; rebuild deferred until floor scope is green.

**External** (separate repos, separate npm packages, optional install):
- **Providers:** `openai`, `openrouter`, `xai`, `google`, `ollama`, `cf` (Cloudflare).
- **Schemes:** `http(s)`, `ws(s)`, `sse`, `graphql`, `openapi`, `grpc`, `mailto`, `mcp`, `sftp`, `rest`, `search`, `file`.
- **Mimetypes:** anything beyond the bundled set.

---

## §11 Grammar Dependency

`@plurnk/plurnk-grammar@0.3.0` is the contract. Consumed via `github:plurnk/plurnk-grammar` HEAD during pre-1.0 iteration. Treat the grammar as authoritative; surface gaps to the user, don't redesign from this side.

### §11.1 What grammar provides

- Parser (`PlurnkParser`, ANTLR4-generated) — DSL text → `PlurnkStatement[]`.
- AST types (`@plurnk/plurnk-grammar`'s exported TypeScript interfaces).
- JSON schemas (`schema/*.json`, draft 2020-12) for every wire shape.
- The grammar's `plurnk.md` is the canonical model-facing description of the DSL.

### §11.2 What plurnk-service tracks in its own runtime state (NOT in the grammar)

- Channel lifecycle (`active` / `closed` / `errored`) — subscription registry, not on `ChannelContent`. Was rejected as a contract field with good reason: streams are not a distinct paradigm at the contract layer; they're a runtime relationship between an entry and an open connection.
- Render budget per channel (token count) — `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` operator config (§12).
- Backpressure caps (`PLURNK_SUBSCRIPTION_BURST`) — operator config.
- Stream cancel verb — no dedicated cancel op or signal in the grammar. SEND[499] to the URI is the pattern (§7.7).
- Delete verb — no dedicated DELETE op. SEND[410] to the URI is the pattern (§3.5, §6.5).

### §11.3 Open contract gaps surfaced to grammar

- **#6** — request to consider `text/vnd.plurnk` as the DSL mimetype (currently `text/x-plurnk`; RFC 6648 deprecates `x-*`; `vnd.*` is the modern equivalent). Filed; awaiting grammar agent decision.
- **#7** — request to expose a public `parsePath` helper. Currently the grammar's path parser is private (`AstBuilder.#parsePath`); plurnk-service's RPC layer works around it via build-heredoc-and-parse round-trip in `src/server/dsl.ts`. A public helper would let consumers honor grammar's per-scheme path semantics directly.
- **#8** — observation that `plurnk.md`'s SEND examples only show the broadcast form (no path); a model with weak DSL grasp can put body content in the path slot, getting 400s. Suggested clarification: tighten examples and/or table cell wording, or close as a model-training concern. Plurnk-service adopts whatever grammar lands on.

When future gaps surface, they get filed as grammar issues (not redesigned in plurnk-service), and the relevant SPEC.md section notes the pending request.

---

## §12 Operator Configuration

Every plurnk-service deployment configures via env vars. Cascade: `.env.example` < `.env` < `.env.<profile>` < shell. `.env.example` declares every var with a sane default inline; no boot-time validators; read fails crash with the env-var path included.

| Var                                  | Default            | Purpose                                                              |
|--------------------------------------|--------------------|----------------------------------------------------------------------|
| `PLURNK_DB_PATH`                     | `./plurnk_dev.db`  | SQLite file path. Dev uses `plurnk_dev.db`; prod uses `plurnk.db`.   |
| `PLURNK_HOST`                        | `127.0.0.1`        | Bind address for the daemon WebSocket. Local-only by default.        |
| `PLURNK_PORT`                        | `3044`             | TCP port for the daemon WebSocket.                                   |
| `PLURNK_MAX_TURNS`                   | `50`               | Default safety cap on turns per `loop.run` (overridable per call).   |
| `PLURNK_RPC_TIMEOUT`                 | `30000`            | Timeout in ms for non-`longRunning` RPC handlers.                    |
| `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS`   | `256`              | Per-channel head/tail token budget for index preview tiles.          |
| `PLURNK_SUBSCRIPTION_BURST`          | `64`               | Max chunks delivered into `packet.system.log[]` per turn per subscription. |
| `PLURNK_DEBUG`                       | `0`                | When `1`, runs schema validation on every internal hop (vs. boundaries only). |
| `PLURNK_LOG_LEVEL`                   | `info`             | Stdout boot/crash banners only — runtime logging is DB rows.         |

Feature-flag bools use `process.env.X === "1"` exactly — never `=== "true"`.

External provider/scheme/mimetype plugins declare their own env vars in their own `.env.example` files; plurnk-service merges them at boot via the cascading-env convention.

The admin CLI (`bin/plurnk-service.js`) auto-derives flags from `.env.example`. Every `PLURNK_*` env var becomes a `--<kebab-cased-name>` flag (prefix stripped, lowercased, underscores → dashes). A comment immediately above the env line (no blank line between) becomes the flag's `-h` description. Vars without a comment are still accepted as flags but hidden from `-h`. Non-`PLURNK_*` vars in `.env.example` are bugs — vendor-specific config belongs to the vendor's package, not to plurnk-service's namespace.

---

## §13 RPC Surface

`plurnk-service` runs as a daemon — a long-lived process owning the engine, DB, providers, schemes, and mimetypes. Clients (TUI, CLI, neovim plugin, Telegram bot, web app, anything) connect over a network protocol and drive the agent through a self-describing RPC contract.

This section defines the wire. Implementing a new client should require reading only §13 — no source diving, no protocol guessing.

### §13.1 Transport

WebSocket via the `ws` npm package. One message per `ws.send`. UTF-8 JSON payloads. Single full-duplex connection per client.

Configuration via §12:

- `PLURNK_PORT` (default `3044`) — TCP port to bind.
- `PLURNK_HOST` (default `127.0.0.1`) — bind address. Local-only by default; explicit operator action to expose beyond loopback.

Out of scope for v0: authentication, TLS, multiplexing. Local-loopback + filesystem permissions are the access control. Network exposure gets its own design pass with auth.

### §13.2 Protocol

JSON-RPC 2.0 (https://www.jsonrpc.org/specification). Two message kinds:

- **Request:** `{ "jsonrpc": "2.0", "id": "...", "method": "...", "params": {...} }`. Server replies with a matching `id`.
- **Notification:** `{ "jsonrpc": "2.0", "method": "...", "params": {...} }`. No `id`; no reply expected. Server-initiated for live events.

Server responses are `{ "jsonrpc": "2.0", "id": "...", "result": {...} }` on success or `{ "jsonrpc": "2.0", "id": "...", "error": { "code": ..., "message": "...", "data": {...} } }` on failure.

Wire envelope matches rummy's; clients written against rummy translate with cosmetic renames only.

### §13.3 Method registration

Every RPC method is registered on the daemon with metadata:

```ts
registry.register("loop.run", {
    handler: async (params, ctx) => { /* ... */ },
    description: "Run a model-driven loop with a prompt; streams log/entry notifications.",
    params: {
        prompt: "string — the user prompt for the loop",
        sessionId: "number? — defaults to current attached session",
        maxTurns: "number? — defaults to PLURNK_MAX_TURNS",
    },
    requiresInit: true,
    longRunning: true,
});
```

Metadata fields:

- `handler(params, ctx) -> Promise<result>` — the implementation.
- `description: string` — one-line human description; surfaced by `discover`.
- `params: Record<string, string>` — per-param descriptions; surfaced by `discover`. The string format is `"type — meaning"` with `?` suffix for optional types. Self-documenting, not enforced.
- `requiresInit: boolean` — if true, server rejects this method until a session is attached.
- `longRunning: boolean` — exempt from the RPC timeout (`PLURNK_RPC_TIMEOUT`). Use for methods that intentionally take many seconds (running a loop).

### §13.4 Discovery

The `discover` method returns the entire method + notification catalog:

```json
{
    "methods": {
        "ping": { "description": "Liveness check.", "params": {} },
        "loop.run": { "description": "Run a model-driven loop.", "params": {...} },
        "...": "..."
    },
    "notifications": {
        "log/entry": { "description": "A new log_entries row was written.", "params": {...} },
        "loop/terminated": { "description": "A loop reached a terminal status.", "params": {...} },
        "...": "..."
    },
    "capabilities": {
        "providers": [...],
        "schemes": [...],
        "mimetypes": [...]
    }
}
```

`capabilities` lists the registered plug-ins by `(kind, name)` so clients can show "what's available" without polling separate endpoints. A client connecting cold calls `discover` first, then renders its UI accordingly. No hardcoding of method names or capability lists in any client.

### §13.5 Core method set

The minimum v0 surface. Methods are grouped by concern.

**Liveness + introspection**

| Method     | Params | Result | Notes |
|------------|--------|--------|-------|
| `ping`     | none   | `{}`   | Liveness. No init required. |
| `discover` | none   | catalog (§13.4) | No init required. |

**Sessions**

| Method            | Params              | Result            | Notes |
|-------------------|---------------------|-------------------|-------|
| `session.create`  | `name?: string`     | `{ id, name }`    | Creates new session; auto-name from timestamp if unprovided. |
| `session.list`    | none                | `{ sessions: Session[] }` | Lists all sessions. |
| `session.attach`  | `id: number`        | `{ id, name }`    | Binds this connection to an existing session; subsequent ops use it. |

If a client issues a method requiring init (`requiresInit: true`) without first calling `session.attach` or `session.create`, the daemon auto-creates the envelope on demand: session → run → client loop, all persisted normally. Auto-creation is a convenience for one-off invocations (Telegram quick-queries, neovim ad-hoc dispatches, `plurnk "prompt"` CLI shots); the records carry through the same way explicitly-created ones do. **Auto-created ≠ auto-deleted.** Records persist for the log's forensic value. If a client wants active cleanup, that's a future `session.delete` / `session.archive` endpoint, opt-in.

**Loops (model-driven)**

| Method        | Params                              | Result                 | Notes |
|---------------|-------------------------------------|------------------------|-------|
| `loop.run`    | `prompt`, `maxTurns?`               | `{ loopId, turnIds, finalStatus, hitMaxTurns }` | Model-driven loop. Streams `log/entry` notifications during. `longRunning: true`. |

**DSL operations (client-driven, mirror the grammar)**

Per the **Speak in DSL, not plumbing** rule (AGENTS.md Standing Rules): RPC methods for client-driven ops construct DSL statements internally and dispatch through the same `Engine.dispatch` path the model uses. Param shapes are ergonomic (semantic names, not HEREDOC slot positions); the semantics ARE the DSL's.

Each `op.*` call creates a turn in the connection's client loop (§13.7) with the constructed statement as a single action, dispatches it, fires a `log/entry` notification to attached clients of the session, returns the dispatch result.

| Method        | Params                                                  | Notes |
|---------------|---------------------------------------------------------|-------|
| `op.find`     | `scope: string`, `matcher?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<FIND>>`. |
| `op.read`     | `path: string`, `matcher?: string`, `lineRange?: LineMarker`, `tags?: string[]` | Mirrors `<<READ>>`. |
| `op.edit`     | `path: string`, `content?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<EDIT>>`. |
| `op.copy`     | `source: string`, `destination: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<COPY>>`. |
| `op.move`     | `source: string`, `destination?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<MOVE>>`. Missing `destination` = delete (null-body MOVE). |
| `op.show`     | `path: string`, `matcher?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<SHOW>>`. |
| `op.hide`     | `path: string`, `matcher?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<HIDE>>`. |
| `op.send`     | `status: number`, `recipient?: string`, `body?: string` | Mirrors `<<SEND>>`. |
| `op.exec`     | `cwd?: string`, `runtime?: string`, `command?: string`  | Mirrors `<<EXEC>>`. |
| `op.dispatch` | `statement: PlurnkStatement`                            | Low-level path for clients that have a parsed AST already (e.g. the TUI when the user types raw HEREDOC at the prompt). |
| `op.parse`    | `text: string`                                          | Convenience: daemon parses raw DSL text via the grammar, dispatches each statement as actions of one turn, returns `{ results: DispatchResult[] }`. |

All `op.*` methods return `{ status: number, ...op-specific-extras }`. They are `requiresInit: true`. They are NOT `longRunning` (one dispatch per call; result returns when the engine returns).

Future-reserved (post-v0):

- `subscription.list` — list active streaming subscriptions (§7).
- `subscription.cancel` — analog of `SEND[499]` over RPC, though `op.send({status: 499, recipient: path})` does the same thing today.

### §13.6 Notifications

Server-initiated events streamed to the client over the same WebSocket. Critical for live waterfall rendering.

| Notification       | Params                              | When fired |
|--------------------|-------------------------------------|------------|
| `log/entry`        | `{ entry: LogEntry }`               | Every time a `log_entries` row is written. |
| `loop/terminated`  | `{ loopId, finalStatus, hitMaxTurns }` | When a loop reaches a terminal status. |
| `session/created`  | `{ session: Session }`              | When a session is created (any client's action; gives multi-client awareness). |

Future-reserved: `stream/event` for the stream model (§7) — chunks accumulating, subscriptions opening/closing.

Notifications are scoped to the connection's attached session — a client attached to session A does NOT receive `log/entry` notifications for actions on session B. (Cross-session observation is a future feature; v0 keeps the scope tight.)

### §13.7 Connection lifecycle

```
[client]                                          [daemon]
   |                                                 |
   |-- ws.connect ----------------------------------->|
   |<------- on('open') --------------------------- |
   |                                                 |
   |-- discover() ---------------------------------->|
   |<------- { methods, notifications, capabilities }|
   |                                                 |
   |-- session.attach(id=42) ------------------------>|
   |<------- { id: 42, name: "demo-session" }       |
   |   (daemon opens a client loop in session 42)    |
   |                                                 |
   |-- loop.run(prompt="...") ----------------------->|
   |<-- notification: log/entry { ... }              |
   |<-- notification: log/entry { ... }              |
   |<-- notification: loop/terminated { ... }        |
   |<------- { loopId, turnIds, finalStatus: 200 }   |
   |                                                 |
   |-- op.dispatch(op=...) -------------------------->|
   |<-- notification: log/entry { ... }              |
   |<------- { status: 201 }                         |
   |                                                 |
   |-- ws.close ------------------------------------->|
   |   (daemon closes the client loop; session keeps)|
```

The **client loop** is the envelope for client-origin actions. When a session is attached (explicit or auto-created), the daemon opens a loop in the session's current run (auto-creating the run too if absent) with `origin = "client"`. Every `op.dispatch` call creates a turn in that loop. On disconnect, the loop's `status` transitions to a closed terminal but the rows persist. Multiple connections to the same session each get their own client loop; they coexist.

`loop.run` creates a separate, normal loop (origin = "model") for the model-driven turn sequence. It coexists with the client loop in the same run.

### §13.8 Errors

Standard JSON-RPC error codes:

| Code   | Meaning                       |
|--------|-------------------------------|
| -32700 | Parse error (malformed JSON)  |
| -32600 | Invalid request               |
| -32601 | Method not found              |
| -32602 | Invalid params                |
| -32603 | Internal error                |

Plurnk-specific extensions in the `-32000` to `-32099` range:

| Code   | Meaning                                            |
|--------|----------------------------------------------------|
| -32000 | Not initialized (method requires session attach)   |
| -32001 | Session not found                                  |
| -32002 | Loop not found                                     |
| -32003 | Entry not found (404 from the engine layer)        |
| -32004 | Provider unavailable                               |
| -32005 | Scheme unavailable                                 |
| -32006 | Mimetype unavailable                               |
| -32007 | Timeout                                            |

Error responses MAY include `data: { ... }` with structured context (the path that was 404'd, the method that timed out, etc.) for client error rendering.

### §13.9 Versioning

`plurnk-service` exposes a `protocolVersion` field in `discover`'s response (semver). Major version mismatches are a contract break — clients SHOULD refuse to operate on a major mismatch. Minor/patch increments are backward-compatible.

Current: `protocolVersion: "0.1.0"`. The floor is green and the daemon has been exercised end-to-end via the `plurnk` TUI client (which now graduates to its own agent). Promotes to `1.0.0` when an independent external client (neovim plugin or Telegram bot) lands AND the mimetype/channel/transaction work below has settled.
