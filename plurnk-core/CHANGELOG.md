# @plurnk/plurnk-service

## 4.3.3

### Patch Changes

- Replace per-`(principal, threadId)` worker ownership with a single workspace-scoped operator owner (`agui://operator`), derive owner interactivity from the live union of attached AG-UI client Runs in the workspace, deliver proposal and `question` interrupts across every attached client Run with idempotent resolution convergence, and refresh the Models.dev snapshot to `@opencode-ai/models@0.0.114` (#1231).
- Updated dependencies
  - @plurnk/plurnk-agui@5.0.2
  - @plurnk/plurnk-models@3.0.3
  - @plurnk/plurnk-providers@5.0.2

## 4.3.2

### Patch Changes

- 4ec7cd3: Project the daemon's resolved `HostPaths` (`HOME` and `XDG_*` roots) into
  `ExecEnv.scoped`, `ExecEnv.withoutOwnSecrets`, `EnvFunctionality`, and
  `ExecScratch` so subprocesses and module-launched processes inherit the
  daemon's isolated home and state root rather than ambient host paths (#1224).
- Unify the AG-UI principal under `PLURNK_AUTH=0` onto `operator` so toggling authentication never splits worker ownership, project proposed tool calls (`gateCall`) live to all worker Runs observing the worker, and refine `plurnk.md` `COPY`/`MOVE` operand teaching and anchor examples (#1229, #0).
- Updated dependencies
  - @plurnk/plurnk-contracts@6.0.1
  - @plurnk/plurnk-agui@5.0.1

## 4.3.1

### Patch Changes

- c30873c: Pull external runtime and protocol dependencies across the platform
  constellation to their latest stable releases, including
  `@modelcontextprotocol/client` and `@modelcontextprotocol/core` `2.4.0`,
  `json-p3` `^3.0.1`, `ai` `7.0.152` and its `@ai-sdk/*` providers,
  `eventsource-parser` `^4.1.2`, `linkedom` `^0.18.14`, `marked` `^18.1.1`,
  `music-metadata` `^12.2.3`, and `zod` `^4.6.7` (#1227).
- 2b882f9: Surface required multi-value `enum` unions, one-level structured object/array
  shapes, and bounded optional property signatures (`name?: type`) in tool
  invocation asides and blank-invocation recovery fences, include the tool's
  working invocation fence in `invalid-tool-arguments` and `tool-reported-error`
  recovery, hold model Functionality mutations at the workspace boundary across
  `authorization-required` sign-in, and conclude loops when a turn pairs a reply
  `SEND` with `WAIT` and no live work remains ({§executor-input-schema-preview},
  {§executor-blank-invocation}, {§problems-mcp}, {§functionality-model-projection},
  {§oauth-continuation}, {§loop-completion}) (#1228).
- b28031f: `@opencode-ai/models` moves to `^0.0.113` ({§model-catalog-build}).
  `effort-unsupported` and `effort-invalid` name the route's supported or valid
  efforts in `recovery`, and `provider-unavailable` includes the provider's
  instantiation failure ({§session-effort}, {§problems-functionality}).
- 2b882f9: Translate the calibrated curation budget additively by measured overhead
  without extrapolating unmeasured content, remove daemon-side row shedding at
  the context wall, resolve `PLURNK_PROVIDERS_OUTPUT_FLOOR` percentages against
  the effective output ceiling, and refuse model changes whose calibrated budget
  cannot hold the worker's current context with `413 context-exceeds-model-budget`
  ({§tokenomics-calibrated-readout}, {§context-wall}, {§provider-output-floor},
  {§session-model-selection}) (#1225).
- Updated dependencies [c30873c]
- Updated dependencies [2b882f9]
- Updated dependencies [b28031f]
- Updated dependencies [2b882f9]
  - @plurnk/plurnk-providers@5.0.1
  - @plurnk/plurnk-mcp@3.3.1
  - @plurnk/plurnk-parser@4.2.2
  - @plurnk/plurnk-mimetypes@3.0.6
  - @plurnk/plurnk-schemes-http@2.0.5
  - @plurnk/plurnk-mimetypes-text-html@2.0.4
  - @plurnk/plurnk-mimetypes-text-markdown@2.0.3
  - @plurnk/plurnk-mimetypes-audio@2.0.4
  - @plurnk/plurnk-execs@4.0.3
  - @plurnk/plurnk-models@3.0.2

## 4.3.0

### Minor Changes

- cfa2be9: An address at the daemon has one HTTP form:
  `GET /agui/<workspace>/<worker>/entry?target=<address>` answers the channel
  the address selects, read from that worker's perspective through
  `ApplicationPort.readEntryChannel` ({§acp-entry-route},
  {§methods-entry-channel-read}). A result's body, a turn's reasoning and a
  message's words travel by reference at it. A log row names its worker,
  `worker_name` beside `worker_id` ({§methods-log-entry-wire}).
- d679cc5: A client entry read acquires an address as exact READ does, from its worker's
  perspective: `log:///`, `reasoning://`, `ops://` and `note://` read as the
  representations core computes, with `entryId` null, and a message core
  retains reads at the address that minted it. Only core's own acquisition runs:
  another scheme's entry reads as stored, never prepared, so a client read never
  fetches ({§scheme-address}). A channel name may be empty, a log row's
  unnamed default ({§entry-read-result}).
- 0cee49c: Workspaces and workers hide and show by a durable mark ({§machine-processes}):
  `setWorkspaceHidden`, `setWorkerHidden` ({§methods-workspace-hide},
  {§methods-session-hide}). A worker's hide covers its subtree as one group;
  `409 live-work` while anything covered is live; a live loop shows its group
  and workspace. `listWorkspaces` and `listWorkers` take `hidden` and carry
  `hidden_at`; the overview omits hidden places; `workspace/hidden`,
  `worker/hidden`. AG-UI: `workspace.hidden.set`, `worker.hidden.set`;
  `workspace.list` and `workspace.workers` take `includeHidden`
  ({§acp-place-hiding}). Migration 33.
- c3922c2: A loop stopped without failing (499) has the lifecycle `cancelled`, in the
  status gauge, the worker directory, `status.descendants` and the inbox; any
  other status of 400 or more stays `failed`. `LoopLifecycle` gains the word
  ({§loop-lifecycle-vocabulary}).
- 92270b9: The project's root `AGENTS.local.md` is projected as
  `worker:///_plurnk/AGENTS.local.md`, read from disk whatever its git status and
  hidden only by an exclusion, and read at turn 0 after `AGENTS.md`
  ({§session-initialization-entry}).
- dd52a9b: `loop/packet`, `loop/terminated` and the `loop_status` notice carry `loopSeq`,
  the loop's number among its worker's loops, beside `loopId`
  ({§notifications-loop-packet}, {§notifications-loop-terminated},
  {§loop-status-notice}). The AG-UI status gauge carries it as `status.loopSeq`,
  replaced in every delta that replaces `loopId` ({§acp-status-loop-number}); the
  conformance kit's gauge carries it.
- 4e4cb32: AG-UI: an accepted message is discoverable before its arrival (#1166).
  `status.inbox` lists the accepted messages the bound Worker has not yet
  observed; the snapshot carries the ones a client on the thread sent, with
  `metadata.plurnk.published` false, and their arrival folds onto them; a
  message Run admits its message before it presents anything, and no Run echoes
  its input into a snapshot. Contracts and the service gain `readInbox`.
- 952d5ce: The OpenTelemetry SDK registration is the new `@plurnk/plurnk-otel` module
  (#1167): it registers the trace and metric providers `OTEL_*` selects at
  module setup and releases them at stop, on OpenTelemetry JS 3
  (`@opentelemetry/sdk-trace`, API 1.10), and ships with the default
  installation. The service keeps only the OpenTelemetry API and sheds six SDK
  packages; an unsupported exporter name is now reported as that module's
  contained configuration (`module:@plurnk/plurnk-otel`).
- 06d4a8d: `reasoning/event` carries its turn's `loopSeq` and `turnSeq`
  ({§notifications-reasoning-event}), and every reasoning message names that
  turn as `metadata.plurnk.coordinate` (`L/T`) from its first event, live, as
  its row folds onto it and in a snapshot, a subagent's included
  ({§acp-plurnk-metadata}). The AG-UI conformance kit's specimens follow.
- 39f234e: A Run may negotiate its reasoning by link with
  `forwardedProps.plurnk.reasoning: "link"`: each reasoning message holds no
  text and names its turn's `reasoning://<worker>/L/T` address in its HTTP form,
  the live text arrives as `CUSTOM plurnk.reasoning`, and a snapshot holds each
  turn's link ({§acp-reasoning-link}). Every other Run receives reasoning as
  AG-UI defines it. No row repeats reasoning its message holds.
- 4b70069: Every receipt's H3 names its operand (`→ path`, `→ from → to` for
  COPY/MOVE), whether or not it is paired with its replayed operation; a
  paired receipt still leaves the pattern, scope, aside, metadata and body to
  that operation ({§paired-receipt}).
- b3864d5: `plurnk-service stop` ends the service that holds the configured database
  and returns once it has exited; a database nobody holds is not running, and
  that is success ({§startup-admission}). A `shared` launch without a log file
  writes to the service's `<state dir>/service.log`, which the result names as
  `logFile` ({§startup-admission}).
- de9ce8f: `status.streams` lists the streams the bound Worker holds open, each with its
  identity, lifetime, the row that opened it, and every channel's state, written
  or not, so a client attaching mid-execution finds a silent one; it is
  republished as `STATE_DELTA /plurnk/status/streams` when it changes
  ({§acp-status-streams}). `ApplicationPort.readStreams` reads it
  ({§methods-session-streams}). `stream/event`'s `contentLength` counts Unicode
  code points.
- 4a048a8: `readWorkerOverview` reads the places of the daemon or of one workspace with their
  lifecycle, the gates they wait on and their latest finished reply, most recently
  finished first and bounded ({§methods-session-overview}, {§message-completion},
  {§application-session-overview}); `excerptOf` is the one list excerpt rule
  ({§list-excerpt}). `workspace/renamed` announces a rename
  ({§notifications-workspace-renamed}). AG-UI: a Run carrying
  `forwardedProps.plurnk.overview` observes the overview as state, binding
  nothing: a snapshot on `/agui`, patches until the client leaves on
  `/agui/connect` ({§acp-overview-run}, {§acp-overview-state},
  {§acp-overview-updates}). `PLURNK_AGUI_OVERVIEW_WORKERS` bounds it and
  `PLURNK_AGUI_EXCERPT_CHARS` caps every list excerpt.
- 2693a59: A change to a worker's model, effort or spawn model is announced as
  `worker/policy` ({§notifications-session-policy}), and every client attached to
  the worker is sent the new route as `STATE_DELTA /plurnk/status/model`,
  whichever view made the change ({§acp-status-model}). A delta an event causes
  reaches the Run before any later event, its terminal included
  ({§acp-state-patches}).

### Patch Changes

- 0a3b016: A refusal of a blank tool request, a required body or target absent or neither
  supplied, carries the invocation's working form in `recovery`; a registry
  runtime named without a target answers with every enabled target's fence
  ({§executor-blank-invocation}).
- 93c0d87: `instanceof ConfigurationError` recognizes a configuration error from any copy of
  the package by its name and key ({§configuration-error-identity}), so a module
  loaded from its own plugin root reports its configuration errors as its
  diagnostic instead of aborting daemon boot.
- 8760da7: A READ of a file on disk that a members exclusion covers names the exclusion and
  that only the user can lift it, instead of offering a `members (add)` that cannot
  admit it ({§fs-namespace}).
- 519e7a1: An execution's `stream/concluded` summary sizes only the channels its executor
  declares and reads how it ended from the settled result: `completed`, with any
  exit code, for a success, and the Problem's title in lowercase for a failure
  ({§exec-stream}).
- 65028a4: `plurnk-service` refuses a Node.js below its `engines.node` floor with one
  line naming both versions, exit 1, before any other module loads
  ({§startup-admission}). `daemon/provider/not-configured` recovers with
  "Select a model for this worker, or set `PLURNK_MODEL=<provider/model>` as
  the service default; that provider's API key must be in the service's
  environment." ({§problems-functionality}). The generated
  `~/.config/plurnk/.env` cites no spec tag.
- 1fc7b1f: Membership honors the daemon user's own git excludes file, the configured
  `core.excludesFile` or git's default, and a refusal or `discover` verdict for an
  ignored file names the rule's file and line instead of "the repository"
  ({§membership}, {§membership}).
- 6c197b2: A model worker's initialization opens with the plan `1. Survey the environment.`
  `2. Evaluate and react to the Open Message.` and closes with its second step. A
  survey that would select nothing is left out of the program, and the program no
  longer READs its own `ops://` source ({§session-initialization-entry},
  {§session-initialization-entry}).
- 70b19d7: A loop's terminal reaps every loop-bound stream, one spawned before a park
  included, and is announced once those streams have concluded
  ({§exec-lifetime}, {§notifications-loop-terminated}).
- 6f3d277: A file beyond the model's members scope is admitted only by a client or operator
  definition, the user's to give: the `model-scope` refusal and the members
  teaching say so and no longer suggest staging a file ({§members-model-scope}).
- 2606732: A `members` glob is matched against member keys: an absolute spelling admits
  exactly what its root-relative spelling does, inside the root or beyond it, and
  READ reaches those members by either spelling. An absolute glob used to list
  matches that no READ could reach ({§members-functionality}).
- 22ec9ca: A result range of neither one nor two positions is refused naming
  `requestedPositions` as written and no extent ({§range-extent}).
- 68e8d53: A mounted route's failure ends its own request, never the daemon: its request
  answers `500 route-failed`, or is cut where its response had begun, and the
  failure is reported. A request target the listener cannot parse answers
  `400 request-target-invalid` instead of ending the process ({§http-host}).
- 19df83f: Specifications: every extension handler states its contract in a shipped
  `SPEC.md`; READMEs reduced to usage; new tags for the aliases cascade, the
  result-shape guards, the card read per wake and the llama-server effort posture.
- 1e6019e: A channel deleted before its terminal publication settles every publication of
  it ({§exec-stream}). An HTTP response without a readable projection
  drops the `readable` channel its request seeded; the loop that sent it no longer
  runs to its turn ceiling after its final reply.
- 808f1b6: A loop's `loop/terminated` is announced once. A gate its running turn holds
  settles first, and a cancellation announces the loops it retired after the
  worker's drain settles and the streams it reaped close
  ({§notifications-loop-terminated}).
- 4d1873a: A loop's `loop/terminated` follows its worker's pending `stream/concluded`,
  including a stream whose durable close already released its live handle
  ({§notifications-loop-terminated}).
- f3cd7de: `loop/packet` carries the loop's client gauge after each model turn, and
  `ApplicationPort.workerGauge` returns the gauge the Worker's latest packet
  reported ({§notifications-loop-packet}, {§methods-session-gauge}). AG-UI moves
  the budget with every packet and its snapshots carry the latest, so a live and
  a reattached observer agree ({§acp-state-patches}).
- e52015a: A worker name lost to a concurrent claim is refused as `name-conflict` (409),
  like any taken name, instead of escaping as an internal error.
- Updated dependencies [cfa2be9]
- Updated dependencies [b9f50b0]
- Updated dependencies [adc7466]
- Updated dependencies [ff99f76]
- Updated dependencies [21ada9c]
- Updated dependencies [a8200fb]
- Updated dependencies [65da58e]
- Updated dependencies [d2dcf47]
- Updated dependencies [d679cc5]
- Updated dependencies [93c0d87]
- Updated dependencies [25aadcf]
- Updated dependencies [f490341]
- Updated dependencies [cc3e9cb]
- Updated dependencies [1f136f9]
- Updated dependencies [fccdbf5]
- Updated dependencies [f7e3b0e]
- Updated dependencies [558c0db]
- Updated dependencies [c8866ff]
- Updated dependencies [0cee49c]
- Updated dependencies [ccf591f]
- Updated dependencies [878d630]
- Updated dependencies [c3922c2]
- Updated dependencies [72cfbc3]
- Updated dependencies [dd52a9b]
- Updated dependencies [b8ec13b]
- Updated dependencies [77ba31d]
- Updated dependencies [a7ccdf9]
- Updated dependencies [8e07dc6]
- Updated dependencies [50fbe81]
- Updated dependencies [041d30e]
- Updated dependencies [4e4cb32]
- Updated dependencies [1f3568a]
- Updated dependencies [4d934e4]
- Updated dependencies [952d5ce]
- Updated dependencies [7246520]
- Updated dependencies [22ec9ca]
- Updated dependencies [06d4a8d]
- Updated dependencies [39f234e]
- Updated dependencies [6adcfc6]
- Updated dependencies [ff0d82e]
- Updated dependencies [19df83f]
- Updated dependencies [de4fc63]
- Updated dependencies [de9ce8f]
- Updated dependencies [f3cd7de]
- Updated dependencies [1c125d0]
- Updated dependencies [4a048a8]
- Updated dependencies [2693a59]
- Updated dependencies [2e5b2c1]
  - @plurnk/plurnk-agui@5.0.0
  - @plurnk/plurnk-contracts@6.0.0
  - @plurnk/plurnk-meta@2.1.2
  - @plurnk/plurnk-schemes@3.3.0
  - @plurnk/plurnk-parser@4.2.1
  - @plurnk/plurnk-execs-common@3.0.1
  - @plurnk/plurnk-modules@4.1.0
  - @plurnk/plurnk-providers@5.0.0
  - @plurnk/plurnk-mcp@3.3.0
  - @plurnk/plurnk-otel@1.0.0
  - @plurnk/plurnk-mimetypes-application-ipynb@2.0.3
  - @plurnk/plurnk-mimetypes-application-json@2.0.2
  - @plurnk/plurnk-mimetypes-application-jsonl@2.0.2
  - @plurnk/plurnk-mimetypes-application-pdf@2.0.2
  - @plurnk/plurnk-mimetypes-application-xml@2.0.3
  - @plurnk/plurnk-mimetypes-audio@2.0.3
  - @plurnk/plurnk-mimetypes-image@2.0.2
  - @plurnk/plurnk-mimetypes-text-csv@2.0.2
  - @plurnk/plurnk-mimetypes-text-diff@2.0.2
  - @plurnk/plurnk-mimetypes-text-dotenv@2.0.2
  - @plurnk/plurnk-mimetypes-text-html@2.0.3
  - @plurnk/plurnk-mimetypes-text-ini@2.0.2
  - @plurnk/plurnk-mimetypes-text-markdown@2.0.2
  - @plurnk/plurnk-mimetypes-text-plain@2.0.2
  - @plurnk/plurnk-a2a@4.0.2
  - @plurnk/plurnk-agent-skills@2.0.4
  - @plurnk/plurnk-digest@3.2.3
  - @plurnk/plurnk-execs@4.0.2
  - @plurnk/plurnk-hooks@2.0.4
  - @plurnk/plurnk-mimetypes@3.0.5
  - @plurnk/plurnk-schedule@3.0.5
  - @plurnk/plurnk-schemes-http@2.0.4
  - @plurnk/plurnk-skills@3.0.4

## 4.2.1

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-mimetypes-application-ipynb@2.0.2

## 4.2.0

### Minor Changes

- d67251b: A model's READ of an untracked file, or a FIND whose text pattern matches inside
  one, proposes the file's admission through the proposal lifecycle (202, body
  `{"files": [...]}`, effect `host`): accepted by policy where nobody reviews or by
  the reviewer otherwise, it is admitted as the Worker's own `members (add)` and
  the operation runs again; rejected, it admits nothing. The universe is listed
  whenever the knob is on ({§membership-auto-add}; #1160).
- a2b6275: A file path beyond the project root is spelled as the absolute path it names —
  in addresses, misses and the `path_normalized` notice — never as a `../` climb;
  a path inside the root stays project-relative. An absolute spelling of a path
  beyond the root is already canonical and earns no notice
  ({§fs-namespace}; #1146).
- d4f8760: `PLURNK_MEMBERS_AUTO_ADD=1` (default): a model's READ of an untracked, unignored,
  unexcluded project file admits it as the Worker's own member definition and reads
  it; a FIND lists such files as `untracked` and admits the ones its text pattern
  matches; a `member_added` notice announces each admission. Indexed dialects see
  members only; the members scope still bounds every admission; `0` restores the
  baseline (#1154).
- a619ed6: The card states its NOTE rule as one command, `YOU MUST persist all new facts,
  ideas, and plans in NOTEs on every turn.`, and the reminder returns: a model
  turn that continues or parks without a NOTE in its program or from its
  reasoning is told so in the next packet by the `engine:turn` notice
  `continued_without_note` (`level: warn`, that command as its directive). A
  notice, never a failure ({§continued-without-note}).

### Patch Changes

- 5450069: The finish reason is the AI SDK's unified classification; the raw vendor value
  rides beside it. A finish the SDK classifies as `error` fails the attempt as
  `generation_failed` (502, not re-issued; Core settles it on the provider
  response contract). The dropped-output rule, its `output_dropped` kind and
  `PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS` are gone: billed output tokens are
  accounting, never evidence of missing text, so a completed answer is admitted
  with absent, summarized or verbatim reasoning (#1156, #1157).
- f320b9b: `FunctionalityPrepared` gains a required synchronous `publish()` returning an
  undo. Candidate state goes live there, inside the coordinator's registry
  commit, with no I/O; `commit()` is post-publication settlement; `abort()`
  discards an unpublished candidate. The coordinator composes the adapter's undo
  with its own view rollback. MCP consumes a pending OAuth candidate at publish,
  so a callback replayed after publication is `404 oauth-not-pending` with no
  window (#1155).
- acffc4f: The card teaches NOTE as working memory — save all new facts, ideas and plans
  for later turns — with `fact`, `idea` and `plan` examples in place of `plan`,
  `finding`, `decision` and `next`. The initialization turn's two NOTEs follow:
  both carry the `plan` aside, and the opening plan's third step saves facts,
  ideas and plans (#1153).
- Updated dependencies [5450069]
- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-providers@4.0.0
  - @plurnk/plurnk-contracts@5.0.0
  - @plurnk/plurnk-modules@4.0.1
  - @plurnk/plurnk-mcp@3.2.1
  - @plurnk/plurnk-a2a@4.0.1
  - @plurnk/plurnk-skills@3.0.3
  - @plurnk/plurnk-schedule@3.0.4
  - @plurnk/plurnk-parser@4.2.0
  - @plurnk/plurnk-agui@4.0.1
  - @plurnk/plurnk-digest@3.2.2
  - @plurnk/plurnk-agent-skills@2.0.3
  - @plurnk/plurnk-execs@4.0.1
  - @plurnk/plurnk-hooks@2.0.3
  - @plurnk/plurnk-mimetypes@3.0.4
  - @plurnk/plurnk-schemes@3.2.2
  - @plurnk/plurnk-schemes-http@2.0.3

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
- Updated dependencies [84c0d49]
- Updated dependencies [1c19a58]
  - @plurnk/plurnk-contracts@4.1.0
  - @plurnk/plurnk-parser@4.1.0

## 4.0.0

### Upgrade

Upgrade the terminal client and daemon together. Version 4 replaces the previous
authentication and client-binding contracts; it is not wire-compatible with the
3.x client.

- Authentication is enabled by default. Replace `PLURNK_AGUI_TOKEN` or
  `PLURNK_AGUI_SECRET` with `PLURNK_SECRET`, or leave it unset and let the
  daemon generate a per-boot secret beside its database. Clients exchange that
  secret for short-lived access credentials; it is not itself a bearer token.
  `PLURNK_AUTH=0` explicitly disables authentication.
- Browser sign-in uses `PLURNK_PASS`, which defaults to empty and admits nobody.
  Sessions and access/refresh credentials are revocable and expire; restarting
  the daemon invalidates them. Set `PLURNK_AGUI_ISSUER` only when the public
  origin differs from the origin reaching the daemon.
- Remove `PLURNK_AGUI_LOGIN_ATTEMPTS` and `PLURNK_AGUI_LOGIN_WINDOW_SEC`.
  The supplied `plurnk.nginx.conf` demonstrates TLS, security headers and
  front-proxy rate limiting.
- Hosted A2A uses the same credential authority, not `PLURNK_A2A_TOKEN`.
  Configure its workspace name, project folder, or both; there is no implicit
  `a2a` workspace.
- `sh` uses an executable absolute `SHELL`, otherwise `/bin/sh`, and advertises
  the resolved shell. Workloads needing a particular shell should select it
  explicitly in their environment.
- Existing databases migrate in place through schema version 32. Back up before
  upgrading; do not open an upgraded database with an older daemon.

### Client and module contracts

- An AG-UI thread represents a model worker. Qualified addresses are
  `<workspace ID>#<worker name>`; ordinary opaque thread IDs acquire a durable
  folderless workspace/worker association on their first creating Run.
  Passive inspection creates nothing, and reconnects and workspace renames
  preserve the association.
- Workspace identity, mutable name and optional project folder are separate.
  Folder-derived defaults use the daemon's `~` abbreviation. New names reject
  digit-only text, unpaired Unicode surrogates and slash-delimited dot segments;
  existing names remain accessible by ID. `workspace.attach` selects an existing
  workspace by exactly one of ID, literal name or folder-derived default.
- The daemon has no default model worker. Clients choose one; the terminal's
  default is `user`. Module/action scope `world` is replaced by `daemon`.
- A person's direct operations journal in the workspace's runtime actor
  `_plurnk`, attributed to that person, rather than creating client workers.
  Migration preserves those workers' history, rehomes their children as roots,
  and removes their former worker-local environment layers.
- LOOK, the parser's client-only tier and `ApplicationPort.look` are removed.
  Resource reads use ordinary READ operations or the public read APIs.
  `ApplicationPort`, `HttpHost` and `HttpRouteHandler` are imported from
  `@plurnk/plurnk-contracts/port`; the contracts root is browser-neutral.
- `createWorker` replaces `createConversationWorker`;
  `workerAccounting` replaces `descendantAccounting`.
  Direct-operation dispatch and rollback take the acting identity rather than
  a client-worker ID. See the package specifications for the public API shapes.

### Standard AG-UI conversation

- Live messages and snapshots preserve the same identities, exact operation
  operands, reasoning, correlated command output and delegated results.
  Standard subagent events represent child runs; normal tool results carry
  their conclusions instead of launch receipts.
- A Run's message list is its copy of the conversation. Only a new trailing
  user message is submitted; an unchanged list synchronizes. Repeated message
  IDs are idempotent, and changing an accepted message's body is refused.
- Standard outcomes carry results and reported token usage. Plurnk's row,
  terminal and failure details use `metadata.plurnk`; remaining custom events
  describe facts with no standard conversation representation.
- Approval interrupts identify the gated operation and resume by interrupt ID.
  The retired `request_approval` pseudo-call and duplicate custom row/result
  events are removed. This release adds no web approval interface.

### Reliability and maintenance

- Subsystem changes settle in authored order before later operations use them.
  Members admitted earlier in a program are immediately readable; explicitly
  shaped executor calls can use MCP tools added or enabled earlier in that program.
- Cancellation stops subsequent operations and unresolved glob targets while
  retaining completed effects and provider accounting.
- Routine status 200 is omitted from every model-facing receipt. Other statuses,
  durable results, message completion and external protocol responses are unchanged.
- Workspace MCP preparation runs concurrently with per-alias progress, and
  owner attachment starts activation without blocking the client.
- Shutdown cancels preparation, joins publication and cleanup, and releases
  observers. Restart settlement is atomic, preserves unanswered-message waits,
  and recovers orphaned messages from durable data.
- Catalog filtering, existence checks, failure counts and empty-entry pruning
  use relational predicates at their owning write/read boundaries.
- Loop timing and lifetime worker-plus-descendant spend come from durable
  daemon state. Output-truncated emissions are no longer mistaken for cycles.
- The packet names live obligations as Open Work. NOTE teaching and initialization
  examples emphasize plans, findings, decisions and next actions.
- Native ECMAScript output and shared erasable-TypeScript checks target Node 26.
  Digest errors are labelled once, and an empty workspace remains identifiable.

The optional web foundation is not published with this release. Conversation
waterfall, composer and web approval presentation remain separate work.

## 3.3.0

### Minor Changes

- d99a836: An executor's preparation declares whether its invocation registers an input
  receiver (`ExecPreparation.input: "open"`; the subprocess and jq executors
  declare it when launched with `[{"stdin": "open"}]`), and SEND to an execution
  answers each state exactly: launched without input is refused at once naming
  the launch form; queued for a slot is refused at once and retryable; a declared
  receiver that has not opened yet is waited for within the input timeout, and
  the execution settling first closes input. A receiver registered without the
  declaration is the executor's defect and fails its run.
- 5b7460a: The Context gauge states its share on every packet with a budget: `percent`,
  `floor(100 × tokens / budget)` over the gauge's own final figures, sits after
  `tokens` and `budget`; the `largest` inventory still joins only above
  `PLURNK_SERVICE_BUDGET_PRESSURE`. The `budget_pressure` notice and its "YOU
  MUST NOT exceed budget." directive are retired; the over-budget row remains the
  one mandate, for a packet that does not fit.
- 3e3e2f4: A settled file mutation's log row keeps the unified diff of what it did: an
  accepted EDIT, COPY, MOVE or KILL that writes or removes a text member appends
  `current` to `proposed` to `log_entries.patch` (migration 28), served as the
  row's `patch` channel (`log:///<loop>/<turn>/<item>/<OP>#patch`, `text/x-diff`)
  for the life of the row and copied by a fork. A byte write, a member past the
  materialization bound, and a row settled before this version keep none, and a
  reader meets no channel rather than an invented one.
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
- 89def41: The packet's `## Worker` block carries the worker's approval owner and whether a
  person attends it (`"owner": {"address", "interactive"}`), so a model knows up
  front when nobody can answer a question ({§child-orientation}).
- a8df72c: Rollback reverses a worker's settled file mutations after a log coordinate,
  latest first, as the acting client's own operations:
  `rollback({ workspaceId, workerId, clientWorkerId, to })` on the application
  port, `workspace.rollback { to, workerId? }` for a client, and `RollbackReport`
  naming what was restored, the rows skipped (no patch, or reversed already) and
  where drift or a refusal stopped it (#880).
- 6320dc4: A message a worker sends to another worker holds the sender until it is
  completed: `worker_obligations` gains `messages` beside `streams` and
  `workers`, an authored WAIT parks on it, the completion wakes the same loop, and
  with no WAIT the sender joins the bounded park instead of concluding idle. The
  packet's Delegation object lists those messages as its third pointer list. A
  loop that ends with another worker's message unanswered has it completed 499
  by the daemon, delivered to the sender like any reply.
- 16a7eca: A WORK whose name a worker already holds delivers its body to that worker as a
  message through the voice door: nothing is created, the receipt names the
  worker and `delivered: message`, and an `env` option is refused by name since a
  message takes none. FORK to a held name stays `409 worker-name-conflict`, now
  with a recovery naming the working forms. The ping/pong between a parent and
  the worker it names, spawn then message, is witnessed end to end.

### Patch Changes

- be45046: The live and demo tiers write a census: every run lands its workers and a
  `census.md`/`census.json` under one `tier-<kind>-<stamp>/` directory in the
  benchmark home, each specimen declares what it requires of its route and host
  and skips by name when unmet, and `tier:history` ledgers runs ({§tier-census}).
  The third-party MCP composition, the llama-server rails, the upstream A2A TCK
  and the client's real-model TUI tier are live specimens, no longer opt-in flags
  or scripts. `digest-missing` recovers workers inside tier runs and resolves the
  benchmark home the one way every harness does.
- Updated dependencies [1799168]
- Updated dependencies [d99a836]
- Updated dependencies [ee4c585]
- Updated dependencies [3e3e2f4]
- Updated dependencies [157cf8f]
- Updated dependencies [a8df72c]
  - @plurnk/plurnk-agui@3.1.0
  - @plurnk/plurnk-execs@3.2.0
  - @plurnk/plurnk-mcp@3.1.0
  - @plurnk/plurnk-schemes@3.2.0
  - @plurnk/plurnk-contracts@3.3.0
  - @plurnk/plurnk-modules@3.2.0
  - @plurnk/plurnk-schedule@3.0.2

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
- The initialization NOTE that leads a worker's first program carries the card's `summary`
  aside, so the first NOTE a model sees is written the way the card's first example is.
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
