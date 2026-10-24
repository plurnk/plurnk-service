# @plurnk/plurnk-agui

## 5.0.1

### Patch Changes

- Unify the AG-UI principal under `PLURNK_AUTH=0` onto `operator` so toggling authentication never splits worker ownership, project proposed tool calls (`gateCall`) live to all worker Runs observing the worker, and refine `plurnk.md` `COPY`/`MOVE` operand teaching and anchor examples (#1229, #0).

## 5.0.0

### Major Changes

- ff99f76: A row's `metadata.plurnk.attrs` travels without the bodies it holds: a file
  write's `original`, `patched`, `patchedBytes`, `patch` and `editReceipt`, and
  a statement's `body` and `inputBody`, which the row's result and its call's
  arguments carry; a `plurnk.ambient` row and a proposal interrupt's projection
  likewise, whose review body is its `body` ({§agui-plurnk-metadata}). The AG-UI
  conformance kit's specimens follow.
- cc3e9cb: A row's facts travel once: `metadata.plurnk` rides its call, speech or
  arrival, and a result carries a row's facts only when another row delivered
  it; a call's own result repeats none ({§agui-plurnk-metadata}). The AG-UI
  conformance kit's specimens follow.
- ccf591f: A snapshot is a window: the bound worker's newest `PLURNK_AGUI_HISTORY_LOOPS`
  loops (2), cut between whole turns, within `PLURNK_AGUI_HISTORY_PAGE_CHARS`
  (2,000,000) of the serialized event, its `metadata.plurnk.history.older`
  linking the page before ({§agui-history-window}). `GET` at that link answers
  `{ final, messages, older }`, one loop per page under the same ceiling
  ({§agui-history-page}). A Run sends a fresh window at a turn boundary once
  its client holds more than the ceiling ({§agui-history-advance}). Every live delta
  stays within the ceiling, a call's arguments and reasoning as well as words; a
  part that alone would pass it carries the words its senders wrote by reference,
  an accepted message's at the address that minted it, and model output past it
  travels whole in a page of its own ({§agui-words-by-reference}).
- c3922c2: A loop stopped without failing (499) has the lifecycle `cancelled`, in the
  status gauge, the worker directory, `status.descendants` and the inbox; any
  other status of 400 or more stays `failed`. `LoopLifecycle` gains the word
  ({§loop-lifecycle-vocabulary}).
- 39f234e: A Run may negotiate its reasoning by link with
  `forwardedProps.plurnk.reasoning: "link"`: each reasoning message holds no
  text and names its turn's `reasoning://<worker>/L/T` address in its HTTP form,
  the live text arrives as `CUSTOM plurnk.reasoning`, and a snapshot holds each
  turn's link ({§agui-reasoning-link}). Every other Run receives reasoning as
  AG-UI defines it. No row repeats reasoning its message holds.
- de4fc63: `status.descendants` replaces `status.children`: the bound Worker's whole tree
  beneath it, each worker `{ id, name, parentWorkerId, kind, lifecycle, gates }`,
  `gates` the proposals and client interactions it waits on. A Run reads it and
  `status.spend` again after another worker's lifecycle beat, when a gate is
  presented, and, while a descendant waits on one, after another worker's row or
  a stream's conclusion ({§agui-status-descendants}). The AG-UI conformance
  kit's snapshot specimen carries the tree.

### Minor Changes

- cfa2be9: An address at the daemon has one HTTP form:
  `GET /agui/<workspace>/<worker>/entry?target=<address>` answers the channel
  the address selects, read from that worker's perspective through
  `ApplicationPort.readEntryChannel` ({§agui-entry-route},
  {§methods-entry-channel-read}). A result's body, a turn's reasoning and a
  message's words travel by reference at it. A log row names its worker,
  `worker_name` beside `worker_id` ({§methods-log-entry-wire}).
- adc7466: `worker.env.add` and `worker.env.replace` create the thread's worker when it
  is absent, as `worker.model.set` does ({§agui-action-binding}).
- 21ada9c: A result whose receipt holds a body carries the receipt as a text part and the
  body as a document part at the HTTP form of the row's log address.
  A `plurnk.ambient` row carries its body's URL beside a lean receipt, and no
  receipt carries the model's line anchors ({§agui-body-reference}).
- f490341: A disconnect ends delivery, never work: admitted loops, client operations and
  resumed decisions run on without their connection; `loop.cancel` is the one
  cancellation ({§agui-run-disconnect}).
- c8866ff: A Run that submits nothing may name the interrupts its client holds,
  `forwardedProps.plurnk.interrupts`: it does not present those gates again, waits
  on them, and finishes with `RUN_FINISHED` success when one settles, or at once
  when one is no longer pending, so every view of a worker converges on one
  decision ({§agui-held-interrupts}).
- 0cee49c: Workspaces and workers hide and show by a durable mark ({§place-hiding}):
  `setWorkspaceHidden`, `setWorkerHidden` ({§methods-workspace-hide},
  {§methods-worker-hide}). A worker's hide covers its subtree as one group;
  `409 live-work` while anything covered is live; a live loop shows its group
  and workspace. `listWorkspaces` and `listWorkers` take `hidden` and carry
  `hidden_at`; the overview omits hidden places; `workspace/hidden`,
  `worker/hidden`. AG-UI: `workspace.hidden.set`, `worker.hidden.set`;
  `workspace.list` and `workspace.workers` take `includeHidden`
  ({§agui-place-hiding}). Migration 33.
- dd52a9b: `loop/packet`, `loop/terminated` and the `loop_status` notice carry `loopSeq`,
  the loop's number among its worker's loops, beside `loopId`
  ({§notifications-loop-packet}, {§notifications-loop-terminated},
  {§loop-status-notice}). The AG-UI status gauge carries it as `status.loopSeq`,
  replaced in every delta that replaces `loopId` ({§agui-status-loop-number}); the
  conformance kit's gauge carries it.
- 4e4cb32: AG-UI: an accepted message is discoverable before its arrival (#1166).
  `status.inbox` lists the accepted messages the bound Worker has not yet
  observed; the snapshot carries the ones a client on the thread sent, with
  `metadata.plurnk.published` false, and their arrival folds onto them; a
  message Run admits its message before it presents anything, and no Run echoes
  its input into a snapshot. Contracts and the service gain `readInbox`.
- 4d934e4: `op.exec` takes an optional `env`, the command's own environment under
  {§env-option}; the env family refuses a name before the command runs.
- 7246520: A resume answers the presentation its client holds: a gate that became
  pending after it stays durable and the resuming Run presents it next
  ({§agui-proposal-resolve}). A client interaction's interrupt carries Core's
  projection as `metadata.plurnk.interaction`, naming the worker asking
  ({§agui-plurnk-metadata}).
- 06d4a8d: `reasoning/event` carries its turn's `loopSeq` and `turnSeq`
  ({§notifications-reasoning-event}), and every reasoning message names that
  turn as `metadata.plurnk.coordinate` (`L/T`) from its first event, live, as
  its row folds onto it and in a snapshot, a subagent's included
  ({§agui-plurnk-metadata}). The AG-UI conformance kit's specimens follow.
- de9ce8f: `status.streams` lists the streams the bound Worker holds open, each with its
  identity, lifetime, the row that opened it, and every channel's state, written
  or not, so a client attaching mid-execution finds a silent one; it is
  republished as `STATE_DELTA /plurnk/status/streams` when it changes
  ({§agui-status-streams}). `ApplicationPort.readStreams` reads it
  ({§methods-worker-streams}). `stream/event`'s `contentLength` counts Unicode
  code points.
- 1c125d0: `worker.loops` lists a worker's loops in sequence order: each loop's number,
  lifecycle, the sender of its opening message, that message's first line (at most
  `PLURNK_AGUI_EXCERPT_CHARS` characters) and whether it holds more
  ({§agui-worker-loops}). The history page takes `loop=<sequence>` in place of
  `before` and answers that loop whole ({§agui-loop-page}); a malformed loop is
  400 `history-loop-invalid`, an absent one 404 `history-loop-not-found`.
- 4a048a8: `readWorkerOverview` reads the places of the daemon or of one workspace with their
  lifecycle, the gates they wait on and their latest finished reply, most recently
  finished first and bounded ({§methods-worker-overview}, {§worker-finished-reply},
  {§application-worker-overview}); `excerptOf` is the one list excerpt rule
  ({§list-excerpt}). `workspace/renamed` announces a rename
  ({§notifications-workspace-renamed}). AG-UI: a Run carrying
  `forwardedProps.plurnk.overview` observes the overview as state, binding
  nothing: a snapshot on `/agui`, patches until the client leaves on
  `/agui/connect` ({§agui-overview-run}, {§agui-overview-state},
  {§agui-overview-updates}). `PLURNK_AGUI_OVERVIEW_WORKERS` bounds it and
  `PLURNK_AGUI_EXCERPT_CHARS` caps every list excerpt.
- 2693a59: A change to a worker's model, effort or spawn model is announced as
  `worker/policy` ({§notifications-worker-policy}), and every client attached to
  the worker is sent the new route as `STATE_DELTA /plurnk/status/model`,
  whichever view made the change ({§agui-status-model}). A delta an event causes
  reaches the Run before any later event, its terminal included
  ({§agui-state-patches}).

### Patch Changes

- b9f50b0: `@ag-ui/core` moves to `^1.0.3`. An official 1.0.3 client folds a result the
  daemon delivers again ({§agui-sync}) onto the message its snapshot holds; 1.0.2
  held it twice.
- 6adcfc6: A gate that becomes pending while a resume Run binds, validates or resolves its
  resume is presented once the resume is applied or refused, never before: the
  answer is no longer dropped when another gate arrives first, and a refusal
  reaches its Run ({§agui-resume-before-gate}).
- ff0d82e: Shutdown joins what the module admitted: `close` returns once every admitted
  request and the work its Runs started have settled, so none reaches core after the
  module closes, and a request still preparing at shutdown answers `service-stopping`
  instead of failing on a closed database ({§agui-shutdown}).
- f3cd7de: `loop/packet` carries the loop's client gauge after each model turn, and
  `ApplicationPort.workerGauge` returns the gauge the Worker's latest packet
  reported ({§notifications-loop-packet}, {§methods-worker-gauge}). AG-UI moves
  the budget with every packet and its snapshots carry the latest, so a live and
  a reattached observer agree ({§agui-state-patches}).
- 2e5b2c1: `ApplicationPort.createWorkspace` and `AguiPlusState` drop `constraints`,
  which the daemon stopped reading when workspace membership became the Members
  functionality. A Run that creates its workspace refuses a `projectRoot` that is
  not a string or null (`project-root-invalid`) and `settings` that are neither
  a string nor an object (`settings-invalid`). A forwarded `maxTurns`, `openPaths`
  or `childSelector` of the wrong type is coded `max-turns-invalid`,
  `open-paths-invalid` or `child-selector-invalid`, a 400 where it was a 500.
- Updated dependencies [cfa2be9]
- Updated dependencies [ff99f76]
- Updated dependencies [a8200fb]
- Updated dependencies [65da58e]
- Updated dependencies [d2dcf47]
- Updated dependencies [d679cc5]
- Updated dependencies [25aadcf]
- Updated dependencies [cc3e9cb]
- Updated dependencies [f7e3b0e]
- Updated dependencies [558c0db]
- Updated dependencies [0cee49c]
- Updated dependencies [878d630]
- Updated dependencies [c3922c2]
- Updated dependencies [dd52a9b]
- Updated dependencies [50fbe81]
- Updated dependencies [4e4cb32]
- Updated dependencies [06d4a8d]
- Updated dependencies [39f234e]
- Updated dependencies [de4fc63]
- Updated dependencies [de9ce8f]
- Updated dependencies [f3cd7de]
- Updated dependencies [4a048a8]
- Updated dependencies [2e5b2c1]
  - @plurnk/plurnk-contracts@6.0.0

## 4.0.1

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0
  - @plurnk/plurnk-parser@4.2.0

## 4.0.0

### Breaking changes

- Use the daemon's OAuth credential authority: authenticated by default through
  `PLURNK_AUTH`, client secrets through `PLURNK_SECRET`, browser sign-in through
  `PLURNK_PASS`, and expiring, rotating, revocable access/refresh credentials.
  Static `PLURNK_AGUI_TOKEN` and `PLURNK_AGUI_SECRET` are removed. A secret is
  exchanged at the token endpoint, never presented as an access bearer.
- A qualified thread is `<workspace ID>#<worker name>`. An ordinary opaque
  thread ID binds durably to a folderless workspace and worker on its first
  creating Run; passive reads do not allocate it. Explicit workspace names remain
  supported, but qualified IDs survive workspace renames without rebinding.
  The daemon no longer chooses a default worker.
- A Run submits only a new trailing user message, an action, or an interrupt
  resume. With none, it synchronizes. Remove `forwardedProps.plurnk.mode` and
  `forwardedProps.plurnk.worker`. Message IDs are idempotency keys; accepted
  text cannot be replaced under the same ID.
- Standard messages, reasoning, tool calls/results and subagent events now carry
  the conversation live and on replay. Calls preserve every authored operand;
  command results contain observed output, status and exit code. Parse refusals
  preserve the attempted operation. Delegated calls conclude with the actual
  reply or child result.
- Row facts, failures, terminals and proposal projections use standard
  `metadata.plurnk`. Replace `plurnk.row`, `plurnk.send`,
  `plurnk.terminated` and `plurnk.action.result` consumers with their standard
  messages, metadata and Run results. Non-conversation facts remain documented
  extensions. Stream progress uses `plurnk.stream`, not a duplicate activity.
- Completion uses standard success/cancelled outcomes, result and reported usage;
  failures remain RUN_ERROR. Proposal interrupts name the gated call and resume
  by interrupt ID; `request_approval` and `prop:` pseudo-calls are removed.
- Daemon-wide actions use scope `daemon`, not `world`. LOOK and `op.look`
  are removed. Direct client operations use the workspace's runtime actor and
  the person's identity, not a client worker.

### Connection and discovery

- The official HttpAgent is exercised without Plurnk forwarded properties,
  across first contact, replay, reconnect, rename and daemon restart.
  Concurrent first contact preserves one durable thread binding.
- `workspace.attach` is read-only, accepting exactly one ID, literal name or
  project folder. Workspace envelopes contain no worker selection.
- Module clients register with the shared authority and can supply local
  authorization-page styles. Native sign-in/session/revocation documents contain
  no script. `authorizationDocumentSpecimens()` supports consumer CSS tooling.
- Unless configured otherwise, issuer URLs follow the request's origin.
  Front-proxy hardening replaces address-based login throttling inside the
  daemon; the old login-attempt/window knobs are removed.
- Owner attachment starts workspace activation; passive observation does not.
  Preparation state is workspace-scoped. Worker state carries consistent loop
  timestamps and lifetime worker/descendant spend.
- The browser-safe `/client` entry exports standard state and action-result
  types without Node globals. Shutdown stops admission and releases open Runs.
- Direct operations use ordered runtime resolution, without the removed
  `ApplicationPort.executorJsonBodyTags` parser plumbing.

## 3.1.0

### Minor Changes

- a8df72c: Rollback reverses a worker's settled file mutations after a log coordinate,
  latest first, as the acting client's own operations:
  `rollback({ workspaceId, workerId, clientWorkerId, to })` on the application
  port, `workspace.rollback { to, workerId? }` for a client, and `RollbackReport`
  naming what was restored, the rows skipped (no patch, or reversed already) and
  where drift or a refusal stopped it (#880).

### Patch Changes

- 1799168: Close remaining AG-UI Runs during daemon shutdown after terminal-event delivery,
  including idle client connections. Refuse stream registration after module closure
  instead of holding HTTP teardown until its emergency deadline (#1111).
- Updated dependencies [157cf8f]
- Updated dependencies [a8df72c]
  - @plurnk/plurnk-contracts@3.3.0

## 3.0.0

### Major Changes

- 85bcf56: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.

### Patch Changes

- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them. A setting the package does not read is inert, and an
  undeclared value fails through the package's ordinary check.
- 4153042: An owner declares whether a person attends it (`interactive`), beside the
  client tools it implements. A provider-recovery park and a clarification need
  an interactive owner; approval does not, so an automatically approving client
  that nobody attends concludes on a provider failure instead of parking. AG-UI
  reads `forwardedProps.plurnk.interactive`; unstated, nobody attends.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [c053b24]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-modules@3.0.0
  - @plurnk/plurnk-schemes@3.0.0
  - @plurnk/plurnk-parser@3.0.1

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-modules@2.0.0
  - @plurnk/plurnk-parser@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
