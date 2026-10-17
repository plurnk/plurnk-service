# @plurnk/plurnk-agui

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
