# @plurnk/plurnk-execs

## 2.0.1

### Patch Changes

- 0b21165: Disable the native question tool by default through the existing executor switch;
  explicit opt-in preserves its implementation and client-interaction lifecycle.
  Clarify that SEND carries progress updates and WAIT yields to children and streams,
  without changing either operation's behavior.
- Updated dependencies [36277b1]
- Updated dependencies [0d5480b]
- Updated dependencies [0b21165]
- Updated dependencies [8461082]
- Updated dependencies [0d5480b]
  - @plurnk/plurnk-contracts@3.0.0
  - @plurnk/plurnk-parser@3.0.0

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
  - @plurnk/plurnk-parser@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
