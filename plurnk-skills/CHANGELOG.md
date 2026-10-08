# @plurnk/plurnk-skills

## 2.0.0

### Major Changes

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
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-modules@2.0.0
  - @plurnk/plurnk-agent-skills@2.0.0
  - @plurnk/plurnk-agent-plugins@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
