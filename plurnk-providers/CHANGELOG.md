# @plurnk/plurnk-providers

## 2.0.1

### Patch Changes

- Pin the AI SDK runtime and provider adapters to the verified dependency
  versions, preserving the tested SDK selection in fresh consumer installs.
- 0d5480b: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings and
  owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no longer
  accept loop policy. A2A clarification still returns to the caller, separately
  from local operation approval. Existing databases upgrade in place.
- Updated dependencies [36277b1]
- Updated dependencies [0d5480b]
- Updated dependencies [0b21165]
- Updated dependencies [8461082]
- Updated dependencies [0d5480b]
  - @plurnk/plurnk-contracts@3.0.0

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
