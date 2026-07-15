# PACKET — the outbound packet as clean plurnkdown

The standard every outbound packet (system doc + turn packet) is built against.
`plurnk-plurnkdown` owns this standard; **core** emits against it; grammar's `plurnk.md`
is its embedded doc.

**Status: first sweep — the document spine.** The log-item rendering is owner-held
(bikeshed pending). Section-by-section generation alignment is the next phase. This doc
grows with each.

## Invariants (non-negotiable)

Every conformant packet preserves, always:

- **Addressability** — `log:///loop/turn/item`, `<line,line>`, `#channel`, and path-globs resolve unchanged.
- **Weighability** — per-item `tokens`; the Budget tables.
- **Honesty** — every status/error (`409`, `413`, `416`, …), every bodyless 0-token item, every FOLD/OPEN state rendered faithfully. A cleaner envelope, never a prettier lie.
- **Log data stays JSON** — housed in fences, never prose-ified.

The bar is **coherent plurnkdown** — fenced typed content, no bullet-colliding prefixes,
honesty intact — *not* merely *parseable markdown*, which today's packet passes by accident
while being a dump.

## 1. One section scheme — bare, no prefix

The H1 `# Plurnk Service` owns the namespace, so sections are bare distinct nouns. Core drops
the redundant `Plurnk Service ` prefix from its wrapper headings so they match grammar's
already-bare doc sections; the TOC becomes a real outline:

```
# Plurnk Service
## Grammar
## Delegation
## Imperatives
## Examples
## Schemes
## Policy
## Git Status
## Budget
## User Prompts
## Log
## Recap
```

Today's packet stutters — `Plurnk Service Grammar`, then bare `Delegation` / `Imperatives` /
`Examples` (grammar's doc), then `Plurnk Service Schemes` again — fracturing at the
grammar-doc / core-wrapper seam. Bare-everywhere resolves it, and the H1 keeps the namespace.

## 2. Header states the rules once; footer recaps them

- **`## Imperatives`** (header) — the rules, stated once, canonical (grammar's `plurnk.md`).
- **`## Recap`** (footer) — the same rules reminded once at the recency slot where it
  measurably matters (grammar's lean-footer probe). Renamed from `Requirements` so it reads
  as the tail of `Imperatives`, not a fresh topic.

`Recap` is **hand-editable**: the first pass may copy from `Imperatives`, but it stays a
tuning surface the owner edits per what the model actually forgets — NOT welded to
`Imperatives`. It renders in house style regardless: fenced ops, positive voice, submit-code
terms. Freedom is in what it says, not whether it's clean — `op-fence`/`op-syntax` gate the
ops either way; only terminology drift ("status" vs "submit", stale op names) is uncaught,
and a one-line glossary check covers it if wanted.

## Deferred — log-item rendering

The `## Log` body (105k+ items: header JSON + typed bodies; `-`/`+`/`*` = FOLD/OPEN/bodyless
prefixes that currently collide with markdown lists) is owner-held. The invariants above bind
whatever it becomes; the shape is not settled here.

## Next phase — section generation

How core generates each dynamic section (`Schemes`, `Policy`, `Git Status`, `Budget`,
`User Prompts`) and how each better aligns with plurnkdown — TBD.
