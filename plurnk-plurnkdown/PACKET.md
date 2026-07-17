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

## Prose — atomic sentences

Prose is short and single-idea. Avoid long multi-compound run-ons — a semicolon welding two
independent clauses, or a ~200+ char sentence — because the floor model parses atomic units
better than dense compounds. **Split, don't weld.** The linter soft-*warns* on the two shapes
(a `>= 180`-char sentence, or a `>= 120`-char semicolon-weld); it's a heuristic for review, not
a hard gate — a long single-clause list can be fine.

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

## 3. Section forms

Each section's clean-plurnkdown target. The *content* is core's (the owner's, for `Policy`);
the *shape* is the contract. How core generates it is core's own — this specifies output only.

### Schemes — reference op examples
Today a bullet list of bare ops (`* <<READ(log:///…)::READ` …) demonstrating each scheme
(`log:///`, `known:///`, `unknown:///`, `worker://`, `https://`). Target: a ```plurnk fenced
catalog — validatable by the same fence-gate as the doc, not bullets.

### Policy — persona / config
Today loose `You …` / `Your X:` paragraphs. Target: a bulleted list; the labeled `Your X:`
directives become bold-label bullets (`- **Knowledgebase:** …`). **Content and framing
untouched** — this is hand-tuned config, and its negatives ("you never apologize") are
character boundaries, not turn-mechanic failure modes, so the positive-flip does not apply.
plurnkdown owns the shape, not the wording.

### Git Status — live state
Already clean: `` branch `master` — 0 staged, 2 unstaged, 1 untracked ``. Keep; drop the prefix.

### Budget — live state, visualized
The ceiling/usage/free line, plus **dynamic mermaid** — validated to render on GitHub (demo:
`demo/budget-mermaid.md`), all **budget-scaled** (the ceiling is the reference, not the items),
so salience tracks pressure: calm with headroom, urgent near the ceiling.

- **Turn composition → treemap** — turn boxes + `free` compose the ceiling; fills as usage climbs.
- **Heaviest items → xychart** — ranked bars against the full ceiling; the space above is headroom.
- **Gauge → pie** — used vs free; a visual exemplar for the model's own user-facing SENDs as much as a meter.

The token numbers stay available (weighability) — the diagrams are a visual layer over the
data, not a replacement. This is an enrichment to implement and **measure**: it costs packet
tokens on the weak model it's meant to help, so it earns in on a behavior delta, not on looks.

### User Prompts — live input
The incoming prompts / environment updates. Render faithful, as clean prose or a light list.

### Log — black box (owner-held)
Not specced here. The invariants above bind whatever it becomes.

**Net:** only `Schemes` (fence the ops) and `Policy` (bulletize) change shape; the rest is
drop-the-prefix. The core-facing ask stays small.

## Divergences (#492, doctrine #408)

The lane register: every plurnkdown deviation from its governing standard carries a written
exception or converges. Ecosystem-wide rows live in `plurnk-meta/DIVERGENCES.md`.

| # | Practice | Industry standard | Plurnkdown position | Ruling |
|---|---|---|---|---|
| 1 | Markdown flavor | CommonMark/GFM | Strict GFM subset + written house constraints (fenced ops, bare H2 scheme, Recap footer, atomic sentences) | **CONVERGED-plus** — every plurnkdown document is valid GFM by construction (ATX headings, bullets, GFM tables, fenced code with info strings). Each constraint beyond GFM is a written rule in this file, enforced by the linter (`op-fence` / `op-syntax` / `run-on`). No linter rule exists without a written rule here. |
| 2 | Mermaid chart types | Stable core diagram types; beta types churn | Budget emits `treemap-beta` + `xychart-beta`; the canon doc uses stable `stateDiagram-v2` / `sequenceDiagram` / `pie` | **EXCEPTION + CONVERGENCE SCHEDULED** (#440, owner-ruled on-by-default) — budget-scaled salience visuals, GitHub-render-validated. Converge when mermaid graduates them: drop `-beta`, re-verify syntax. |
| 3 | Log fence name | NDJSON, or a pure JSON array in a ` ```json ` fence (multi-line bodies as escaped strings) | ` ```jsonplurnk `: a JSON array where an `open` entry's `body` is a verbatim HEREDOC — the one non-JSON value | **EXCEPTION — grammar-owned (#437)** — JSON-escaping bodies would destroy char-perfect semantics (`N:	` line addressing, EDIT literality). The custom fence name honestly signals "not parseable as pure JSON"; a ` ```json ` label would lie to parsers. Corpus-checked (grammar strip-parser, 184 entries). |

Retired plurnkisms hold no residue: Gherkin (#435) and the 280-char prose cap are gone from
the package surface and the linter alike (#492).
