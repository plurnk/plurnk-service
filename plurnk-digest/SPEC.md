# Forensic reports

The report package owns artifact generation, SQLite snapshots and requested model interviews.
The host supplies the evidence reader and selects any interview provider; the package never boots
or imports the daemon.

## Evidence boundary

§digest-evidence-reader **Interpret once, render independently.**

| Owner | Responsibility |
|---|---|
| Core `EvidenceReader`, exported at `@plurnk/plurnk-service/evidence` | Package-owned SQL, stored-packet validation, canonical wire and address projection, canonical request accounting, packet-echo classification and text weight. |
| `@plurnk/plurnk-digest` | Typed read interface, report selection/grouping, Markdown/JSON/artifacts, consistent snapshots and out-of-band interviews. No dependency on core or its private types. |
| Composition (CLI, daemon, harness) | Database/output paths and an explicit provider when an interview is requested. |

`openEvidence(path)` returns a disposable reader. `rows()` supplies the relational census and
durable source rows; packet, response and transport bodies are fetched individually. A packet view exposes canonical
text slots and messages without publishing the stored packet algebra. The reader caches at most
one packet. No connection or stored statement escapes it. Report failure closes the reader;
interviews close it before awaiting their provider. Neither migration nor deletion is a read effect.

## Artifacts and reports

