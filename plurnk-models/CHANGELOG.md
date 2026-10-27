# @plurnk/plurnk-models

## 3.0.3

### Patch Changes

- Replace per-`(principal, threadId)` worker ownership with a single workspace-scoped operator owner (`agui://operator`), derive owner interactivity from the live union of attached AG-UI client Runs in the workspace, deliver proposal and `question` interrupts across every attached client Run with idempotent resolution convergence, and refresh the Models.dev snapshot to `@opencode-ai/models@0.0.114` (#1231).

## 3.0.2

### Patch Changes

- b28031f: `@opencode-ai/models` moves to `^0.0.113` ({§model-catalog-build}).
  `effort-unsupported` and `effort-invalid` name the route's supported or valid
  efforts in `recovery`, and `provider-unavailable` includes the provider's
  instantiation failure ({§session-model-selection}, {§operation-results}).

## 3.0.1

### Patch Changes

- Third-party dependencies pulled forward to their latest stable versions: the
  AI SDK providers and `ai`, the MCP SDK, the OpenTelemetry packages, `express`,
  `music-metadata`, `smol-toml`, `web-tree-sitter`, `xpath`, `zod`, and the
  Models.dev catalog snapshot. `json-p3` stays at 2.3.1 while its newer archive
  requires a TypeScript compiler in production installs.

## 3.0.0

### Major Changes

- 8d9fb11: `retiredProviderNames()` is removed. A provider segment resolves only as a
  Models.dev id; any other segment resolves to nothing.

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.
