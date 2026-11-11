# Plurnk skills

The daemon module for standard [Agent Skills](https://agentskills.io): discovery,
workspace definitions, live folders, fetched Git/archive copies, and `skill://` resources.
Included in the default Plurnk service installation and composed via `@plurnk/plurnk-skills/module`.

Configure sources and enabledness through [.env.defaults](./.env.defaults), standard skill
locations, or the `skills` family. The host composes Plurnk's own reference as an ordinary skill.

The format library is `@plurnk/plurnk-agent-skills`. This package owns workspace management,
not the file format. See [SPEC.md](./SPEC.md) for the contract and [docs/skills.md](./docs/skills.md)
for the model-facing reference.