§digest-storage **The digest states the file's health.** Beside the database path it
reports the file size, the free pages it holds, its `auto_vacuum` mode, and the six
largest tables and indexes by allocated bytes (`dbstat`), so growth is a number in
every digest (#764). The digest reads loops as stored, so it tolerates databases
missing later lifecycle columns.

§digest-turn-artifact-identity **Digest packet artifacts project durable turns.**
After selectors are applied, digest retains every turn with exact content or reasoning source, a
valid stored provider request, or malformed stored packet evidence; orders those
turns by durable chronology; and names each by its log coordinate ({§share-packet-names}). The
producer does not affect projection.

§share-packet-names **Packet artifacts carry the coordinate the log uses.** A turn's files are named
`<worker>-<loop>-<turn>`, the worker's name and the loop and turn sequences that `log:///<loop>/<turn>/…`
addresses: the model's first turn in its first loop is `<worker>-1-2`, because the initialization
survey is turn 1 and writes no packet. A digest spanning several workspaces nests each workspace's
files in a folder named for it; a name that cannot name a file (a workspace named by its path,
`~/ptl/x`) is slugged for the folder, `ptl-x`, while the digest text keeps the name verbatim, and
two names that slug alike are told apart by the row's id. `digest.json` records each turn's stem as `artifact`, so no
consumer reconstructs a name. A name that cannot be a file name, or two turns sharing one, fails.

| Artifact | Present when | Authority |
|----------|--------------|-----------|
| `<stem>.request.md` | The turn stored a provider request | Ordered text-message envelope from `EvidencePacket.messages()`, with numbered role headings and full, literal bodies; not a transport capture. The turn waterfall names this file and its role sequence. |
| `<stem>.assistant.md` | The turn has an `ops` source | This turn's output: exact `turn_sources.content`, independent of log rows; not assistant history in the request |
| `<stem>.reasoning.md` | The turn has a `reasoning` source | Exact `turn_sources.content`, without relabeling it as content |
| `<stem>.system.md`, `<stem>.user.md` | The turn stored a provider request | Role-filtered text projections for extraction; not the complete request or its message boundaries. Native parts are not Markdown. |
| `<stem>.wire.json` | The turn stored a provider request | The same ordered text-message envelope as `.request.md` ({§packet-wire-envelope}), in JSON; not dispatched HTTP bytes. Both exclude native payloads, provider controls, and SDK/transport transformations; `<stem>.wire.invalid.json` names a stored log that cannot be projected. |
| `digest.json` turn `attachments` | Every turn | Stored native attachment descriptors; `[]` means a request without attachments, `null` means no valid stored request. Selection is not proof of provider acceptance. |
| `<stem>.assistantRaw.json` | The request has an admitted provider response | Stored opaque provider response |
| `<stem>.response.md`, attempt artifacts | The request received no admitted response | Stored request and attempt state |
| `<stem>.packet.raw.txt` | The stored packet fails typed validation | Exact stored packet text |
| `<stem>.packet.invalid.json` | The stored packet fails typed validation | Turn identity and complete validation error chain |

A source-backed turn without provider participation produces only its source-channel
artifacts; a request-only turn produces no fabricated assistant. A
source-less programmatic turn with no provider request has no forensic payload
to project and writes no files.

§share-snapshot **A database is copied by SQLite, never by the filesystem.** `Share.snapshot(dbPath, copy)`, exported as `@plurnk/plurnk-digest` with `Share.write({ openEvidence, dbPath, folder, workspaceId?, requiem? })` (`requiem` is an explicitly supplied provider), is the one consistent copy: a byte copy of a WAL-mode database drops every committed page still in its `-wal` file. A harness that keeps the database beside its digest takes it through `snapshot`; an existing `copy` is refused.

§digest-programmatic-surface **The digest is an importable forensic surface.**

| Surface                                | Contract                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import `@plurnk/plurnk-digest` | Ships `Digest`, `Share` and typed evidence inputs; importing performs no I/O or process action. Callers invoke it explicitly.             |
| `run({ dbPath, openEvidence })`                      | Reads the required database and writes a complete digest to `./test/digest` relative to the caller's working directory.                             |
| `digestDir`                            | Selects a nonempty output path. `run` refuses a folder that exists and is not empty, and `requiem` refuses an existing `requiem.json` or `requiem.md`, before database or provider I/O; neither deletes ({§share}). Concurrent callers use distinct folders. |
| Reader lifetime                       | `run` reads heavy evidence on demand while rendering, then closes its reader on success or failure. `requiem` closes its reader before awaiting witness inference. |
| Export completion                     | Packet and response bodies are read and serialized one record at a time, without discarding evidence. `digest.json` is promoted from a partial file only after every artifact is written; its absence identifies an incomplete export. |
| `workerId`                             | Narrows workers and every dependent loop, turn, turn-attached logical inference, specialization, physical request, and log row to that one worker. |
| `workspaceId`                          | Narrows workers plus every logical inference and dependent evidence owned by one workspace, when both selectors are present they intersect. |

§digest-cost-kind **Cost basis named.** A rendered Cost line carries the basis of its dollar figure: `(charged)` only when every settled request's cost is provider-charged; `(estimated — catalog rates)` when any settled request's cost is an estimate, because a mixed sum is no more trustworthy than its weakest term. A dollar figure without its basis reads as billed truth, and an estimate must never impersonate a charge.

§digest-wire-line **Wire health aggregated.** Each worker summary renders a `Wire:` line — total physical provider requests, error-outcome count, and the error percentage when nonzero. Provider-level failures are absorbed by retries below the packet stream, so without this aggregate a rate-limit storm is invisible in every summary while the model's experience stays clean.

§digest-room-line **The room in provider tokens.** Each worker summary renders a `Room:` line over its packet-bearing inference requests that record a known input capacity and wall and a provider count: the exact preflight measurement, else the reported input. It names the largest budget the model was shown, converted at that request's own ratio (`count ÷ weight`), as a share of the capacity; the range of the wall's estimate as the packet's conversion reconstructs it (`weight × capacity ÷ budget`) against the count; and, marked ⚠, the requests the estimate put under the wall while the count was over it ({§context-wall-measure}). A worker without such requests reads `(no measured requests)`. Every run checks the ruler, pass or fail.

§digest-cache-ledger **Measured cache reuse and estimated prompt overlap are separate.**

| Projection | Meaning |
|---|---|
| `digest.json` provider-request `cachedTokens`, `inputTokens` | Exact provider-reported cache reads and input tokens; absent quantities remain `null`, reported zero remains zero. Every physical request counts, including retries and first requests of new loops. Stored packet availability is irrelevant to these counters. |
| Turn `cache=<cached>/<input>` | Sum each measured quantity over that turn's requests. If any request omits a quantity, that sum is `?`. |
| Workspace `Cache: <cached> of <input> reported input tokens read from cache (<pct>%) over <n> requests` | Sum only requests reporting both counters. Percentage is cache reads / input, rounded to one decimal; zero input is `n/a`. Requests missing either counter are counted separately as `missing input or cache usage (excluded)`. |
| `digest.json` provider-request `adjacentPrefixTokensEstimate` | Optional loop-local diagnostic: the longest common character prefix with the preceding request, weighted under {§tokenomics-agnostic-ruler} as a share of the current stored prompt, multiplied by reported input tokens. First request: `0`; missing current/preceding packet or current input: `null`. Empty prompts have zero overlap. |

The prefix estimate uses the stored emission packet's wire message order, roles
and content. A BARE request's input is not that packet; its prefix estimate and
the following request's comparison are unknown. The estimate is
neither provider tokenization nor a cache ceiling, and never supplies a cache-ratio
denominator. Caching across loops or against other provider-resident prefixes
does not make the measured counters inconsistent.

§digest-edit-census **Every model EDIT by the form it authored, how it landed, and whether it came back.** For each worker the digest reads every model-authored EDIT row and classifies the form from the row's stored marker and the durable statement's pattern: `hash` (one anchor), `line` (one line number), `range` (two marks), `insert` (the zero-width `<L,1,L,1>` form, {§zero-width-column-one-insert}), `column` (any other four-mark region), `prepend` / `append` (`<0>` / `<-1>`), `offset` (a tolerated anchor offset, {§anchor-offset}), `pattern` (a selection matcher), `whole` (no marker: a creation when it lands 201). It counts the EDITs, those refused (status ≥ 400), and the *revisits*: an EDIT of a path the same worker had edited within its previous two model turns — the shape of a repair without the claim of one. Each worker summary renders `EDITs: <n> · <form>=<count>… · refused=<k> · revisits=<r>` (`(no edits)` for none); `digest.json` carries the census as `edit_census` on every worker and stamps every EDIT log entry with its `edit_form` and `edit_revisit`. A form is a fact about what was written, never about intent; the bench sheet reads the counts as friction and leaves the judgement to the reader.

§digest-forensic-fidelity **Forensic fidelity and cardinality.** The digest's machine-readable JSON preserves every log event with its initial and current projection, causal `source`, and structured `attrs`; every exact log-KILL target effect; the exact Problem on every failed row; each loop's exact terminal result, settlement time, scheduled due time, recurring interval, and recurrence lineage; and every ordered physical provider request. Programs still produce chronological `assistant.md` artifacts after every READ receipt is KILLed; source is independent of log curation. Each worker summary's `Emissions:` line counts its announced emission rows, those the worker KILLed, and the headings it echoed ({§emission-row}); its `Reasonings:` line counts its landed reasoning rows, those the worker KILLed, and the turns that reasoned ({§reasoning-row}); the op mix leaves both harness rows out. Each stored packet validates independently: one malformed historical packet remains exact raw evidence with its complete validation error chain and never prevents healthy turns from being projected. Accounting on broader rows is the shared exact derivation from that ledger, never a second stored fact. A worker's Cost line names how many settled requests carry no usage at all (errored or aborted exchanges) — their server-side spend is unrecorded rather than silently priced as zero. The reasoning chronology distinguishes readable reasoning content from provider-reported reasoning usage: when tokens were reported but no readable content was returned, it states both facts instead of implying that no reasoning occurred. The human Markdown waterfall shows a present causal source and may preview only the Problem detail because it remains a triage projection, not the machine record. Targets reconstruct the model-visible address, including hostname, port, serialized query, and fragment; an authority-bearing URL must never degrade from `https://host/path` to `https:///path`, and durable resource coordinates render back to their authority form. Its human Markdown waterfall groups consecutive identical per-turn op outcomes and typed `entry_materialized` narrations, reporting the exact count and sequence span (`xN (seq A-B)`). Grouping keys include source and the complete target, so distinct causes, authorities, or channels never collapse, and non-consecutive events preserve their chronological order. Thus amplification is conspicuous without making the diagnostic artifact itself pathological; valid packet files remain byte-identical records of what the model saw.

Unrecognized actionless log rows are retained and labelled as such, not
interpreted as executable turnOps or allowed to prevent the remaining digest.

Log JSON preserves `inherited_history` and `ambient_event_id` when the evidence
reader supplies them. A copied model-origin row is history, not a new authored
operation; multiple observers may retain the same ambient occurrence. An absent
field in an older export or reader means unknown, not `false` or `null`.

§digest-executor-evidence **A red command is work, not a defect.** Engine-materialized
completion rows for a failed command carry the executor's problem identity
(`https://problems.plurnk.xyz/executor/*`), and the digest classifies them as
evidence: they render like any row but never count toward a loop's error total,
its health verdict, or the per-turn `errs=` badge — a loop that concluded green
over red test runs is CLEAN, not DEGENERATE-WIN. This is the digest mirror of the
strike rail's exemption ({§engine-rails}, #425 F1): structural violations count,
executor evidence never does.

§digest-requiem **A requiem is an out-of-band forensic interview, not a worker
turn.** It cannot execute operations or alter the audited history.

| Aspect    | Contract                                                                                                                                                        |
|-----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Scope     | One interview for each worker with model-bearing inference turns; workers without inference evidence are omitted.                                                |
| Evidence  | The worker's final packet plus every attempt's exact normalized response and admission evidence; opaque raw transport remains in durable forensic artifacts. Quoted evidence is budgeted to the witness window ({§digest-requiem-evidence-budget}). |
| Witness   | An explicitly supplied provider; CLI composition may resolve the active configured provider. Absence fails hard; the report package never selects a route.                                                                          |
| Identity  | The worker's durable provider identity ({§worker-provider-identity}) is sent as the `workerId`, without asserting a live worker topology. |
| Attempts  | One call at `PLURNK_DIGEST_REQUIEM_MAX_TOKENS`; only an empty length-limited response receives one retry at `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`.         |
| Artifacts | `requiem.md` carries testimony and exact nullable USD accounting. `requiem.json` is durably materialized before each call and preserves logical call state, messages, normalized responses, every physical request's state and accounting, and their shared aggregate projection. |

§digest-requiem-evidence-budget **Quoted evidence fits the witness.** The
interview's user message is budgeted against the witness provider's context
window minus the retry output allowance and system framing (chars/2, the
capacity gate's own estimator). Overflow elides the oldest provider attempts
behind an explicit `elidedOldestAttempts` count marker, never silently; the
final packet and the newest attempts always testify. A windowless witness
(`contextWindow` null) quotes unbudgeted.
