# plurnk-service — Specification

Single source of truth for what plurnk-service IS — the contracts it exposes, the architecture it implements, the promises it makes to the rest of the constellation (`plurnk-grammar`, `plurnk-providers-*`, `plurnk-schemes-*`, `plurnk-mimetypes-*`, the user-facing `plurnk` CLI). `AGENTS.md` covers how we work on it; this file covers what we're working on.

Section numbers are stable. Future anchor-to-test wiring binds individual promises here to integration / live / demo tests, giving semi-deterministic specification-testing alignment.

Floor scope is green (capstone intg test exercises every non-EXEC DSL op end-to-end). Post-floor work landed in #123: PlurnkSchemeContext (#33), the engine rails (#38–#41), packet shape (§15), single-cap constraint (§7.8), ProviderRegistry (#58), and first sibling-package extraction (#47). This document evolves with each phase; the next refinements will come from Phase C (mimetype integration story) and Phase F (exec + streams).

**Promise anchors.** Individual contract assertions in this document carry a trailing `{§<id>}` marker. Tests reference these anchors in their names (`test("[§<id>] description", ...)`). An alignment test (`test/intg/spec-anchors.test.ts`) fails if a test cites a nonexistent anchor (orphan — typo or stale reference) and surfaces gaps (anchored promises with no test) informationally. The anchors are **grounding against drift**, not a forcing function on development — write the spec, write the test, jot the link, move on. Coverage grows organically.

---

## §0 Glossary

Canonical meanings. When a doc, comment, test name, or commit message uses one of these words, it means exactly what's written here. Drift is a bug.

### §0.1 Lifecycle terms

| Term | Meaning |
|---|---|
| **agent** | The plurnk runtime singleton. Owns agent-scoped state (default scheme registry, agent-wide entries). One per process. |
| **session** | Durable user-named workspace. Persists across runs and process restarts. Identity: `sessions.id` + unique `sessions.name`. |
| **run** | A stretch of work within a session. Multiple runs per session. May fork from another run via `parent_run_id`. Owns visibility state and log entries. |
| **loop** | One model-driven or client-driven iteration within a run. Status ∈ {102, 200, 499}. Many loops per run. The model runs inside a loop; each client RPC has its own loop. |
| **turn** | One round-trip with the LLM (or one client RPC dispatch). One assembled prompt sent, one parsed response handled. Many turns per loop. Identity: `(loop_id, sequence)`. |
| **op** | One DSL operation the model emits. Parsed into a `PlurnkStatement`. Examples: `EDIT`, `READ`, `SEND`, `FIND`, `COPY`, `MOVE`, `SHOW`, `HIDE`, `EXEC`. One turn produces zero or more ops. |
| **statement** | Synonym for parsed op. The AST shape `PlurnkStatement` from `@plurnk/plurnk-grammar`. |
| **action** | One executed op. Action and op are the same thing in different states (op = parsed; action = executed). The execution produces a log_entries row at `log://<L>/<T>/<S>/<op>`. |
| **dispatch** | The engine routing a statement to its scheme's op handler. |

### §0.2 Storage terms

| Term | Meaning |
|---|---|
| **entry** | The unit of canonical state. Identity: `(scope, scheme, pathname)`. Holds one or more `channels` of content plus `tags` and `attributes`. |
| **channel** | A named content buffer on an entry. Examples: `body`, `preview`, `stdout`, `stderr`, `headers`, `symbols`. Each channel has `content`, `mimetype`, `tokens`, `state`. |
| **scope** | `"agent"` or `"session"`. Determines who reads. Agent-scope entries visible to every run; session-scope entries to that session's runs. |
| **scheme** | A URI prefix + handler. `known`, `unknown`, `file`, `https`, `exec`. The scheme handler interprets paths under its prefix and implements the op surface. See SCHEMES.md. |
| **mimetype** | A channel's content type. Drives the render-time handler that produces `preview`/`symbols`. See MIMETYPES.md. |
| **provider** | An LLM transport. Implements `generate({messages, signal})` against a wire protocol. See PROVIDERS.md. |

### §0.3 State / visibility / status

Three independent axes on entries and channels. Confusion across them is a recurring source of bugs.

| Term | Type | Meaning |
|---|---|---|
| **status** | HTTP int | Outcome of an operation. Carried on `log_entries.status_rx`, returned from op handlers. Per the catalogue (§3.5). |
| **visibility** | `0 \| 1` | Per-`(run, entry, channel)` bit. `1 = indexed` (appears in `packet.system.index`), `0 = hidden` (not rendered, recallable via explicit READ). |
| **channel state** | `static \| active \| closed \| errored` | Streaming lifecycle of a channel's content. Metadata, not gating — engine renders content regardless of state. |
| **entry state** | `proposed \| resolved \| cancelled` | Proposal lifecycle. `proposed` = pending client accept; `resolved` = side effect happened; `cancelled` = client rejected. Distinct from channel state. |
| **outcome** | `string \| null` | Short reason for `failed`/`cancelled` (`"permission:403"`, `"aborted"`, `"not_found"`). Opaque to most callers. |

### §0.4 Writer / authority

| Term | Meaning |
|---|---|
| **writer** | The identity authoring a write. One of `model \| client \| system \| plugin`. Carried on `ctx.writer` for schemes; engine enforces `manifest.writableBy`. |
| **origin** | Synonym for writer in log_entries (`log_entries.origin`). Historical naming; treat as equivalent. |
| **writable_by** | The set of writers a scheme accepts. Subset of `{model, client, system, plugin}`. Engine rejects writes outside the set with 403; the rejection is logged as the action-entry (§7.1 action-entry-as-outcome). |

### §0.5 Engine rails

