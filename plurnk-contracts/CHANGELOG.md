# @plurnk/plurnk-contracts

## 6.0.1

### Patch Changes

- Unify the AG-UI principal under `PLURNK_AUTH=0` onto `operator` so toggling authentication never splits worker ownership, project proposed tool calls (`gateCall`) live to all worker Runs observing the worker, and refine `plurnk.md` `COPY`/`MOVE` operand teaching and anchor examples (#1229, #0).

## 6.0.0

### Major Changes

- d679cc5: A client entry read acquires an address as exact READ does, from its worker's
  perspective: `log:///`, `reasoning://`, `ops://` and `note://` read as the
  representations core computes, with `entryId` null, and a message core
  retains reads at the address that minted it. Only core's own acquisition runs:
  another scheme's entry reads as stored, never prepared, so a client read never
  fetches ({§client-entry-address}). A channel name may be empty, a log row's
  unnamed default ({§entry-read-result}).
- c3922c2: A loop stopped without failing (499) has the lifecycle `cancelled`, in the
  status gauge, the worker directory, `status.descendants` and the inbox; any
  other status of 400 or more stays `failed`. `LoopLifecycle` gains the word
  ({§loop-lifecycle-vocabulary}).

### Minor Changes

- cfa2be9: An address at the daemon has one HTTP form:
  `GET /agui/<workspace>/<worker>/entry?target=<address>` answers the channel
  the address selects, read from that worker's perspective through
  `ApplicationPort.readEntryChannel` ({§acp-entry-route},
  {§methods-entry-channel-read}). A result's body, a turn's reasoning and a
  message's words travel by reference at it. A log row names its worker,
  `worker_name` beside `worker_id` ({§methods-log-entry-wire}).
- 558c0db: `FunctionalityAdapter` gains `Definition` and `Snapshot` type parameters, and
  `FunctionalityPreparation`, `FunctionalityPrepared`, `FunctionalityAdmission`,
  `FunctionalityServiceDefinition`, `FunctionalityPreparedDefinition` and
  `FunctionalityDefinitionSource` carry them; each defaults to the previous type.
  `registerFunctionalityAdapter` infers both from the adapter it registers.
- 0cee49c: Workspaces and workers hide and show by a durable mark ({§machine-processes}):
  `setWorkspaceHidden`, `setWorkerHidden` ({§methods-workspace-hide},
  {§methods-session-hide}). A worker's hide covers its subtree as one group;
  `409 live-work` while anything covered is live; a live loop shows its group
  and workspace. `listWorkspaces` and `listWorkers` take `hidden` and carry
  `hidden_at`; the overview omits hidden places; `workspace/hidden`,
  `worker/hidden`. AG-UI: `workspace.hidden.set`, `worker.hidden.set`;
  `workspace.list` and `workspace.workers` take `includeHidden`
  ({§acp-place-hiding}). Migration 33.
- 878d630: The package root exports the value guards `isRecord`, `isSafeInteger` and
  `errnoCode`
  ({§wire-entrypoint}); `Validator`'s asserts take `unknown` and return the wire
  type their schema proves; `Validator.assertPlurnkStatement` joins them.
  `isPlurnkOp` tests membership in the operation alphabet beside `PLURNK_OPS`.
- dd52a9b: `loop/packet`, `loop/terminated` and the `loop_status` notice carry `loopSeq`,
  the loop's number among its worker's loops, beside `loopId`
  ({§notifications-loop-packet}, {§notifications-loop-terminated},
  {§loop-status-notice}). The AG-UI status gauge carries it as `status.loopSeq`,
  replaced in every delta that replaces `loopId` ({§acp-status-loop-number}); the
  conformance kit's gauge carries it.
- 50fbe81: An interactive `McpOAuth` definition may name the `issuer` its sign-in binds
  to, where discovery starts, and `authorizationParams` added to the
  authorization request, such as `access_type=offline` ({§mcp-oauth},
  {§oauth-issuer}). `oauth.begin` for an alias awaiting a sign-in after a refused
  request starts the authorization on a connection its server never challenges
  ({§oauth-begin-unchallenged}).
- 4e4cb32: AG-UI: an accepted message is discoverable before its arrival (#1166).
  `status.inbox` lists the accepted messages the bound Worker has not yet
  observed; the snapshot carries the ones a client on the thread sent, with
  `metadata.plurnk.published` false, and their arrival folds onto them; a
  message Run admits its message before it presents anything, and no Run echoes
  its input into a snapshot. Contracts and the service gain `readInbox`.
- 39f234e: A Run may negotiate its reasoning by link with
  `forwardedProps.plurnk.reasoning: "link"`: each reasoning message holds no
  text and names its turn's `reasoning://<worker>/L/T` address in its HTTP form,
  the live text arrives as `CUSTOM plurnk.reasoning`, and a snapshot holds each
  turn's link ({§acp-reasoning-link}). Every other Run receives reasoning as
  AG-UI defines it. No row repeats reasoning its message holds.
- de9ce8f: `status.streams` lists the streams the bound Worker holds open, each with its
  identity, lifetime, the row that opened it, and every channel's state, written
  or not, so a client attaching mid-execution finds a silent one; it is
  republished as `STATE_DELTA /plurnk/status/streams` when it changes
  ({§acp-status-streams}). `ApplicationPort.readStreams` reads it
  ({§methods-session-streams}). `stream/event`'s `contentLength` counts Unicode
  code points.
- f3cd7de: `loop/packet` carries the loop's client gauge after each model turn, and
  `ApplicationPort.workerGauge` returns the gauge the Worker's latest packet
  reported ({§notifications-loop-packet}, {§methods-session-gauge}). AG-UI moves
  the budget with every packet and its snapshots carry the latest, so a live and
  a reattached observer agree ({§acp-state-patches}).
- 4a048a8: `readWorkerOverview` reads the places of the daemon or of one workspace with their
  lifecycle, the gates they wait on and their latest finished reply, most recently
  finished first and bounded ({§methods-session-overview}, {§session-finished-reply},
  {§application-session-overview}); `excerptOf` is the one list excerpt rule
  ({§list-excerpt}). `workspace/renamed` announces a rename
  ({§notifications-workspace-renamed}). AG-UI: a Run carrying
  `forwardedProps.plurnk.overview` observes the overview as state, binding
  nothing: a snapshot on `/agui`, patches until the client leaves on
  `/agui/connect` ({§acp-overview-run}, {§acp-overview-state},
  {§acp-overview-updates}). `PLURNK_AGUI_OVERVIEW_WORKERS` bounds it and
  `PLURNK_AGUI_EXCERPT_CHARS` caps every list excerpt.

### Patch Changes

- ff99f76: A row's `metadata.plurnk.attrs` travels without the bodies it holds: a file
  write's `original`, `patched`, `patchedBytes`, `patch` and `editReceipt`, and
  a statement's `body` and `inputBody`, which the row's result and its call's
  arguments carry; a `plurnk.ambient` row and a proposal interrupt's projection
  likewise, whose review body is its `body` ({§acp-plurnk-metadata}). The AG-UI
  conformance kit's specimens follow.
- a8200fb: The card's insert-after example adds `<-1>` for inserting after the last line,
  and a TIP under the pattern table shows that patterns select source text as
  written: an attribute with its name, a JSON string with its quotes.
- 65da58e: The card's loop-continuation line is a TIP; a new TIP asks for the NOTE, FIND
  and READ operations first and deliberation on the next turn; and the anchor TIP
  calls `<@hash>` and `<@start,@end>` anchors batch-friendly.
- d2dcf47: The card's opening instruction ends at the fenced operation line.
- 25aadcf: The AG-UI conformance kit's gauge carries `status.inbox` and `status.streams`,
  as the daemon sends them (#1189).
- cc3e9cb: A row's facts travel once: `metadata.plurnk` rides its call, speech or
  arrival, and a result carries a row's facts only when another row delivered
  it; a call's own result repeats none ({§acp-plurnk-metadata}). The AG-UI
  conformance kit's specimens follow.
- f7e3b0e: The card's FIND example says its range pages results, not lines. The `sh`
  page says a receipt names the working directory, relative to the project root,
  only when the command ran elsewhere.
- 06d4a8d: `reasoning/event` carries its turn's `loopSeq` and `turnSeq`
  ({§notifications-reasoning-event}), and every reasoning message names that
  turn as `metadata.plurnk.coordinate` (`L/T`) from its first event, live, as
  its row folds onto it and in a snapshot, a subagent's included
  ({§acp-plurnk-metadata}). The AG-UI conformance kit's specimens follow.
- de4fc63: `status.descendants` replaces `status.children`: the bound Worker's whole tree
  beneath it, each worker `{ id, name, parentWorkerId, kind, lifecycle, gates }`,
  `gates` the proposals and client interactions it waits on. A Run reads it and
  `status.spend` again after another worker's lifecycle beat, when a gate is
  presented, and, while a descendant waits on one, after another worker's row or
  a stream's conclusion ({§acp-status-descendants}). The AG-UI conformance
  kit's snapshot specimen carries the tree.
- 2e5b2c1: `ApplicationPort.createWorkspace` and `AguiPlusState` drop `constraints`,
  which the daemon stopped reading when workspace membership became the Members
  functionality. A Run that creates its workspace refuses a `projectRoot` that is
  not a string or null (`project-root-invalid`) and `settings` that are neither
  a string nor an object (`settings-invalid`). A forwarded `maxTurns`, `openPaths`
  or `childSelector` of the wrong type is coded `max-turns-invalid`,
  `open-paths-invalid` or `child-selector-invalid`, a 400 where it was a 500.

## 5.0.0

### Major Changes

- f320b9b: `FunctionalityPrepared` gains a required synchronous `publish()` returning an
  undo. Candidate state goes live there, inside the coordinator's registry
  commit, with no I/O; `commit()` is post-publication settlement; `abort()`
  discards an unpublished candidate. The coordinator composes the adapter's undo
  with its own view rollback. MCP consumes a pending OAuth candidate at publish,
  so a callback replayed after publication is `404 oauth-not-pending` with no
  window (#1155).

### Minor Changes

- dc0808c: Fence pairing: a heading the author enclosed in a wider or labeled fence is the
  example it was written as, at no cost to a complete reading; only a declared
  code block discarded as text still counts with a hidden operation. A message
  whose own fence is narrower than the fences wrapping its examples now holds them
  instead of running them ({§pairing-objective}, {§balanced-fences}; #1147).

### Patch Changes

- a619ed6: The card states its NOTE rule as one command, `YOU MUST persist all new facts,
  ideas, and plans in NOTEs on every turn.`, and the reminder returns: a model
  turn that continues or parks without a NOTE in its program or from its
  reasoning is told so in the next packet by the `engine:turn` notice
  `continued_without_note` (`level: warn`, that command as its directive). A
  notice, never a failure ({§continued-without-note}).
- acffc4f: The card teaches NOTE as working memory — save all new facts, ideas and plans
  for later turns — with `fact`, `idea` and `plan` examples in place of `plan`,
  `finding`, `decision` and `next`. The initialization turn's two NOTEs follow:
  both carry the `plan` aside, and the opening plan's third step saves facts,
  ideas and plans (#1153).

## 4.1.0

### Minor Changes

- 84c0d49: Replay each turn's complete admitted content operations together, in program
  order, as one assistant message immediately before that turn's receipts,
  retaining result bodies and resolved targets without duplicating authored
  requests. Curation removes replay with its owning receipt; immutable source and
  historical packets remain intact.
  
  Preserve READ/FIND body text as an ordinary NOTE before retrieval. Patterns belong
  on the header; below-header pattern and aside recovery are removed. Replace the
  NOTE legend with ordinary addressable NOTE receipts.

### Patch Changes

- 1c19a58: Teach the loop as Recall, Record, React: review Open Work and Open Messages
  against prior NOTEs and log items, save new plans, findings, and decisions as
  NOTEs, and emit them with the operations they lead to in one batch. The card
  also teaches operation batches, fence nesting, and scopes before its examples,
  and gives membership its own section. The daemon no longer reminds the model to
  NOTE each turn; NOTE storage, curation, and loop completion are unchanged.

## 4.0.0

### Breaking changes

- The root entry is runtime-neutral. Import `ApplicationPort`, `HttpHost`
  and `HttpRouteHandler` from `@plurnk/plurnk-contracts/port`.
  Request-origin and credential APIs take request headers through
  `RequestHeaders`; provider aliases and loop admissions have named types.
- Application action/module scope `world` becomes `daemon`.
- Worker lifecycle APIs use `createWorker`, `kind: "root"` and
  `worker-not-found`. There is no workspace default worker or
  `ensureModelWorker`. Workspace envelopes contain only workspace identity.
- Direct client operations and rollback take an actor rather than a client
  worker. Their administrative loops belong to the workspace runtime actor;
  `cancelLoop` cancels the specific operation and its executions.
- LOOK, `ClientStatement`, `ClientOp`, their validation surface and
  `ApplicationPort.look` are removed. Use the ordinary statement/read contracts.
- Remove `ApplicationPort.executorJsonBodyTags`: executor heading JSON is input,
  and metadata uses its bracketed slot, independently of runtime availability.
- `workerAccounting` replaces `descendantAccounting` and reports the worker
  and descendants over their lifetime.
- AG-UI conformance fixtures use standard message parts and
  `metadata.plurnk`, native outcomes/results/usage, subagent relationships and
  operation-linked interrupts instead of duplicate custom conversation events.

### Additions

- Shared authentication posture, client-secret and password configuration;
  daemon-issued credentials, module-client registration, sign-in inventory,
  revocation and request-origin contracts.
- Durable opaque worker references; workspace attachment by ID, literal name
  or folder-derived default; daemon-supplied project labels.
- Message-admission idempotency; invocation/answering identities on log
  projections; loop timing and opener identity; proposal worker/coordinate and
  optional expiry.
- Functionality preparation cancellation and alias progress, plus explicit
  workspace activation.
- NOTE teaching records plans, findings, decisions and next actions. Initialization
  examples follow the same form.

## 3.3.0

### Minor Changes

- 157cf8f: A members definition is its glob. `members (add)` takes `{"files": ["<glob>",
  "!<glob>"]}` and admits each glob as one definition, all or none, with a receipt
  listing them; `enable`, `disable` and `remove` take `{"file": "<glob>"}`; the
  family serves no `replace`. The operator's `PLURNK_MEMBERS_<alias>=<glob>` key
  is the definition's provenance, shown by `list`. Migration 27 re-keys workspace
  definitions by their glob and drops alias-keyed overrides of service
  definitions. The coordinator gains one seam, `addressing`: a family may name
  definitions by their content, `admit` may return one admission per definition,
  `FunctionalityPreparation.admissions` carries them, and
  `FunctionalityMutationResult` lists `definitions` for such an add. Every file
  miss recovery names the `members (add)` body the family accepts.
- a8df72c: Rollback reverses a worker's settled file mutations after a log coordinate,
  latest first, as the acting client's own operations:
  `rollback({ workspaceId, workerId, clientWorkerId, to })` on the application
  port, `workspace.rollback { to, workerId? }` for a client, and `RollbackReport`
  naming what was restored, the rows skipped (no patch, or reversed already) and
  where drift or a refusal stopped it (#880).

## 3.2.0

### Minor Changes

- 0b7f8b1: Add shared named definition replacement, retaining enabledness and preserving
  the previous publication on refusal. Use it for repeated environment EDITs
  and explicit child environment overrides, and reject fresh skill preparation
  failures when their definitions change. Carry attempt-local admission data
  through preparation without changing live state; schedule replacements and
  retries affect timers and held delivery failures only after publication.

### Patch Changes

- The card is titled "Plurnk Operation Protocol"; its per-turn rule asks for at least one
  NOTE along with other operations; SEND teaches the pathless reply, which addresses the
  oldest Open Message, and the path for completing (`[200]`) or cancelling (`[499]`) a
  specific one.
- 960777f: Clarify that NOTE is a detailed persistent annotation register.
- f383d7d: Clarify the existing Functionality mutation statuses: local creation, settlement,
  and authorization-required are distinct from management-stream completion.
- 42058d0: Teach separate status, finding, decision, and plan NOTEs and explicitly addressed
  message completion. Align continuing-turn notices with the revised NOTE instruction.
- c8b3bb9: Clarify that WAIT yields to child workers and streams, not the user.

## 3.1.0

### Minor Changes

- 0060c82: Run each hosted A2A Task in an ordinary child worker, with related conversation
  available as a retained Context resource. Tasks can progress and be cancelled
  independently without an extra Context worker or a second execution manager.
  Each streaming request observes its own initial snapshot and the durable result.
  
  Support an exact unfinished Loop recipient on the application message boundary;
  late continuations cannot reopen completed Tasks. Make simultaneous first model
  selections reuse the same immutable route instead of failing a uniqueness check.
- 1d585b4: Render each notice in the model packet as one alert callout in the card's own
  form: the level picks the callout, an optional `directive` (`YOU MUST`,
  `YOU SHOULD`, ...) leads, then the factual message and the kind. Notices about
  the model's own output carry a directive; environment notices carry none.

### Patch Changes

- 6769a6a: Card examples: one phrase for fenced operations in the first mandate, a NOTE
  example holding a finding, what it ruled out, what it cannot verify and assumes,
  a decision and the next step, a pattern READ over a glob beside the FIND over
  the same files, the four-integer scope shown on characters within one line with
  its EDIT example, an insert-after example beside insert-before, WORK with a
  delegation example, a two-operand COPY example, curation cut to the chunked READ
  and the KILL whose body survives as a NOTE, and an environment example for `sh`.
- eb33a1f: Teach the card as the Plurnk Annotated Operation Protocol: NOTE as the
  Persistent Internal Annotation Register, a NOTE for every fact, finding,
  conclusion, decision and plan, and the per-turn rule, at least one NOTE with a
  complete status summary and at least one other operation per turn, which the
  daemon's notices quote. All operations except NOTEs become log items; a reply
  code (`[200]` or `[499]`) belongs on the final deliverable SEND alone.
  Delegation and environment detail stay with their references.

## 3.0.1

### Major Changes

- 85bcf56: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.

### Minor Changes

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

### Patch Changes

- 8d9fb11: The AG-UI conformance kit's status snapshot carries every field the daemon
  sends: `waitUntil`, `children` and `descendants`. `OperationResult` no longer
  forbids a top-level `error` member by name; producer-owned members remain open,
  and a failure carries one Problem.
- 85bcf56: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 85bcf56: Replace body-truncated assistant-history operations with one complete
  Previous Emission section at the end of the user packet. The most recent
  emission retains its real bodies, so examples no longer teach destructive empty
  EDIT operations. Older operation results remain in the ordinary curated log.
- 4153042: An owner declares whether a person attends it (`interactive`), beside the
  client tools it implements. A provider-recovery park and a clarification need
  an interactive owner; approval does not, so an automatically approving client
  that nobody attends concludes on a provider failure instead of parking. AG-UI
  reads `forwardedProps.plurnk.interactive`; unstated, nobody attends.
- 6c33cec: Teaching: a turn emitting only a parameterless KILL with the final deliverable
  response ends the loop; a turn with several operations, active workers or open
  streams does not. The card also demonstrates replacing a line range,
  `EDIT (example.md) <@abcde,@fghij>`.
- 06960fc: The provider notice `grammar_unenforced` is now `output_unaccounted`, and its
  message states the two counts: the output tokens billed and the tokens visible
  across content and reasoning.
- f1bbc46: Offer the native `question` tool only to a worker whose owner would receive
  it: an interactive owner that declares the tool. Other workers do not see it
  at turn 0 or in the reserved reference set, and a call is refused with a
  recovery saying nobody is present to answer. The tool is on by default;
  `PLURNK_EXECS_QUESTION=0` remains the operator's switch to remove it.
  Teaching now says SEND carries progress updates and WAIT yields to children
  and streams, without changing either operation's behavior.

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.
