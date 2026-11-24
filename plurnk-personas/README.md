# Plurnk personas

The daemon module for workspace personas: 4-tier configuration discovery (`<project>/.agents/personas`, `$XDG_CONFIG_HOME/plurnk/personas`, `$XDG_CONFIG_HOME/agents/personas`, `~/.agents/personas`), inline and source-backed workspace definitions, and writable `persona://` resource trees. Included in the default Plurnk service installation and composed via `@plurnk/plurnk-personas/module`.

Configure defaults and enabledness through [.env.defaults](./.env.defaults), standard persona roots, `persona://<name>/PERSONA.md`, or the `personas` family. See [SPEC.md](./SPEC.md) for the contract and [docs/personas.md](./docs/personas.md) for the model-facing reference.