| Term | Meaning |
|---|---|
| **verdict** | End-of-turn ruling from the verdict filter chain. Returns `{continue: boolean, status: number, reason: string}`. Decides whether the loop terminates or another turn fires. |
| **strike** | A turn whose verdict counts toward `MAX_STRIKES`. Fires when `turnErrors > 0` or cycle detection trips. The streak counter resets on clean turn; reaches `MAX_STRIKES` → loop abandons at 499. |
| **cycle** | A repeated turn fingerprint across consecutive turns. Detected silently; model never sees the trigger. Strike accumulates internally. |
| **sudden death** | The last `MAX_STRIKES` turns of a loop's `MAX_LOOP_TURNS` window emit soft 429 warnings so the model can wrap up cleanly. `soft=true`: no strike, no streak increment. |
| **mode** | `"ask" \| "act"`. Per-loop. Ask = read-only (no side-effecting ops); act = full surface. |
| **flag** | Per-loop boolean shaping the active toolset: `yolo` (auto-accept proposals), `noWeb`, `noInteraction`, `noProposals`. |
| **proposal** | A deferred side-effecting action awaiting client accept/reject. State machine: `proposed → resolved` or `proposed → cancelled`. `yolo` short-circuits to immediate. |
| **resolution** | Client's accept/reject of a proposal via `op.resolve` RPC. |

### §0.6 Packet terms

| Term | Meaning |
|---|---|
| **packet** | The turn's full exchange shape: `{system, user, assistant, assistantRaw}`. Persisted on `turns.packet`. |
| **index** | `packet.system.index`. Entry list visible to the model this turn. Built from `visibility` lattice + mimetype.preview. |
| **log** | `packet.system.log`. Chronological list of `log_entries` in scope this turn. |
| **render** | The act of computing the packet from current DB state at turn boundaries. Mimetype handlers fire at render time. |

### §0.7 Test taxonomy

| Tier | Location | LLM | Substrate |
|---|---|---|---|
| **unit** | `src/**/*.test.ts` | No | Isolated logic, mocked boundaries |
| **intg** | `test/intg/` | No (mock provider) | Real in-memory SqlRite, real engine |
| **live** | `test/live/` | Real | Wire-level assertions |
| **demo** | `test/demo/` | Real | Holistic outcome assertions |

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

The class declares its full manifest as a static field (per `SchemeManifest` in `src/core/scheme-types.ts`):

```ts
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
        flags: { /* optional flag affinity per LoopFlags */ },
    };
    // ...
}
```

Each entry in `manifest.channels` names a channel and pins its mimetype. The engine consults this manifest before writing channels. Schemes whose mimetypes are content-dynamic (file, eventually exec) declare an empty `channels: {}` and supply mimetype per-call instead; the engine accepts either path but never accepts an unset mimetype (see §5).

`manifest.defaultChannel` is REQUIRED for any scheme that accepts EDIT or READ on fragment-less paths. It names which channel of the entry is targeted when the path has no `#fragment`. See §5.5 for the channel-selection semantic.

Identity-match is enforced at plugin load: `manifest.name` must equal the `plurnk.name` in `package.json` (PluginLoader.assertIdentityMatch).

### §3.2 CRUD Primitives (uniform across schemes)

The canonical surface a scheme exposes for engine orchestration. Every entry-bearing scheme MUST implement these three methods. The engine uses them to drive cross-scheme operations (§6.4 COPY, §6.5 MOVE) and the SEND[410] delete pattern (§6.8).

```ts
type EntryData = {
    channels: Record<string, { content: string; mimetype: string }>;
    tags: string[];
};

readEntry(pathname: string, ctx: PlurnkSchemeContext):  Promise<ReadEntryResult>;
writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext):  Promise<WriteEntryResult>;
deleteEntry(pathname: string, ctx: PlurnkSchemeContext):  Promise<DeleteEntryResult>;
```

Where `PlurnkSchemeContext` is the per-call helper bundling `{ db, sessionId, runId, loopId, turnId, writer, signal }` (per `scheme-types.ts`). v0 ctx exposes `db` directly; the namespaced surface described in SCHEMES.md §4 (entries / channels / visibility / tags / subscriptions / proposals / crossScheme / notify) lands in v1 when third-party plugin schemes are an actual concern.

Promises:
- `readEntry` returns the full entry shape at `pathname` or `{ status: 404, entry: null }`.
- `writeEntry` accepts a full entry shape and persists it. Returns `{ status: 201, created: true }` for new entries; `{ status: 200, created: false }` for replaces — UNLESS the scheme's policy forbids overwrites, in which case it returns `{ status: 409, created: false }`. See §6.4 for the COPY/MOVE conflict policy.
- `deleteEntry` removes the entry. Returns 200 on success, 404 if absent.
- Validation: `writeEntry` MUST verify channel mimetypes against the scheme's manifest (§3.1) and crash on mismatch. No defaults, no coercion (see §5 Channel Topology).
- Atomicity: each method is a single SQL transaction. Engine orchestration (COPY = read + write) is responsible for its own outer transaction.

### §3.3 Op Methods (layered over CRUD)

The DSL-facing methods the engine dispatches based on parsed `PlurnkStatement.op`. Signature: `op(statement, ctx)` where `statement` is the parsed AST node and `ctx` is the per-call `PlurnkSchemeContext`.

```ts
edit(statement: EditStatement, ctx: PlurnkSchemeContext):   Promise<EditResult>;
read(statement: ReadStatement, ctx: PlurnkSchemeContext):   Promise<ReadResult>;
show(statement: ShowStatement | HideStatement, ctx): Promise<ShowHideResult>;
hide(statement: ShowStatement | HideStatement, ctx): Promise<ShowHideResult>;
find(statement: FindStatement, ctx: PlurnkSchemeContext):   Promise<FindResult>;
send(statement: SendStatement, ctx: PlurnkSchemeContext):   Promise<SendResult>;
```

COPY and MOVE are NOT scheme methods. They are engine orchestrations over CRUD primitives (§6.4, §6.5).

