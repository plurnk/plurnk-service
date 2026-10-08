# @plurnk/plurnk-parser

## 3.0.0

### Major Changes

- 8461082: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.

### Patch Changes

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
  - @plurnk/plurnk-contracts@2.0.0
