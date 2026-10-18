# @plurnk/plurnk-a2a

## 4.0.1

### Patch Changes

- f320b9b: `FunctionalityPrepared` gains a required synchronous `publish()` returning an
  undo. Candidate state goes live there, inside the coordinator's registry
  commit, with no I/O; `commit()` is post-publication settlement; `abort()`
  discards an unpublished candidate. The coordinator composes the adapter's undo
  with its own view rollback. MCP consumes a pending OAuth candidate at publish,
  so a callback replayed after publication is `404 oauth-not-pending` with no
  window (#1155).
- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 4.0.0

### Breaking changes

- Hosted A2A uses the daemon's credential authority and advertises OAuth client
  credentials with scope `a2a`. Configure remote agents as
  `PLURNK_AGUI_CLIENT_<id>`; `PLURNK_A2A_TOKEN` is removed.
- Inbound tasks require a configured workspace name, project folder, or both.
  There is no implicit `a2a` workspace; set `PLURNK_A2A_WORKSPACE=a2a` to
  retain that choice. A folder alone selects its unique workspace, creating it
  lazily when absent and refusing ambiguity.
- Uses contracts/modules 4.0 and the model-worker lifecycle API.

### Improvements

- Outbound definitions support OAuth client credentials with symbolic secrets,
  discovery of the declared token flow and one refresh on an unauthorized reply.
- Public card/token URLs follow the incoming origin unless an explicit origin
  is configured for a proxy.
- Preparation reports in-flight aliases and follows host cancellation, preserving
  real failures while joining cleanup on shutdown.

This release does not claim complete A2A conformance.

## 3.1.1

### Patch Changes

- Third-party dependencies pulled forward to their latest stable versions: the
  AI SDK providers and `ai`, the MCP SDK, the OpenTelemetry packages, `express`,
  `music-metadata`, `smol-toml`, `web-tree-sitter`, `xpath`, `zod`, and the
  Models.dev catalog snapshot. `json-p3` stays at 2.3.1 while its newer archive
  requires a TypeScript compiler in production installs.

## 3.1.0

### Minor Changes

- 0060c82: Run each hosted A2A Task in an ordinary child worker, with related conversation
  available as a retained Context resource. Tasks can progress and be cancelled
  independently without an extra Context worker or a second execution manager.
  Each streaming request observes its own initial snapshot and the durable result.
  
  Support an exact unfinished Loop recipient on the application message boundary;
  late continuations cannot reopen completed Tasks. Make simultaneous first model
  selections reuse the same immutable route instead of failing a uniqueness check.

### Patch Changes

- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 4bb8114: An A2A Context is one conversation: its worker holds every Task, and each Task
  is one of that worker's loops, so a later Task sees the caller's earlier
  messages and the replies to them. A Context runs one Task at a time; a new Task
  while one is open is refused with `UNSUPPORTED_OPERATION`.
- 5f10995: The inbound exposure converses with its caller by message only. A Task no
  longer enters `INPUT_REQUIRED`: the model asks the caller in its reply, and
  the answer arrives as a later Task in the same Context. An interaction a Task
  raises, such as a `question`, goes to the worker's owner like any other
  worker's, and needs an interactive one.
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
- 8d9fb11: Model-facing documents describe a proposal as reviewed by the worker's owner
  unless `PLURNK_SERVICE_PROPOSALS` accepts or rejects it.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
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
  - @plurnk/plurnk-schemes@2.0.0
