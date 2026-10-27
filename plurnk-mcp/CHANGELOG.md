# @plurnk/plurnk-mcp

## 3.3.1

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
  `SEND` with `WAIT` and no live work remains ({§executor-discovery},
  {§executor-discovery}, {§mcp-model-projection}, {§functionality-model-projection},
  {§oauth-continuation}, {§loop-completion}) (#1228).

## 3.3.0

### Minor Changes

- b8ec13b: An enabled server that cannot run keeps its alias, registered out of service;
  a call to it is refused with the state that keeps it from running
  ({§mcp-configuration}). A request refused for want of a sign-in — a tool
  call, a resource or prompt read, or a completion — on a URL-only or interactive
  OAuth definition fails `401 authorization-required` and republishes its alias
  awaiting a sign-in ({§mcp-host-composition}).
- a7ccdf9: `list` shows the grant an active alias presents as its `detail.grant`: the
  issuer its tokens came from, the scope its authorization server stated, and
  whether it refreshes; never a token ({§oauth-continuation}).
- 8e07dc6: An accepted interactive sign-in outlives its connection: each later connection
  for its alias with the same definition presents and refreshes it, after
  workspace cooling, an enable, or disable then enable ({§oauth-continuation}). A
  connection carrying a grant starts a sign-in only at a redirect its definition
  configures.
- 50fbe81: An interactive `McpOAuth` definition may name the `issuer` its sign-in binds
  to, where discovery starts, and `authorizationParams` added to the
  authorization request, such as `access_type=offline` ({§mcp-server-definition},
  {§oauth-continuation}). `oauth.begin` for an alias awaiting a sign-in after a refused
  request starts the authorization on a connection its server never challenges
  ({§oauth-continuation}).

### Patch Changes

- 77ba31d: A completion's parameters are read through the protocol's own schema
  (`@modelcontextprotocol/core`, now a dependency); a malformed request is
  refused with the schema's issues.
- 041d30e: The `mcp` page teaches that a sign-in takes effect between turns: in the turn
  it completes, `list` still reports `authorization-required` and a call to the
  server is refused ({§oauth-continuation}).
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

## 3.2.1

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

## 3.2.0

- Prepare configured MCP servers concurrently and expose each alias in flight.
- Honor host cancellation during preparation and join cleanup on shutdown without
  publishing cancellation as an unavailable server. Real failures remain visible.
- Uses contracts/modules/execs 4.0.

## 3.1.0

### Minor Changes

- ee4c585: A tool whose `x-mcp-header` declarations break SEP-2243 is never called: the
  definition is scanned before either request leg, Tasks or direct, and an
  invalid declaration refuses the call with `tool-header-invalid` naming the tool
  and the declaration, with no request sent. `number` is no longer a permitted
  header type, and a declaration under `items`, `additionalProperties`, a
  combinator, a conditional or `$defs` invalidates the definition. The
  conformance referee moves to `0.2.0-alpha.12`.

### Patch Changes

- Updated dependencies [157cf8f]
- Updated dependencies [a8df72c]
  - @plurnk/plurnk-contracts@3.3.0

## 3.0.1

### Patch Changes

- 0b7f8b1: Add shared named definition replacement, retaining enabledness and preserving
  the previous publication on refusal. Use it for repeated environment EDITs
  and explicit child environment overrides, and reject fresh skill preparation
  failures when their definitions change. Carry attempt-local admission data
  through preparation without changing live state; schedule replacements and
  retries affect timers and held delivery failures only after publication.
- fc84b9a: Clarify ambient credential exclusion versus explicit MCP launch bindings through
  the existing approval path. Correct reserved-environment diagnostics and reference
  documentation without changing credential admission or adding configuration.
- f951f40: Report elapsed preparation time, the configured timeout, and bounded, redacted
  SDK diagnostics and session stderr when an MCP server is unavailable. The
  published Problem remains visible through the existing server list.
- 7163937: Document existing failure codes omitted from the owning specifications. Runtime
  behavior and failure identities are unchanged.
- Updated dependencies [960777f]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-contracts@3.2.0

## 3.0.0

### Major Changes

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

- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- 8d9fb11: Model-facing documents describe a proposal as reviewed by the worker's owner
  unless `PLURNK_SERVICE_PROPOSALS` accepts or rejects it.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [503ea87]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-modules@3.0.0
  - @plurnk/plurnk-schemes@3.0.0
  - @plurnk/plurnk-execs@3.0.0

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Use the OAuth issuer-binding security fix in MCP SDK 2.2.0.
- Updated dependencies
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-modules@2.0.0
  - @plurnk/plurnk-agent-plugins@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
  - @plurnk/plurnk-execs@2.0.0
