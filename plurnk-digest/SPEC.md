# Forensic reports

The report package (`@plurnk/plurnk-digest`) owns artifact generation, SQLite snapshots, and requested model interviews. The host supplies the evidence reader and selects any interview provider; the package never boots or imports the daemon.

## §digest-evidence-reader 1. Evidence Boundary

| Owner | Responsibility |
| --- | --- |
| Core `EvidenceReader` (`@plurnk/plurnk-service/evidence`) | Package-owned SQL, stored-packet validation, canonical wire and address projection, canonical request accounting, packet-echo classification, and text weight. |
| `@plurnk/plurnk-digest` | Typed read interface, report selection/grouping, Markdown/JSON/artifacts, consistent snapshots, and out-of-band interviews. No dependency on core or its private types. |
| Composition (CLI, daemon, harness) | Database/output paths and an explicit provider when an interview is requested. |

- **Reader lifecycle**: `openEvidence(path)` returns a disposable reader (`rows()` supplies the relational census and durable source rows; packet, response, and transport bodies are fetched individually, caching at most one packet). No connection or prepared statement escapes it. Report failure closes the reader; interviews close it before awaiting their provider. Neither migration nor deletion is a read effect.
- **Proposal decisions & expired payloads**: Operation rows retain the original approval decision separately from their applied result ({§proposal}): Markdown names decision, resolver, time, and body override; JSON retains the complete submitted decision (missing historical decisions remain absent). Physical-request reports preserve identity, retirement timestamp, and accounting after payload retention ({§content-store}) without turning expired failed/unpriced requests into free or absent ones.

## §share-packet-names 2. Artifacts, Snapshots, and Programmatic Surface

