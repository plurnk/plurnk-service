# Plurnk skills

The daemon module for standard [Agent Skills](https://agentskills.io): discovery,
workspace definitions, live folders, fetched Git/archive copies, and `skill://` resources.
Included in the default Plurnk service installation; loaded through ordinary module discovery.

Configure sources and enabledness through [.env.defaults](./.env.defaults), standard skill
locations, or the `skills` family. The host composes Plurnk's own reference as an ordinary skill.

The format library is `@plurnk/plurnk-agent-skills`. This package owns workspace management,
not the file format. See [SPEC.md](./SPEC.md) for the contract and [docs/skills.md](./docs/skills.md)
for the model-facing reference.

## Upgrading from core-owned skills

The extraction is a breaking API and configuration change:

| Removed | Replacement |
| --- | --- |
| `Skill` export from `@plurnk/plurnk-service` | `ResourceTreeRegistrationSeam` in `@plurnk/plurnk-schemes`; modules supply read-only resource trees. |
| `PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS` | `PLURNK_SKILLS_FETCH_TIMEOUT_MS`; the old key is rejected, not aliased. |

Existing workspace definitions and fetched copies move in place during the database and
host-storage upgrade ({§skills-storage-upgrade}); they need neither deletion nor refetching.
