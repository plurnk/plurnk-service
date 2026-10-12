# @plurnk/plurnk-service

## 3.2.0

### Minor Changes

- 0e495aa: Persist approval decisions before applying effects, retain their resolving
  authority and submitted overrides independently of operation results, and expose
  that evidence in forensic reports.
- 0e495aa: Apply response retention to complete provider-request payloads without deleting
  identities or accounting. Record expiry explicitly, and collect native snapshots
  only after retained history and in-flight publication release them.
- a2c2bf4: Resolve authored `~` and `~/…` file operands from the daemon user's home,
  then translate them to project-relative addresses. Membership and mutation
  authority are unchanged. Literal tilde names retain their stored identities
  and render with `./` so displayed addresses can be reused safely.
- 0b7f8b1: Add shared named definition replacement, retaining enabledness and preserving
  the previous publication on refusal. Use it for repeated environment EDITs
  and explicit child environment overrides, and reject fresh skill preparation
  failures when their definitions change. Carry attempt-local admission data
  through preparation without changing live state; schedule replacements and
  retries affect timers and held delivery failures only after publication.
- e7f2a97: The log target reader accepts four near-misses of the taught form and reads
  each as the one target it can only mean: a `|` between complete coordinates,
  bare or as full `log:///` addresses, as their union; a bracketed comma list in a
  numeric slot as a set; a non-numeric literal in a numeric slot as the leaf with
  the missing slots `*`; and `*` segments between the sequence and the leaf as
  dropped. A sweep that matches nothing stays a bare 204; the refusal of a target
  nothing can read shows the coordinate shape as its recovery.

### Patch Changes

- The `continued_without_note` directive quotes the card's revised per-turn rule, "YOU
  MUST record at least one NOTE along with other operations."
- d8a45b0: Resolve bulk EDIT and resource KILL selectors before mutation, preserving
  per-resource approvals, scopes, anchors and receipts. Require a single resolved
  resource for each COPY/MOVE glob operand before changing either side. Keep
  selected channels through fan-out and count concrete operations against
  configured command limits.
- 617bcd0: Keep orphan-message recovery with the worker drain that owns its admission and
  cancellation ordering. Preserve the existing durable recovery and restart behavior.
- 58ec287: Distinguish an unknown environment-discovery source from a known package with no
  matching declarations, with a recovery pointing to catalog selection and ordinary
  file reads.
- d395298: Validate captured file revisions before native edits, transfers, and deletion;
  serialize same-path commits and publish complete replacement files without
  truncating the original on a failed write. Retain MOVE source revisions across
  approval, preserve external replacements during rollback, and publish file
  projections together with their source revisions. Existing databases retain
  their contents and rematerialize file revisions after upgrade. Preserve original
  I/O failures alongside resource-cleanup failures.
  Rollback validates the published physical file rather than a subsequently
  retargeted alias.
- 05e38b8: Resolve encoded file URLs through native filesystem interpretation without
  double-decoding stored names. Reads, mutations, client attachments, catalogs,
  packets and digest addresses share the same identity. Render ambiguous filenames
  as reusable file URLs while keeping ordinary paths project-relative.
  Keep MOVE source approval bound to the source operand after its destination lands.
- 42058d0: Teach separate status, finding, decision, and plan NOTEs and explicitly addressed
  message completion. Align continuing-turn notices with the revised NOTE instruction.
- 66fcb98: Preserve literal backslashes and escaped glob characters consistently in resource
  selection, file-URL selectors, membership scans, inspection and SQL membership
  checks. Use the standard glob engine instead of Node's fixed separator handling.
- fc84b9a: Clarify ambient credential exclusion versus explicit MCP launch bindings through
  the existing approval path. Correct reserved-environment diagnostics and reference
  documentation without changing credential admission or adding configuration.
