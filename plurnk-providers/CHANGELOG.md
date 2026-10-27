# @plurnk/plurnk-providers

## 5.0.2

### Patch Changes

- Replace per-`(principal, threadId)` worker ownership with a single workspace-scoped operator owner (`agui://operator`), derive owner interactivity from the live union of attached AG-UI client Runs in the workspace, deliver proposal and `question` interrupts across every attached client Run with idempotent resolution convergence, and refresh the Models.dev snapshot to `@opencode-ai/models@0.0.114` (#1231).

## 5.0.1

### Patch Changes

- c30873c: Pull external runtime and protocol dependencies across the platform
  constellation to their latest stable releases, including
  `@modelcontextprotocol/client` and `@modelcontextprotocol/core` `2.4.0`,
  `json-p3` `^3.0.1`, `ai` `7.0.152` and its `@ai-sdk/*` providers,
  `eventsource-parser` `^4.1.2`, `linkedom` `^0.18.14`, `marked` `^18.1.1`,
  `music-metadata` `^12.2.3`, and `zod` `^4.6.7` (#1227).
- 2b882f9: Translate the calibrated curation budget additively by measured overhead
  without extrapolating unmeasured content, remove daemon-side row shedding at
  the context wall, resolve `PLURNK_PROVIDERS_OUTPUT_FLOOR` percentages against
  the effective output ceiling, and refuse model changes whose calibrated budget
  cannot hold the worker's current context with `413 context-exceeds-model-budget`
  ({§tokenomics}, {§tokenomics}, {§provider-output-floor},
  {§session-model-selection}) (#1225).

## 5.0.0

### Major Changes

- 72cfbc3: A detected llama-server route admits `off` and `adaptive`. A fixed effort needs
  `PLURNK_PROVIDERS_REASONING_EFFORTS` (alias form `_<alias>`) naming the levels
  its chat template distinguishes; an undeclared fixed `PLURNK_PROVIDERS_EFFORT`
  is refused at construction. A compatible route without a template refuses a
  fixed effort without naming a declaration (#1200).

### Patch Changes

- 19df83f: Specifications: every extension handler states its contract in a shipped
  `SPEC.md`; READMEs reduced to usage; new tags for the aliases cascade, the
  result-shape guards, the card read per wake and the llama-server effort posture.
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

## 4.0.0

### Major Changes

- 5450069: The finish reason is the AI SDK's unified classification; the raw vendor value
  rides beside it. A finish the SDK classifies as `error` fails the attempt as
  `generation_failed` (502, not re-issued; Core settles it on the provider
  response contract). The dropped-output rule, its `output_dropped` kind and
  `PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS` are gone: billed output tokens are
  accounting, never evidence of missing text, so a completed answer is admitted
  with absent, summarized or verbatim reasoning (#1156, #1157).

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 3.0.3

- Align worker terminology and the contracts 4.0 dependency without changing
  provider routing or tuning.

## 3.0.2

### Patch Changes

- f044435: A request cancelled through a shared abort signal keeps its own failure
  evidence: the SDK now rejects every request on that signal with the same reason
  object, so the transport wraps it per request before keying evidence on it.
- Third-party dependencies pulled forward to their latest stable versions: the
  AI SDK providers and `ai`, the MCP SDK, the OpenTelemetry packages, `express`,
  `music-metadata`, `smol-toml`, `web-tree-sitter`, `xpath`, `zod`, and the
  Models.dev catalog snapshot. `json-p3` stays at 2.3.1 while its newer archive
  requires a TypeScript compiler in production installs.
- Updated dependencies [960777f]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-contracts@3.2.0

## 3.0.1

### Patch Changes

- a77e136: Read one fresh environment snapshot per alias projection instead of repeatedly
  enumerating host variables for every knob, preserving precedence and live edits.
- 7de7f76: Link packet and physical-request evidence through readable Markdown. Preserve
  failure and missing-evidence distinctions; support opt-in capture of final
  SDK-dispatched request bodies while omitting headers and URL details.
- 1d585b4: Render each notice in the model packet as one alert callout in the card's own
  form: the level picks the callout, an optional `directive` (`YOU MUST`,
  `YOU SHOULD`, ...) leads, then the factual message and the kind. Notices about
  the model's own output carry a directive; environment notices carry none.
- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 8d9fb11: `RequestFields.rejectRetired` is removed. The providers package reads only its
  declared keys; it names no other key to refuse it.
- 06960fc: The provider notice `grammar_unenforced` is now `output_unaccounted`, and its
  message states the two counts: the output tokens billed and the tokens visible
  across content and reasoning.

### Patch Changes

- 85bcf56: Pin the AI SDK runtime and provider adapters to the verified dependency
  versions, preserving the tested SDK selection in fresh consumer installs.
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
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-models@3.0.0

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
  - @plurnk/plurnk-aliases@2.0.0
  - @plurnk/plurnk-models@2.0.0
