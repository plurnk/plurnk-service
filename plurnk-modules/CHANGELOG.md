# @plurnk/plurnk-modules

## 2.0.1

### Patch Changes

- 36277b1: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
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