### §3.4 Cross-scheme orchestration

The engine — not any individual scheme — handles cross-scheme COPY and MOVE:

```
copy(source_path, dest_path, signal_tags, ctx):
    src_scheme = scheme_for(source_path)
    dst_scheme = scheme_for(dest_path)
    entry = src_scheme.readEntry(source_pathname, ctx)
    if entry == null: return 404
    if dst_scheme.readEntry(dest_pathname, ctx) succeeds: return 409
    if not mimetype_compatible(entry, dst_scheme): return 415
    tags = signal_tags ?? entry.tags
    dst_scheme.writeEntry(dest_pathname, { channels: entry.channels, tags }, ctx)

move(source_path, dest_path, signal_tags, ctx):
    copy(source_path, dest_path, signal_tags, ctx)
    src_scheme.deleteEntry(source_pathname, ctx)
```

Same- and cross-scheme operations follow the identical orchestration. Same-scheme COPY (e.g., `known://a` → `known://b`) is NOT a special case — it is COPY where src_scheme and dst_scheme happen to be the same handler. The engine does not optimize this case; uniformity beats local efficiency at this layer.

For v0 (known/unknown/skill, all sharing the `entries` table), CRUD primitives are thin wrappers over entry-table operations. For future schemes (file, exec, http), the same orchestrator drives the same primitives over different storage substrates.

### §3.5 SEND dispatch (status-code-as-verb)

When the engine dispatches a `SEND` op with a non-null path (recipient-directed SEND), the target scheme's `send` method receives the statement. The scheme interprets the status code as an intent:

- `SEND[200](path)` — write the body into the resource at `path` (e.g., WebSocket message, exec stdin).
- `SEND[410](path)` — delete the resource at `path`. Scheme calls its own `delete` primitive. {§3.5-410-deletes-resource}
- `SEND[499](path)` — cancel any active subscription bound to `path` (§7).

Other status codes are scheme-specific. The engine does not interpret SEND status codes for directed (non-broadcast) sends. Entry-bearing schemes return 501 for status codes they don't interpret. {§3.5-entry-schemes-501-on-non-410}

For SEND[410], channel-level deletion via `#fragment` is deferred — schemes return 400 on fragment-targeted 410. {§3.5-410-fragment-400}

`SEND` with null path is broadcast (§6.7) — engine-handled, not scheme-handled.

---

## §4 Mimetype Contract

A mimetype handler interprets channel content for validation, structural extraction, and preview rendering. Every `@plurnk/plurnk-mimetypes-*` package implements this contract.

