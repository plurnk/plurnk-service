# @plurnk/plurnk-personas

## 1.1.0

### Minor Changes

- 8032dbd: Enforce unified physical `realpath` containment for local project-scoped skill
  and persona sources (`path-containment.ts` in `@plurnk/plurnk-meta`), and
  advertise registered Functionality `families` in `daemonPolicy()` (#1567, #1569).

### Patch Changes

- Updated dependencies [f4c6ae9]
- Updated dependencies [8032dbd]
  - @plurnk/plurnk-meta@4.1.0

## 1.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-service/issues).

### Major Changes

- Initial release: workspace persona discovery (`PERSONA.md`), Functionality
  family (`workspace.personas.*`), and `persona://` resource trees over shared
  `@plurnk/plurnk-agent-skills` primitives (`#1559`).
- Dependencies:
  - `@plurnk/plurnk-agent-skills@^2.1.0`
  - `@plurnk/plurnk-meta@^4.0.0`
  - `@plurnk/plurnk-contracts@^10.0.0`
  - `@plurnk/plurnk-modules@^5.0.0`
  - `@plurnk/plurnk-schemes@^3.0.0`
