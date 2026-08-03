# @plurnk/plurnk-plurnkdown

Plurnkdown — the [plurnk-service](https://github.com/plurnk/plurnk-service) packet house style: GFM + Mermaid + fenced Plurnk ops.

[`SPEC.md`](./SPEC.md) is the tagged Markdown contract for outbound packets. The linter enforces
its three diagnostic rules:

- `op-fence` — a bare Plurnk op in prose belongs in a `plurnk` fence.
- `op-syntax` — fenced ops parse statement-level via `@plurnk/plurnk-contracts`.
- `run-on` — soft-warn on multi-compound run-ons; prose stays atomic (split, don't weld).

## license

MIT © PossumTech Laboratories, LLC