**Firing semantics.** Mimetype handlers are **render-time** consumers. The engine invokes them when assembling the turn packet at turn boundaries — they read the current channel content (whatever's there, possibly mid-stream), produce a structural view, and the result lands in the model's context. {§4-handlers-fire-render-time} Schemes do NOT call mimetype handlers at write time; schemes just append to channel content. Render is the only consumer of "interpreted" content. {§4-schemes-do-not-invoke-handlers} Memoization (handler result cached by content hash) is an implementation concern; the contract is render-time.

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
- `validate` is a render-time guard. If it throws, that's a handler bug — engine crashes loudly per fail-hard. Schemes that want write-time validation handle that themselves; it's not plurnk-service's contract.
- `symbols` returns a structural index of the content. For text/markdown, this is the heading outline. For application/json, the top-level key tree. For text/plain, an empty string (no structure).
- `preview` returns a budget-bounded structural summary. `budget` is a character-count hint (not strictly enforced; handler does its best). For text/plain, head-truncation. For text/markdown, heading outline. For application/json, depth-limited key tree.
- All three methods MUST be deterministic for caching to work — same content in, same output out.

### §4.3 What mimetype handlers do NOT do

- **Tokenization.** Token counting is provider-bound (§2.3). Mimetype handlers describe structure; tokenizers count tokens.
- **Storage.** Mimetype handlers are pure functions over content strings. They neither read nor write the DB.
- **Streaming.** Mimetype handlers operate on whatever content is current when invoked. The streaming relationship (§7) is between schemes and the subscription registry; mimetype handlers don't see it.

### §4.4 Bundled vs sibling handlers

Only `text/plain` ships in `plurnk-service`'s `src/mimetypes/` — the universal fallback that every deployment needs and that has no external dependency. Every other mimetype handler ships as a sibling `@plurnk/plurnk-mimetypes-*` package and registers via Daemon's plugin discovery scan (§9).

The first such extraction is `@plurnk/plurnk-mimetypes-text-markdown`, separate repo since #47. Validates the "bundle minimally" pattern. `application/json` and the DSL mimetype (`text/vnd.plurnk` — grammar #6 closed in favor of this id) follow the same pattern when they have consumers.

Locked glyph assignments for the standard set:

| Mimetype                          | Glyph | Where                              |
|-----------------------------------|-------|------------------------------------|
| `text/plain`                      | 📄    | bundled (`src/mimetypes/`)         |
| `text/markdown`                   | 📝    | sibling (`@plurnk/plurnk-mimetypes-text-markdown`) |
| `application/json` *(deferred)*   | 🗂    | future sibling                     |
| `text/vnd.plurnk` *(deferred)*    | 📜    | future sibling                     |

Deferred handlers reserve their glyphs now so external packages don't collide.

---

## §5 Channel Topology

Every entry has named channels. **Channels are append-only content stores** keyed by `(entry_id, name)`. Schemes write content; the engine reads at turn boundaries; mimetype handlers interpret. {§5-channels-append-only}

### §5.1 Per-entry channels

EDIT writes a minimum of two channels per entry, in one transaction: {§5.1-edit-writes-body-plus-preview}

- **`body`** — the raw content.
- **`preview`** — the render-time structural summary. The stored content here is the result of `mimetype.preview(body, budget)` for the body's mimetype. When the mimetype handler is unsophisticated (text/plain head-truncation), the preview is short. As handlers mature (markdown heading outline, JSON key tree, DSL op summary), the preview becomes structural. {§5.1-preview-is-handler-output}

Whether preview is stored (write-time memoization) or computed fresh on each render is an implementation choice behind the contract — both behave the same to callers. v0 implementation stores it (avoids per-render compute); future implementation may switch to compute-on-render with content-hash cache.

Schemes MAY declare additional channels (exec will declare `stdout`/`stderr`; file may declare an `outline` channel; SSE may declare per-event-type channels). Each additional channel goes in the scheme's `channels` manifest (§3.1) and has its mimetype pinned there.

### §5.2 Visibility lattice

Visibility is per-`(run, entry, channel)` — a bit per cell in the `visibility` table. EDIT-creating-new sets `indexed=1` for every channel of the new entry in the current run. SHOW flips all channels of the target entry to `indexed=1`; HIDE flips all to `indexed=0`. {§5.2-fragmentless-show-hide-flips-all} Channel-specific SHOW/HIDE via fragment exists for the entry-bearing schemes; see §5.5.

The engine's render-time index (`packet.system.index`) includes only `indexed=1` channels for the current run. {§5.2-render-filters-by-indexed} Each included channel is passed through its mimetype handler's `preview(content, budget)` per §4 / §5.1, with the result landing in the entry's `channels[name].content` field in the packet.

### §5.3 Mimetype is a (scheme, channel) property — never a default

The mimetype of a channel is declared by the scheme's manifest (§3.1) or — for dynamic schemes — supplied per-call. If the engine attempts to write a channel without a declared mimetype, it throws. There is no default mimetype anywhere in the system. This is a reinforcement of the no-fallbacks rule at the channel layer.

Implications:
- Cross-mimetype COPY/MOVE crashes (`415 Unsupported Media Type`) — never coerces. See §6.4.

### §5.4 Orientation hint

The grammar's `SchemeRegistration.channel_orientations` declares each scheme's channels as `head` or `tail` — "which end of the content matters for preview." Mimetype handlers consult this hint when truncating. Channels not listed default to `head`.

### §5.5 Channel selection in the DSL

The DSL targets a specific channel of an entry via the URL **fragment** — the `#name` segment of the path. Per the grammar's `UrlPath` shape (0.3.0+), every parsed path has a nullable `fragment` field; this section defines its semantic for the engine.

Rules:

1. **Fragment-less paths target the scheme's `defaultChannel`.** For `known` / `unknown` / `skill` that's `body`. The path `known://philosophy/meaning` writes/reads the body channel of that entry; equivalent to `known://philosophy/meaning#body` made explicit. {§5.5-fragmentless-targets-default-channel}
2. **Paths with a fragment target the named channel.** `known://philosophy/meaning#preview` targets the preview channel. {§5.5-fragment-selects-named-channel}
3. **Unknown channel name → 400 (bad request).** The channel name must appear in the scheme's `channels` manifest (§3.1). Engine never writes to an undeclared channel. {§5.5-unknown-channel-400}
4. **Schemes without `defaultChannel` reject fragment-less EDIT/READ.** Streaming schemes like `sse://feed/x` may require an explicit fragment (`#data`, `#error`, etc.) and have no default.
5. **Non-default channel EDIT requires entry to exist.** Writing to a fragment-targeted channel of a nonexistent entry returns 404. Default-channel EDIT creates the entry if absent (existing semantics). {§5.5-fragment-on-nonexistent-404}
6. **Fragment-targeted SHOW/HIDE flips only the named channel.** Fragment-less SHOW/HIDE flips all channels per §5.2. {§5.5-fragment-targeted-show-hide}

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

### §5.6 Channel state — metadata, not gating

Per the grammar's `ChannelContent` schema, each channel has a `state ∈ {static, active, closed, errored}`. This is **information about the channel's current writing status**, not a gate on engine behavior. {§5.6-state-is-metadata}

- `static` — content is final; not actively being written. Entry-bearing schemes (known/unknown/skill) stay here always after EDIT.
- `active` — a scheme is currently writing to this channel (chunks arriving). Streaming schemes use this during their connection's accumulating phase.
- `closed` — a scheme finished writing cleanly. The channel content is final but came from a stream that has now ended.
- `errored` — a scheme was writing but ended in error. Content may be partial; subsequent reads still return what was accumulated.

Schemes own state transitions. They UPDATE `entry_channels.state` as their connection lifecycle progresses. {§5.6-schemes-own-state-transitions} The engine does NOT branch on state during rendering — it reads `content` and `state`, includes both in the rendered tile, lets the model and clients see the truth. {§5.6-engine-does-not-branch-on-state}

The model uses state for context: "this channel says `active` — content may grow before my next turn." Clients use state for UI: render an active channel with a spinner, errored with red, etc.

---

## §6 Op Surface

Per-op semantics for `FIND | READ | EDIT | COPY | MOVE | SHOW | HIDE | SEND | EXEC`. Each subsection includes the AST shape (per `@plurnk/plurnk-grammar`'s `PlurnkStatement` schema), the engine's dispatch behavior, and the promises returned to callers.

### §6.1 EDIT

AST: `{ op: "EDIT", path: ParsedPath, body: string | null, signal: tags | null, lineMarker?: LineMarker }`.

Engine dispatches to `scheme.edit(statement, ctx)`. Scheme:
- Resolves the target channel from the path's fragment (§5.5). Fragment absent → scheme's `manifest.defaultChannel`. Unknown channel → 400. Channel manifest-undeclared → engine crashes per §5.3.
- Writes the body to the resolved channel.
- For entry-bearing schemes (known/unknown/skill), also writes the `preview` channel in the same transaction when writing `body`. Storage is verbatim body at write time; structural rendering happens at packet build time via `mimetype.preview(content, budget)` (§5.1).
- Indexes the written channels in the current run (visibility = 1).
- Returns `{ status: 201, entryId }` for new entries; `{ status: 200, entryId }` for updates.
- `body: null` clears the content (writes empty string).
- Tags from `signal[]` are applied via `entry_tags` (additive on update for the v0 entry schemes; final policy may vary by scheme).

### §6.2 READ

AST: `{ op: "READ", path: ParsedPath, body: MatcherBody | null, signal: tags | null, lineMarker?: LineMarker }`.

Engine dispatches to `scheme.read(statement, ctx)`. Scheme:
- Returns the body channel content + mimetype for `path`, or `{ status: 404 }`.
- `lineMarker` selects a line range (e.g., `<10-20>` for lines 10-20).
- `body` (matcher) is for streaming-scheme deep reads (§7) — not v0 surface for entry schemes.

### §6.3 SHOW / HIDE

AST: `{ op: "SHOW"|"HIDE", path: ParsedPath, body: MatcherBody | null, signal: tags | null, lineMarker?: LineMarker }`.

Engine dispatches to `scheme.show(statement, ctx)` / `scheme.hide(statement, ctx)`. Scheme:
- Flips `visibility.indexed` for every channel of the targeted entry to 1 (SHOW) or 0 (HIDE).
- Returns 200 on transition, 304 on no-op, 404 if entry not found.
- No channel-specific selectors in v0; SHOW/HIDE always affects all channels of the entry.

### §6.4 COPY (engine-orchestrated)

AST: `{ op: "COPY", path: ParsedPath (source), body: ParsedPath (destination), signal: tags | null, lineMarker?: LineMarker }`.

Engine orchestrates over CRUD primitives (§3.2, §3.4):

1. `src_scheme.readEntry(source_pathname, ctx)` → entry or 404. Missing source returns 404. {§6.4-missing-source-404}
2. `dst_scheme.readEntry(dest_pathname, ctx)` to check conflict — if exists, return **409 Conflict** (no overwrite). Per fail-hard discipline. {§6.4-conflict-409}
3. Mimetype compatibility check — channels of `entry` MUST have mimetypes accepted by `dst_scheme`'s `manifest.channels`. Mismatch returns **415 Unsupported Media Type**.
4. Tag resolution: if `signal` is non-null, dest tags = signal_tags (REPLACE). {§6.4-signal-replaces-source-tags} If signal is null/empty, dest tags = source tags (CARRY). {§6.4-no-signal-carries-source-tags}
5. `dst_scheme.writeEntry(dest_pathname, { channels: entry.channels, tags }, ctx)`.
6. Dest visibility indexed=1 in current run (parity with EDIT-creating-new).

Returns `{ status: 201 }` on success.

Same- and cross-scheme COPY both go through this orchestrator. {§6.4-cross-scheme-copy}

### §6.5 MOVE (engine-orchestrated)

AST: `{ op: "MOVE", path: ParsedPath (source), body: ParsedPath | null (destination), signal: tags | null, lineMarker?: LineMarker }`.

Two modes:

**Relocation** (`body` non-null): engine runs §6.4 COPY then `src_scheme.deleteEntry(source_pathname, ctx)`. One transaction. Returns 201 on success. Source is removed. {§6.5-relocation-deletes-source} Cross-scheme relocation works the same as same-scheme. {§6.5-cross-scheme-move}

**Deletion** (`body` is null): engine runs `src_scheme.deleteEntry(source_pathname, ctx)` directly. The null-body MOVE expresses "relocate to nowhere" = delete. {§6.5-null-body-deletes} Returns 200 on success, 404 if source absent. {§6.5-missing-source-404}

Log history is preserved through MOVE because `log_entries.target_*` columns store the path tuple as text, not FK to `entries.id`.

### §6.6 FIND

AST: `{ op: "FIND", path: ParsedPath (scope), body: MatcherBody | null (predicate), signal: tags | null (tag filter), lineMarker?: LineMarker }`.

Engine dispatches to `scheme.find(statement, ctx)`. Scheme:
- Filters entries within the path's scope (scheme + pathname prefix). {§6.6-scope-prefix-filter}
- Applies `body` matcher if present. v0 supports `glob` dialect over pathname. {§6.6-glob-filter-on-pathname} Other dialects (regex over content, xpath, jsonpath) return **501 Not Implemented** until the relevant infrastructure exists. {§6.6-non-glob-dialects-501}
- Applies `signal` as a tag filter: only entries with ALL listed tags pass. {§6.6-tag-filter-and-semantics}
- Results are session- and scheme-scoped — no cross-session or cross-scheme leakage. {§6.6-scoped-isolation}
- Returns `{ status: 200, results: string }` where `results` is `text/plain` with newline-separated matching paths.

### §6.7 SEND

AST: `{ op: "SEND", path: ParsedPath | null, body: SendBody | null, signal: number | null }`.

Two modes:

**Broadcast** (`path` is null): terminal status (200/499) updates `loop.status` and ends the loop. Other status codes return `{ status }` without state change. The model's universal "talk to the orchestrator" surface.

**Directed** (`path` is non-null): engine dispatches `scheme.send(statement, ctx)`. Scheme interprets `signal` as an intent per §3.5:
- 200 → write `body` into the resource (stream-write, exec stdin, etc.)
- 410 → delete the resource at `path` (scheme calls its own `delete` primitive)
- 499 → cancel active subscription (§7)
- Other → scheme-specific

### §6.8 EXEC

AST: `{ op: "EXEC", path: ParsedPath (cwd), body: string | null (command), signal: string | null (runtime tag) }`.

Deferred. The `exec` scheme is in §10's bundled set but lacks a working handler; calls return 501. Sandboxing design and process-lifecycle semantics are the substance to figure out, drawing on rummy's exec plugin as prior art.

---

## §7 Stream Model

The model can't poll and can't wait for streams to complete. It must stay passively informed of ongoing streams between turns. Plurnk-service treats streams as **the same as static content from the engine's perspective** — content arrives over time, channels grow, mimetype handlers render whatever's there at turn boundaries. There is no engine-level "transaction" abstraction; schemes own their connection lifecycle entirely. {§7-no-engine-transaction-abstraction}

### §7.1 Subscriptions

READ on a streaming scheme is a subscription, not a one-shot. The scheme handler opens the connection (SSE, WS, exec subprocess, etc.), returns a `102 Processing` log row immediately, and stays alive. The engine records `(sessionId, entryId) → schemeName + scheme-handle` in a **subscription registry** so cancellation (SEND[499]) can be routed to the scheme owning the active connection. {§7.1-subscription-registry-routes-cancellation}

The subscription registry is plurnk-service runtime state (its own SQLite table). Not in the grammar's schema. **It exists ONLY for cancellation routing** — not for lifecycle tracking, not for state coordination. Channel state (§5.6) and log entries (§7.3) carry the lifecycle information.

### §7.2 Chunk accumulation

SSE event types, WS message types, exec stdout/stderr — each maps to a named channel on the entry. Channel record (per grammar's `ChannelContent`): `content`, `mimetype`, `tokens`. Whether a connection is currently feeding the channel is tracked in the subscription registry, not on the channel itself.

### §7.3 No per-chunk log rows

Channels are the single source of truth for chunk content. Log captures **lifecycle events** only: open (`102`), graceful close (`200`), explicit cancel (`499`), errors (`5xx`), scheme-significant transitions. {§7.3-log-captures-lifecycle-only}

The model sees lifecycle events in `packet.system.log[]` per turn (§7.4 / §7.8). This is how the model learns "the stream opened" / "the stream closed cleanly" / "an error happened" — through log rows, not through engine-level state inspection.

### §7.4 Index tile rendering

Per-channel previews use `SchemeRegistration.channel_orientations` (grammar 0.3.0). The scheme declares each channel as `"head"` (front-anchored — render from beginning) or `"tail"` (append-temporal — render most recent). Channels not listed default to `"head"`. The renderer (plurnk-service code) decides token budget via `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` (§12).

### §7.5 Deep slices on demand

`<<READ(sse://feed/x#data)<N-M>:…:READ` pulls a specific slice of the channel's content into a log row when the model wants depth beyond the preview.

### §7.6 HIDE is pure archive

`<<HIDE(sse://feed/x)::HIDE` demotes the entry from the index. The connection persists silently; channels keep updating in the background; the model can `SHOW` it back later. HIDE never tears down a subscription.

### §7.7 SEND for stream control

- **Cancel:** `<<SEND[499](sse://feed/x)::SEND` — scheme interprets 499 as "tear down." Subscription registry transitions to closed; the AbortController fires; channel stops accumulating.
- **Write:** `<<SEND[200](wss://feed/x):message body:SEND` — pipes body into an active WS connection, exec stdin, etc.

### §7.8 Engine constraints

The engine imposes ONE constraint: **100 MiB char-length cap per channel content body.** Enforced at the storage layer via `CHECK (length(content) <= 104857600)` on `entry_channels.content` (migrations/005_entries.sql). Writes exceeding this fail at the SQL boundary with a SQLITE_CONSTRAINT; the action-entry captures the rejection at status 500.

All other limits are **extrinsic** — owned by providers (request size, model context, fetch timeouts), schemes (per-call validation, scheme-specific size policies), and mimetypes (render budgets per `preview(content, budget)`). The engine does not throttle, batch, rate-limit, or cap anything else. {§7.8-engine-one-cap}

This reflects an intentional v0 stance: pre-MVP, every operator-configurable cap is a barrier between the user and the system actually running. The user-facing CLI/TUI fiddles best when nothing fires unexpectedly. When real production pressure arrives, additional caps land as opt-in operator config — not as defaults.

### §7.9 Live updates for clients (between turns)

While the model only sees turn-boundary rendering (coherent context per turn), connected RPC clients (TUI, neovim, web) want to see channel content grow in real time. The daemon emits `stream/event` notifications (§13.6) when channel content changes. Clients use these to render live waterfalls and refresh entry views without polling. {§7.9-stream-event-fires-on-chunk}

The model is NOT a stream/event consumer. The model is a turn-based consumer; whatever's in the channel at the next turn boundary is what gets rendered into its packet.

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
- `text/plain` — universal fallback. Identity validate; head-truncated preview. Stays bundled because every deployment needs it and it has no external dependency.

**Schemes** (in `src/schemes/`):
- `plurnk` — meta-scheme for scheme registration ops (manifest only; ops not implemented yet).
- `log` — coordinate-addressed run/turn/action log reads.
- `known` — primary narrative entries.
- `unknown` — decomposition / open questions.
- `skill` — sibling of known/unknown; semantics provisional.
- `exec` — manifest only; subprocess invocation deferred to Phase F.
- `file` — currently in-tree but flagged for extraction to `@plurnk/plurnk-schemes-file` once exec/streams phase shapes the file scheme's full surface.

**Sibling repos** (live `@plurnk/*` packages we own):
- **Mimetypes:** `@plurnk/plurnk-mimetypes-text-markdown` — first extraction (#47). Validates the "bundle minimally" pattern.
- **Providers:** `@plurnk/plurnk-providers-openai` — talks to any OpenAI-compatible endpoint (OpenAI proper, llama-server, Ollama OpenAI-compat, etc.).
- **Client:** `@plurnk/plurnk` — user-facing CLI/TUI (independent agent ownership since #57).

**Future external** (separate repos, separate npm packages, optional install when written):
- **Providers:** `openrouter`, `xai`, `google`, `ollama` (native API), `anthropic`, `cf` (Cloudflare). Phase D.
- **Schemes:** `http(s)`, `ws(s)`, `sse`, `graphql`, `openapi`, `grpc`, `mailto`, `mcp`, `sftp`, `rest`, `search`. Streaming schemes land in Phase F.
- **Mimetypes:** `application/json`, `text/vnd.plurnk`, anything beyond. Phase C.

Plugin discovery (§9) finds every installed `@plurnk/*` package at boot and registers what they declare. The bundled set is the floor; siblings are what's installed; the system runs against whatever is present in `node_modules`.

---

## §11 Grammar Dependency

`@plurnk/plurnk-grammar@0.5.0` is the contract. Consumed via `github:plurnk/plurnk-grammar` HEAD during pre-1.0 iteration. Treat the grammar as authoritative; surface gaps to the user, don't redesign from this side.

### §11.1 What grammar provides

- Parser (`PlurnkParser`, ANTLR4-generated) — DSL text → `PlurnkStatement[]`.
- AST types (`@plurnk/plurnk-grammar`'s exported TypeScript interfaces).
- JSON schemas (`schema/*.json`, draft 2020-12) for every wire shape.
- The grammar's `plurnk.md` is the canonical model-facing description of the DSL.

### §11.2 What plurnk-service tracks in its own runtime state (NOT in the grammar)

- Channel lifecycle (`active` / `closed` / `errored`) — subscription registry, not on `ChannelContent`. Was rejected as a contract field with good reason: streams are not a distinct paradigm at the contract layer; they're a runtime relationship between an entry and an open connection.
- Render budget per channel (token count) — `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` operator config (§12).
- Backpressure caps — none in v0 (§7.8). Providers/schemes/mimetypes own their own throttling.
- Stream cancel verb — no dedicated cancel op or signal in the grammar. SEND[499] to the URI is the pattern (§7.7).
- Delete verb — no dedicated DELETE op. SEND[410] to the URI is the pattern (§3.5, §6.5).

### §11.3 Grammar contract changes (resolved)

All grammar issues filed against the upstream contract have closed and shipped. Service tracks the resolution:

- **#6 `text/vnd.plurnk`** — closed; DSL mimetype identifier confirmed.
- **#7 public `parsePath` helper** — closed; landed in grammar 0.3.2.
- **#8 SEND broadcast vs directed clarification** — closed; grammar plurnk.md docs tightened.
- **#9 packet contract + parse-error surface** — closed; grammar 0.4.0 renamed `packet.user.turn` → `packet.user.telemetry` and shipped the `{budget, errors}` shape. Service aligned in #123.
- **#10 Run.name + dual-handle** — closed; grammar 0.5.0 added required `Run.name`. Service aligned in #123.

When future gaps surface, they get filed as grammar issues (not redesigned in plurnk-service), and the relevant SPEC.md section notes the pending request.

---

## §12 Operator Configuration

Every plurnk-service deployment configures via env vars. Cascade: `.env.example` (shipped defaults) < `.env` (project) < `.env.<config>` (via `--config=`) < shell < CLI flags. `bin/plurnk-service.js` auto-loads `.env.example` so the daemon starts on `./bin/plurnk-service.js` with no setup required.

Model selection uses a separate alias cascade managed by `ProviderRegistry` (`src/core/ProviderRegistry.ts`): `PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an alias; `PLURNK_MODEL=<alias>` selects which is active. The first path segment of the value names the provider plugin (`@plurnk/plurnk-providers-<provider>`); the rest is the provider's own model identifier (may contain `/` for tri-level providers like openrouter's `publisher/model`). Aliases live in `.env`, not `.env.example`, since they're operator-specific. Rummy parallel: `RUMMY_MODEL_<alias>` cascade.

| Var                                  | Default            | Purpose                                                              |
|--------------------------------------|--------------------|----------------------------------------------------------------------|
| `PLURNK_DB_PATH`                     | `./plurnk.db`      | SQLite file path.                                                    |
| `PLURNK_HOST`                        | `127.0.0.1`        | Bind address for the daemon WebSocket. Local-only by default.        |
| `PLURNK_PORT`                        | `3044`             | TCP port for the daemon WebSocket.                                   |
| `PLURNK_MAX_TURNS`                   | `999`              | Per-loop turn cap (overridable per `loop.run` call).                 |
| `PLURNK_MAX_COMMANDS`                | `99`               | Per-turn op cap.                                                     |
| `PLURNK_RPC_TIMEOUT`                 | `30000`            | ms timeout for non-`longRunning` RPC handlers.                       |
| `PLURNK_LOOP_TIMEOUT`                | `86400000`         | ms wall-clock budget for a single `loop.run`.                        |
| `PLURNK_MAX_STRIKES`                 | `3`                | Strike threshold + sudden-death lead time (§0.5).                    |
| `PLURNK_MIN_CYCLES`                  | `3`                | Min repetitions before cycle detection fires (§0.5).                 |
| `PLURNK_MAX_CYCLE_PERIOD`            | `4`                | Max period length cycle detection examines (§0.5).                   |
| `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS`   | `256`              | Per-channel preview budget for index tiles (characters; §14.2).      |
| `PLURNK_DEBUG`                       | `0`                | When `1`, runs schema validation on every internal hop.              |
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
| `stream/event`     | `{ entryId, channel, state, contentLength }` | When a channel's content grows or its state transitions. For clients rendering live; the model only sees state at turn boundaries. {§13.6-stream-event-on-channel-change} |

The `stream/event` payload deliberately carries metadata, NOT content. Clients that want the new content call `entry.read({path})` to fetch — this avoids large notification payloads and gives the client agency over whether to refresh. Sample-driven (notifications include `contentLength` so clients can dedupe / batch).

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

---

## §14 Architectural decisions

Each entry: the question, the answer, the rationale, the migration path if revisited.

### §14.1 Packet assembly: engine-direct, not filter-chain

**Question.** Rummy assembles `<index>`, `<log>`, `<turn>`, `<system_commands>`, `<system_requirements>` via priority-ordered filter chains (`assembly.system` + `assembly.user`); plugins each filter for their data and append their section. Plurnk assembles `packet.system.index` directly in `Engine.#buildIndex` by querying visibility + entries + entry_channels and routing each channel's content through its mimetype handler; `packet.system.log` similarly via `Engine.#buildLog`. Both queries are engine-direct.

**Decision.** v0 stays engine-direct. The engine reads the DB and constructs the packet. Plugin-driven assembly is out of v0 scope. {§14.1-engine-direct-assembly}

**Rationale.**
- Plurnk's bundled extension set is small (3 entry-bearing schemes, 2 mimetypes, 1 provider). No current plugin wants to inject a packet section.
- The channel + mimetype split already gives substantial extensibility: scheme registers channels, mimetype owns rendering. Visibility lattice owns *which* channels appear. A filter chain on top of that would be paying for indirection nothing currently exercises.
- Rummy's pattern earns its keep through 25+ plugins each owning a tag. Plurnk's pattern earns its keep through schemes-as-URI-handlers + mimetypes-as-renderers. Different shapes; different consequences.
- The engine-direct path is testable end-to-end against real visibility/render-time behavior. The filter-chain path requires testing the composition of plugins, which is a separate axis of complexity.

**Migration path if revisited.** If a future plugin needs to inject a packet section (e.g., a `<turn>` metadata table per rummy SPEC §packet_structure), the engine grows a single `packet.augment` filter hook called after `#buildIndex` returns. Plugins subscribe with a priority; each returns a `system` and/or `user` augmentation object that gets merged into the packet shape. This is additive — the engine-direct base case stays; plugins augment.

### §14.2 Budget unit: character count for v0

**Question.** `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` is named for tokens; current implementation in `Engine.#previewBudget` treats it as a character-count cap passed to `MimetypeHandler.preview(content, budget)`. The MIMETYPES.md contract documents budget as a number, semantic-agnostic. The env var name and the implementation disagree.

**Decision.** v0 treats budget as character count. The env var keeps its `_TOKENS` suffix as forward-naming for the eventual switch but currently means characters. {§14.2-budget-is-characters-v0}

**Rationale.**
- Token counts require a per-provider tokenizer. PROVIDERS.md §11 marks `countTokens` as out of v0 contract; no provider currently exposes it.
- Character count is a tokenizer-independent first approximation. Wrong by a factor of ~3-4× for English (1 token ≈ 3-4 chars), but consistent and zero-config.
- Switching the unit later requires: (a) `countTokens` lands on the provider contract, (b) engine caches token counts per `(provider_id, content_hash)`, (c) mimetype.preview gets a tokenizer reference or returns content for engine to tokenize-and-truncate. Out of v0 scope.

**Migration path if revisited.** When provider `countTokens` lands and the engine has per-channel token accounting, `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` becomes literal tokens. Mimetype handlers either receive a tokenizer reference in `preview(content, budget, countTokens?)` or the engine post-processes character-bounded `preview` output through tokenizer + truncate. The MIMETYPES.md contract revision is non-breaking (signature stays `(content, budget) → string`); the semantic of `budget` changes from char-count to token-count.

---

## §15 Packet shape

The canonical packet shape is defined by `@plurnk/plurnk-grammar` (`schema/Packet.json`, ≥0.4.0). Engine assembles in `Engine.#buildPacket`; plugins do not augment in v0 (§14.1). This section describes plurnk-service's responsibilities under that contract — see grammar for the authoritative schema.

```ts
type Packet = {
    tokens: number;
    system: {
        tokens: number;
        system_definition: string;
        persona: string;
        index: PacketEntry[];               // visible entries (§4 / §5)
        log: PacketLogRow[];                // chronological action-entries (§7)
    };
    user: {
        tokens: number;
        prompt: string;
        telemetry: { budget: string; errors: object[] };   // §15.1
        system_requirements: string;
    };
    assistant: { tokens: number; content: string; ops: PlurnkStatement[]; reasoning: string | null };
    assistantRaw: unknown;
};
```

### §15.1 user.telemetry — model-facing runtime telemetry

The slot for telemetry the model MUST react to right now: budget pressure and last-turn failures that didn't produce an action-entry. Rendered prominently at the bottom of the user section so the model cannot ignore it. Errors here are transient — they appear on the turn AFTER the failure and clear once the model has seen them. The action-entries (`packet.system.log[]`) are the durable audit; `telemetry.errors[]` is the **alert**.

**Grammar contract (authoritative, plurnk-grammar 0.4.0):**

- `budget: string` — text/markdown. Renderer-provided summary of remaining context / cost / etc. Empty string when nothing to surface.
- `errors: object[]` — element shape intentionally open at v0. Consumers populate as actionless-failure rendering needs solidify. Empty array when no errors to surface.

**Plurnk-service rendering (v0):**

- `budget` is rendered as a short markdown line. Unit follows §14.2 (character count); the exact rendering is engine-internal and may evolve without a schema change.
- `errors[]` carries one object per actionless failure from the previous turn. Service's working element shape (subject to tightening as needs solidify):
    ```
    { kind: "parse" | "dispatch_crash" | "no_send" | "watchdog" | "budget_overflow" | "rail",
      message: string,
      detail?: unknown }
    ```
- Action-bound failures (handler returned 4xx/5xx or threw) are mirrored as a one-line summary object into `telemetry.errors[]` on the next packet — same forced-confrontation pattern. Full detail stays queryable via `log://`. {§15.1-no-error-scheme}

**No `error://` scheme.** Actionless failures route to telemetry, not to a queryable scheme namespace.