- 63b0be8: The over-budget mandate row is shown once, in the packet it describes, then
  retired from the packet projection as a no-match KILL receipt is; it stays
  durable and readable at its coordinate, and a later packet that is over budget
  carries its own row.
- 3ddd59f: Clarify data-preservation boundaries, retention scope and database durability;
  verify that response-body retirement preserves physical-request evidence and
  accounting.
- 7163937: Document existing failure codes omitted from the owning specifications. Runtime
  behavior and failure identities are unchanged.
- ea11475: Default database commits to FULL WAL synchronization through SqlRite 6.6.1.
  Expose PLURNK_SERVICE_SQLITE_SYNCHRONOUS for explicit durability/performance choices,
  apply it before migrations and startup writes, and diagnose invalid modes through
  configuration checking.
- 8f3ed44: Preserve the source type when COPY or MOVE creates a channel at an untyped
  destination, including binary files with unknown or absent extensions. Retain
  existing and declared channel types and recognized destination-extension
  compatibility checks through proposal review, publication, and unchanged-source
  reprojection.
  Allow a dynamically typed default channel beside explicitly typed sibling channels.
- Updated dependencies [d8a45b0]
- Updated dependencies [f044435]
- Updated dependencies
- Updated dependencies [960777f]
- Updated dependencies [f3d34f1]
- Updated dependencies [0e495aa]
- Updated dependencies [0e495aa]
- Updated dependencies [05e38b8]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [66fcb98]
- Updated dependencies [fc84b9a]
- Updated dependencies [f951f40]
- Updated dependencies [7163937]
- Updated dependencies [8f3ed44]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-meta@2.1.1
  - @plurnk/plurnk-providers@3.0.2
  - @plurnk/plurnk-models@3.0.1
  - @plurnk/plurnk-mimetypes@3.0.2
  - @plurnk/plurnk-mimetypes-application-xml@2.0.2
  - @plurnk/plurnk-mimetypes-text-html@2.0.2
  - @plurnk/plurnk-mimetypes-audio@2.0.2
  - @plurnk/plurnk-a2a@3.1.1
  - @plurnk/plurnk-parser@3.0.3
  - @plurnk/plurnk-contracts@3.2.0
  - @plurnk/plurnk-digest@3.2.0
  - @plurnk/plurnk-modules@3.1.0
  - @plurnk/plurnk-skills@3.0.1
  - @plurnk/plurnk-mcp@3.0.1
  - @plurnk/plurnk-schedule@3.0.1
  - @plurnk/plurnk-execs@3.1.1
  - @plurnk/plurnk-execs-jq@2.0.2
  - @plurnk/plurnk-execs-sqlite@2.0.2
  - @plurnk/plurnk-schemes@3.1.1

## 3.1.0

### Minor Changes

- 0060c82: Run each hosted A2A Task in an ordinary child worker, with related conversation
  available as a retained Context resource. Tasks can progress and be cancelled
  independently without an extra Context worker or a second execution manager.
  Each streaming request observes its own initial snapshot and the durable result.
  
  Support an exact unfinished Loop recipient on the application message boundary;
  late continuations cannot reopen completed Tasks. Make simultaneous first model
  selections reuse the same immutable route instead of failing a uniqueness check.
- 0a3b974: Warn the model before its context exceeds the budget: a packet above
  `PLURNK_SERVICE_BUDGET_PRESSURE` that stays within its budget carries one
  `budget_pressure` notice, "Context is at N% of budget. YOU MUST NOT exceed
  budget.", its share taken from the Context gauge's own figures.
- 9e0a3b2: The environment registry is an address space, the env family's own face: every
  name in effect for a Worker's commands is a resource at `env:///NAME` whose body
  is its value, so FIND lists it, READ shows it, COPY carries it into a file or an
  entry, EDIT sets it and KILL retires it. Writes land on the Worker's own layer,
  never the workspace's or the operator's: EDIT is the family's `add` for the
  Worker, KILL its `remove` for an entry the Worker owns and its `disable` for one
  it inherited. A reserved name is refused as it is at `add`. A runtime scheme
  facet may now own writable resources: `RuntimeSchemeFacet` takes `editBatch` and
  states `writableBy` in its manifest, and the writer gate reads the manifest that
  governs the coordinate.
