# @plurnk/plurnk-plurnkdown

Plurnkdown — the [plurnk-service](https://github.com/plurnk/plurnk-service) packet house style: GFM + Mermaid + fenced Plurnk ops.

`PACKET.md` is the standard every outbound packet is built against. The linter enforces it:

- `op-fence` — a bare Plurnk op in prose belongs in a ```plurnk fence.
- `op-syntax` — fenced ops parse statement-level via `@plurnk/plurnk-contracts/grammar`.
- `run-on` — soft-warn on multi-compound run-ons; prose stays atomic (split, don't weld).

## license

MIT © PossumTech Laboratories, LLC