- **Database health**: Beside the database path, the digest reports file size, free pages, `auto_vacuum` mode, and the six largest tables and indexes by allocated bytes (`dbstat`), tolerating databases missing later loop lifecycle columns.
- **Turn coordinates & workspace folders**: Digest retains every selected turn with exact `ops`/`reasoning` source, a valid stored provider request, or malformed stored packet evidence in durable chronological order. Files are named `<session>-<loop>-<turn>` matching `log:///<loop>/<turn>/…` (the model's first turn in loop 1 is `<session>-1-2` because turn 1 is the initialization survey). Multi-workspace digests nest files in slugged workspace folders (e.g. `~/ptl/x` $\to$ `ptl-x`, disambiguating collisions by row id); `digest.json` records each turn's stem as `artifact`.
- **Navigation & quoting**: The main Markdown report links each turn's input, output, reasoning, and physical requests outside code fences using relative links. Request pages link back to the digest, previous/next session requests, and exact channel files, distinguishing physical outcomes from emission admission and BARE calls. When no message sections remain, the reader returns no messages and the request page names that absence without synthetic empty files. Forensic Markdown quotes bodies with a longer fence so embedded headings/fences cannot conceal later records.
- **Snapshots & programmatic surface**: `Share.snapshot(dbPath, copy)` copies a database via SQLite (never filesystem byte copy, which drops WAL pages; refuses existing `copy`), paired with `Share.write({ openEvidence, dbPath, folder, workspaceId?, requiem? })`. Importing `@plurnk/plurnk-digest` (`Digest`, `Share`) performs no I/O. `run({ dbPath, openEvidence, digestDir?, sessionId?, workspaceId? })` writes to `./test/digest` by default, refusing non-empty `digestDir` (and `requiem` refuses existing `requiem.json`/`requiem.md`) before I/O ({§share}). `digest.json` is promoted from a partial file only after every artifact is written. `sessionId` and `workspaceId` narrow all dependent records (intersecting when both are supplied).

| Artifact | Present when | Authority |
| --- | --- | --- |
| `<stem>.request.md` / `<stem>.wire.json` | Turn stored a provider request / message sections retained | Ordered text-message envelope from `EvidencePacket.messages()` ({§packet-assembly}), excluding native payloads, provider controls, and transport transforms (`<stem>.wire.invalid.json` when log projection fails). |
| `<stem>.assistant.md` / `<stem>.reasoning.md` | Turn has `ops` / `reasoning` source | Exact `turn_sources.content`, independent of log curation. |
| `<stem>.system.md`, `<stem>.user.md` | Request message sections retained | Role-filtered text projections for extraction. |
| `digest.json` turn `attachments` | Every turn | Stored native attachment descriptors (`[]` = no attachments, `null` = no valid stored request). |
| `<stem>.assistantRaw.json` / `<stem>.response.md` | Admitted provider response / no admitted response | Stored opaque provider response, or stored request and attempt state. |
| `<stem>.packet.raw.txt` / `<stem>.packet.invalid.json` | Stored packet fails typed validation | Exact stored packet text and turn identity + validation error chain. |
| `requests/<id>.md`, `.json` | Every physical provider request | Request identity, disposition, accounting, and response/failure evidence ({§provider-interface}). |

## §digest-forensic-fidelity 3. Metrics, Cache Ledger, Edit Census, and Fidelity

| Metric / Surface | Contract |
| --- | --- |
| Cost line (`Cost:`) | Labels basis `(charged)` only when every settled request is provider-charged, or `(estimated — catalog rates)` when any is estimated; counts settled requests with no usage (errored/aborted) so unrecorded spend is never silently priced as zero. |
| Wire line (`Wire:`) | Renders total physical provider requests, error-outcome count, and error percentage when nonzero. |
| Room line (`Room:`) | Over packet-bearing requests with known input capacity, wall, and provider count (preflight measurement, else reported input): names largest budget shown converted at `count ÷ weight` as a share of capacity, wall estimate range (`weight × capacity ÷ budget`) against count, and marks with `⚠` requests estimated under the wall while count was over it ({§tokenomics}); `(no measured requests)` when none. |
| Cache ledger (`Cache:`) | `digest.json` records exact `cachedTokens` and `inputTokens` (`null` when absent) plus loop-local `adjacentPrefixTokensEstimate` (weighted longest common character prefix with preceding emission packet $\times$ `inputTokens`; `0` on first request, `null` on BARE or missing packet/input). Turn renders `cache=<cached>/<input>` (`?` if any omitted); workspace sums requests reporting both counters (`<pct>%`, or `n/a` on zero input) and counts excluded requests separately. |
| Edit census (`EDITs:`) | Classifies every model-authored EDIT row into `hash` (1 anchor), `line` (1 line number), `range` (2 marks), `insert` (`<L,1,L,1>`, {§zero-width-column-one-insert}), `column` (other 4-mark), `prepend` (`<0>`), `append` (`<-1>`), `offset` (anchor offset, {§op-methods-op-dispatch}), `pattern` (selection matcher), or `whole` (no marker; creation on 201), counting total, `refused` (status $\ge 400$), and `revisits` (same path edited within previous 2 model turns); stamps `edit_census` on sessions and `edit_form`/`edit_revisit` on EDIT log entries. |
| Session summaries & waterfall | Counts `Emissions:` (announced, KILLed, echoed headings) and `Reasonings:` (landed, KILLed, turns that reasoned; distinguishes readable content from token-only reasoning usage) ({§turn-source-resources}). JSON preserves every log event (initial/current projection, `source`, `attrs`, log-KILL target effects, exact Problem, optional `inherited_history` and `ambient_event_id`), loop lineage, request ledger, and full target authority (`https://host/path`). Markdown waterfall groups consecutive identical per-turn op outcomes and `entry_materialized` narrations by `(source, target)` as `xN (seq A-B)`. |
| Executor & capacity evidence | Failed command completion rows (`https://problems.plurnk.xyz/executor/*`, {§engine-rails}) and capacity contract `413` rows ({§tokenomics}) render in the waterfall but never count toward a loop's error total, error-item count, health verdict (`CLEAN`), or per-turn `errs=` badge. |

## §digest-requiem 4. Requiem Interviews

A requiem is an out-of-band forensic interview over each session with model-bearing inference turns, using an explicitly supplied witness provider and the session's durable provider identity ({§machine-processes}) as `sessionId`.

- **Evidence budget**: Quotes the session's final packet plus every attempt's normalized response and admission evidence, budgeted against the witness's `contextWindow` minus retry output allowance and system framing (`chars / 2`); overflow elides oldest attempts behind an explicit `elidedOldestAttempts` marker (unbudgeted when `contextWindow` is `null`).
- **Execution & artifacts**: Makes one call at `PLURNK_DIGEST_REQUIEM_MAX_TOKENS`, retrying once at `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS` only on an empty length-limited response. Materializes `requiem.json` (logical call state, messages, normalized responses, physical request accounting) before each call and `requiem.md` (testimony and nullable USD accounting) on completion.