- 6f0c86e: Render a FIND's match locations in the scope notation the model writes: each
  location reads `{"region":"<48,1,48,25>","matched":"…"}` instead of a
  four-field region object, and names its `channel` only when that is not the
  resource's default channel. A broad FIND's single-match locator reads the same
  way. The structured `results` keep their typed regions and channels.
- 9742599: Text the model writes outside its fences, beside at least one fenced operation,
  is its NOTE at that position: one NOTE per span between operations, frozen in
  the emission, landed as a NOTE row, replayed with its turn, and told nothing
  about; an echoed emission heading in that text is dropped, not annotated. A turn
  that fences no operation keeps its text as the turn's outside source and stays
  an empty turn with its one error row, which is the only thing the model hears of
  it. The `outside_text` notice is gone.
  
  The per-turn rule is the card's line, `YOU MUST emit at least one NOTE operation
  with a complete status summary and at least one other operation per turn.`, and
  the daemon's `continued_without_note` and `noted_without_operation` notices
  quote it; both are notices at warn, never strikes.
  
  A line scope on an emission row addresses its legend: the NOTEs on the selected
  lines retire and the row stays; on a row with no legend lines the scope is
  refused with `emission-curated-whole`, whose recovery names the unscoped KILL,
  the one form that retires the row.
  
  The opening survey begins by reading its own program (`READ
  (ops://<worker>/<loop>/1)`), so the log carries one program verbatim and every
  `ops://` turn is shown readable.
- 1d585b4: Render each notice in the model packet as one alert callout in the card's own
  form: the level picks the callout, an optional `directive` (`YOU MUST`,
  `YOU SHOULD`, ...) leads, then the factual message and the kind. Notices about
  the model's own output carry a directive; environment notices carry none.
- 7a678da: Replay each turn of the loop as the NOTEs it wrote, in the model's own voice:
  one assistant message between the turn's emission record and its results,
  holding every content NOTE whole and in order. Every other operation is omitted;
  its receipt in the log is its record and the program stays readable at `ops://`.
  A replayed turn's emission row carries the legend of its NOTEs, one numbered
  line per NOTE with its `log:///` path and weight, and those NOTE rows render
  nowhere else; retiring a NOTE row retires it from the replay too. A turn that is
  not replayed, an earlier loop or a program omitted at the wall, shows its NOTEs
  as ordinary rows: a NOTE's text is in the packet once, as replay or as row.
  Preserve native attachments, cache-prefix stability, capacity accounting, and
  historical request roles.
  
  Expose message roles in packet section drafts. Preserve retained packet sections
  and their content-addressed items when upgrading the database.
  
  Add a readable, ordered request artifact and show each turn's input role
  sequence in the digest, distinguishing assistant input history from newly
  emitted output.
- 9f8e27b: Add `Knob.family(prefix)`, and recap lines: each
  `PLURNK_SERVICE_RECAP_LINE_<alias>` renders as one directive callout ahead of
  the recap source, and an empty value turns a shipped line off. None ships.
- 143eb55: Treat a command's exit code as its answer: a subprocess that exits resolves
  200 with its `exitCode`, zero or not, with no Problem, so a failing test run or
  a `grep` that matched nothing no longer appears in Errors. A process ended by
  a signal nobody sent it is a `terminated-by-signal` failure.
  
  Report a failed execution once: its status and Problem ride one conclusion
  row, and its other channel rows are plain reads. A stream stopped by its
  holder's own KILL concludes 200 instead of a 499 cancellation; a cancellation
  the holder did not ask for keeps its 499. A tool named as a shell command is
  core's `404 program-is-a-tool` receipt.

### Patch Changes

- 871fcf5: Hold one calibration factor per loop: a loop's first settled response fixes the
  conversion from provider capacity into the curation budget for the rest of the
  loop, and until then its packets use the model's most recently fixed factor.
  The budget the model sees changes at most once in a loop, not on every turn.
- 81f49f6: Report refused range syntax without inventing a replacement query. Resolve
  operator grammar filenames relative to the daemon's working directory.
- 1734172: Preserve inherited-history and ambient-event provenance in forensic log exports.
- 7de7f76: Link packet and physical-request evidence through readable Markdown. Preserve
  failure and missing-evidence distinctions; support opt-in capture of final
  SDK-dispatched request bodies while omitting headers and URL details.
- 693d96a: Preserve scheme addresses, channels and literal delimiters in initial context
  reads. Validate malformed resource addresses before admitting the message.
- 7e1902e: Lead the initialization program with one NOTE when its surveys run, so the first
  example turn keeps the NOTE-per-turn teaching. Tell a continuing or parked model
  turn that carried no NOTE forward with one notice in the next packet; the notice
  never fails a turn or counts toward the strike rail.
- f919ff3: Deliver a targetless SEND with no Open Message to the loop's latest message as speech:
  it reaches the originating client and changes no message outcome. A loop with no
  published message still refuses it.
- c74b67d: Show a runtime's catalog aside as its fenced operation with real newlines, so
  the row's JSON escapes each once. Format the extent of a channel READ that
  carries its execution's failure like any other retrieval (`3 lines`). Lead an
  EDIT receipt's `change` with its unit (`lines -7 +7`).
- a1f12a9: Order the packet's status clump by what each section asks of the turn: Git
  Status, Context, Worker and Delegation, then Open Messages, then Notices and
  Errors, closing with the Recap.
- Updated dependencies [0060c82]
- Updated dependencies [a77e136]
- Updated dependencies [6769a6a]
- Updated dependencies [81f49f6]
- Updated dependencies [1734172]
- Updated dependencies [7de7f76]
- Updated dependencies [9e0a3b2]
- Updated dependencies [d6fe979]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [7a678da]
- Updated dependencies [705eff4]
- Updated dependencies [9f8e27b]
- Updated dependencies [143eb55]
  - @plurnk/plurnk-a2a@3.1.0
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-providers@3.0.1
  - @plurnk/plurnk-parser@3.0.2
  - @plurnk/plurnk-digest@3.1.0
  - @plurnk/plurnk-schemes@3.1.0
  - @plurnk/plurnk-mimetypes@3.0.1
  - @plurnk/plurnk-meta@2.1.0
  - @plurnk/plurnk-execs@3.1.0
  - @plurnk/plurnk-execs-common@2.0.2

## 3.0.0

### Major Changes

- 85bcf56: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 69f3ffe: A family's `discover` advertises only the inputs it serves. An adapter declares
  `discovery.inputs` (and `emptyListsAll`), implements `discover` exactly when it
  does, and the coordinator builds the discover input schema from that
  declaration: any other input is refused 400 `arguments-invalid` by the shared
  schema check, naming the field. A family without discovery has no `discover`
  verb; MCP serves one only while `PLURNK_MCP_REGISTRY_URL` names a registry, and
  contains an invalid registry setting. Members discovery takes `query` alone and
  refuses a query naming no path or pattern as `query-invalid`; an empty env
  discovery is the whole catalog and needs no body. The refusals
  `query-unsupported`, `configuration-unsupported`, `source-unsupported`,
  `registry-not-configured`, `query-required` and schedule's `source-required`
  are gone.
- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them, and a setting nothing reads is inert. The package exports
  `./launch` and `./evidence`; the root export is removed. `plurnk-service paths
  migrate` and the startup check for a `~/.plurnk` home are removed; operator files
  live in the XDG locations. Workspace skills state is no longer moved from its
  pre-2.0 directory. Migration 20 carries existing databases forward in place: a
  WAIT receipt's unbounded `-1` marker is dropped, and the log projection loses its
  two unread admission columns.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.

### Minor Changes

- f1bbc46: Offer the native `question` tool only to a worker whose owner would receive
  it: an interactive owner that declares the tool. Other workers do not see it
  at turn 0 or in the reserved reference set, and a call is refused with a
  recovery saying nobody is present to answer. The tool is on by default;
  `PLURNK_EXECS_QUESTION=0` remains the operator's switch to remove it.
  Teaching now says SEND carries progress updates and WAIT yields to children
  and streams, without changing either operation's behavior.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.

### Patch Changes

- 85bcf56: Replace body-truncated assistant-history operations with one complete
  Previous Emission section at the end of the user packet. The most recent
  emission retains its real bodies, so examples no longer teach destructive empty
  EDIT operations. Older operation results remain in the ordinary curated log.
- e7e3b18: A loop no longer ends on a request the provider's exact count refuses while it
  could still fit: admission asks the provider to assess the exact request, then
  sheds the previous program and the newest rows by the refusal's excess. The
  context budget follows the current calibration both ways instead of holding a
  loop's high-water, so the over-budget row arrives at the provider's capacity.
- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- 0addc81: The worker summary gains a `Room:` line: the budget the model was shown, in
  provider tokens, against the capacity, and the wall's estimate against the
  provider's count, marking requests the estimate admitted over the wall.
  `EvidencePacket` carries `weight` and `budget`; an evidence implementation must
  provide them.
- 4153042: An owner declares whether a person attends it (`interactive`), beside the
  client tools it implements. A provider-recovery park and a clarification need
  an interactive owner; approval does not, so an automatically approving client
  that nobody attends concludes on a provider failure instead of parking. AG-UI
  reads `forwardedProps.plurnk.interactive`; unstated, nobody attends.
- 69f3ffe: A tool or family input schema that requires one of several inputs previews its
  first alternative's required fields, so the taught example satisfies the schema.
- 85bcf56: Exclude runtime bookkeeping from model-call ceiling inheritance. Model trees
  beneath `_plurnk` retain their own shared cap across children, grandchildren, and
  BARE; the default remains unlimited.
- 85bcf56: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.
- Updated dependencies [4bb8114]
- Updated dependencies [5f10995]
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [c053b24]
- Updated dependencies [0addc81]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [503ea87]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-a2a@3.0.0
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-agui@3.0.0
  - @plurnk/plurnk-modules@3.0.0
  - @plurnk/plurnk-meta@2.0.2
  - @plurnk/plurnk-schemes@3.0.0
  - @plurnk/plurnk-execs@3.0.0
  - @plurnk/plurnk-mcp@3.0.0
  - @plurnk/plurnk-skills@3.0.0
  - @plurnk/plurnk-schedule@3.0.0
  - @plurnk/plurnk-mimetypes@3.0.0
  - @plurnk/plurnk-parser@3.0.1
  - @plurnk/plurnk-digest@3.0.0
  - @plurnk/plurnk-models@3.0.0
  - @plurnk/plurnk-providers@3.0.0
  - @plurnk/plurnk-hooks@2.0.1
  - @plurnk/plurnk-schemes-http@2.0.1
  - @plurnk/plurnk-execs-sqlite@2.0.1
  - @plurnk/plurnk-execs-common@2.0.1
  - @plurnk/plurnk-agent-skills@2.0.1
  - @plurnk/plurnk-mimetypes-application-ipynb@2.0.1
  - @plurnk/plurnk-execs-jq@2.0.1
  - @plurnk/plurnk-mimetypes-application-json@2.0.1
  - @plurnk/plurnk-mimetypes-application-jsonl@2.0.1
  - @plurnk/plurnk-mimetypes-application-pdf@2.0.1
  - @plurnk/plurnk-mimetypes-application-xml@2.0.1
  - @plurnk/plurnk-mimetypes-audio@2.0.1
  - @plurnk/plurnk-mimetypes-image@2.0.1
  - @plurnk/plurnk-mimetypes-text-csv@2.0.1
  - @plurnk/plurnk-mimetypes-text-diff@2.0.1
  - @plurnk/plurnk-mimetypes-text-dotenv@2.0.1
  - @plurnk/plurnk-mimetypes-text-html@2.0.1
  - @plurnk/plurnk-mimetypes-text-ini@2.0.1
  - @plurnk/plurnk-mimetypes-text-markdown@2.0.1
  - @plurnk/plurnk-mimetypes-text-plain@2.0.1

## 2.0.0

### Major Changes

- Tavily is a separately installed opt-in plugin. Users selecting `tavily-extract`
  must install `@plurnk/plurnk-tavily-plugin` beside the service; it is no longer bundled.
- Move Skills ownership to `@plurnk/plurnk-skills` and reporting to
  `@plurnk/plurnk-digest`. The service no longer exports `Skill`, `/digest`, or
  `/share`. Reporting consumers import the named `Digest` and `Share` exports from
  `@plurnk/plurnk-digest` and supply `openEvidence: EvidenceReader.open`, with
  `EvidenceReader` imported from `@plurnk/plurnk-service/evidence`.

  Rename `PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS` to
  `PLURNK_SKILLS_FETCH_TIMEOUT_MS`, and `PLURNK_SERVICE_REQUIEM_MAX_TOKENS` and
  `PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS` to `PLURNK_DIGEST_REQUIEM_MAX_TOKENS`
  and `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`. Retired names are rejected rather
  than maintained as aliases. The CLI's `share` command remains unchanged, and
  existing databases are upgraded in place.
- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-skills@2.0.0
  - @plurnk/plurnk-digest@2.0.0
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-modules@2.0.0
  - @plurnk/plurnk-parser@2.0.0
  - @plurnk/plurnk-agent-skills@2.0.0
  - @plurnk/plurnk-agent-plugins@2.0.0
  - @plurnk/plurnk-models@2.0.0
  - @plurnk/plurnk-mimetypes-application-json@2.0.0
  - @plurnk/plurnk-mimetypes-application-xml@2.0.0
  - @plurnk/plurnk-mimetypes-application-jsonl@2.0.0
  - @plurnk/plurnk-mimetypes-application-ipynb@2.0.0
  - @plurnk/plurnk-mimetypes-application-pdf@2.0.0
  - @plurnk/plurnk-mimetypes-image@2.0.0
  - @plurnk/plurnk-mimetypes-audio@2.0.0
  - @plurnk/plurnk-mimetypes-text-csv@2.0.0
  - @plurnk/plurnk-mimetypes-text-html@2.0.0
  - @plurnk/plurnk-mimetypes-text-markdown@2.0.0
  - @plurnk/plurnk-mimetypes-text-plain@2.0.0
  - @plurnk/plurnk-mimetypes-text-diff@2.0.0
  - @plurnk/plurnk-mimetypes-text-ini@2.0.0
  - @plurnk/plurnk-mimetypes-text-dotenv@2.0.0
  - @plurnk/plurnk-mimetypes@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
  - @plurnk/plurnk-schemes-http@2.0.0
  - @plurnk/plurnk-execs@2.0.0
  - @plurnk/plurnk-execs-common@2.0.0
  - @plurnk/plurnk-mcp@2.0.0
  - @plurnk/plurnk-hooks@2.0.0
  - @plurnk/plurnk-execs-jq@2.0.0
  - @plurnk/plurnk-execs-sqlite@2.0.0
  - @plurnk/plurnk-providers@2.0.0
  - @plurnk/plurnk-a2a@2.0.0
  - @plurnk/plurnk-schedule@2.0.0
  - @plurnk/plurnk-agui@2.0.0
