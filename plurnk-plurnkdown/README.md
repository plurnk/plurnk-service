# @plurnk/plurnk-plurnkdown

Plurnkdown — the [plurnk-service](https://github.com/plurnk/plurnk-service) packet house style: GFM + Mermaid + fenced Plurnk ops.

[`SPEC.md`](./SPEC.md) is the tagged Markdown contract for outbound packets. The linter enforces
its two diagnostic rules:

- `op-syntax` — executable fences parse statement-level via `@plurnk/plurnk-contracts`.
- `run-on` — soft-warn on multi-compound run-ons; prose stays atomic (split, don't weld).

## license

MIT © PossumTech Laboratories, LLC
