### Plurnkdown — the packet house-style lane

`plurnk-plurnkdown` owns `@plurnk/plurnk-plurnkdown`: the **plurnkdown house style** — the format every packet the daemon sends the model is built to — plus the **linter** that measures conformance. It is a bundled core workspace (ships in the default install). The canonical family doctrine is `../AGENTS.md` and binds here; this file holds only what is **specific to the plurnkdown lane**. The standard itself is `PACKET.md` (committed, agent-facing). This file is the lane's grounding and the traps worth not re-hitting.

This file is **committed** on purpose. Durable lane doctrine lives in a tracked file, never in gitignored substrate — a filter-repo import wipes the untracked ones, and a dogfooding plurnk instance only inherits what a fresh clone carries.

#### Stance: the packet is the training surface

Plurnkdown is not a plugin the daemon loads — it is the SHAPE of what the daemon emits. Every constructed packet is meta-documentation: the model marinates in the format and imitates it. So the lane's job is two-sided. Make the packets core *constructs* clean plurnkdown (deterministic, enforceable). Demonstrate-and-steer the model's *own* emissions toward it (stochastic, never hard-enforced on the way in).

**The cardinal conviction — the WHY.** LLM inference is glue, not foundation: build WITH it, never ON it. Plurnkdown's move is to freeze stochastic model output into deterministic, checkable artifacts. A packet is a rendered VIEW; the linter is the deterministic instrument that grades it. We do not eliminate the deterministic/stochastic boundary — we RELOCATE it. The model emits; the artifact is checked. Constructed packets sit on the deterministic side, so we enforce them. Model emissions sit on the stochastic side, so we demonstrate the target and steer, never reject at the door.

#### What plurnkdown is

- **Valid GFM by construction, constrained further by written rule.** Every plurnkdown document is CommonMark/GFM — ATX headings, bullets, GFM tables, fenced code with info strings, nothing outside the spec. Each constraint beyond GFM is a written rule in `PACKET.md` AND a linter rule. No linter rule exists without a written rule; no house constraint exists without a linter rule.
- **A LINTER — the "secret third thing."** Static analysis, not generation. It is NOT GBNF (the generative sampler constraint, grammar's) and NOT ANTLR (the AST/compile path, grammar's). Tooling is `marked` (in-tree), not remark/unified.
- **Three regions, three content-types, one envelope:**
  - **doc** (system message) — the static doctrine: grammar, the Schemes catalog (```plurnk fenced ops), Policy. Plurnkdown prose plus fenced typed content.
  - **SEND body** (the model's user-facing channel) — plurnkdown plus **mermaid**. Mermaid is on by default (owner ruling #440) and is a training exemplar for how the model should communicate visually. Never frame it as token-waste or as default-off.
  - **log** (user message, per-turn) — **stays JSON**, in a ```jsonplurnk fence (grammar-owned, #437). Never mermaidify or prose-ify the log. The razor: JSON-as-data is in the model's training distribution and hands us queryable, weighable, honest structure for free; mermaid-as-data is not, and swimming against training buys nothing. The log is a data plane, not a diagram.

#### The ambition — house style now, conformance filter eventually

The magnum opus is a valid-markdown conformance filter every outbound packet passes. Today it splits by which side of the boundary a packet sits on. **Constructed packets (core, deterministic) → enforce**: core builds them, so a deviation is a bug to fix. **Model emissions (stochastic) → demonstrate-and-steer**: show the target through packet references and error entries; never bounce a turn at the door for style.

There is **no character cap on prose** — atomicity is the lever, not length. The linter measures run-on and semicolon-weld, never raw length. **Gherkin** is a model-steering register (demonstrate structured directives over casual prose), never a wired conformance feature.

#### The linter (`src/Plurnkdown.ts`)

Three rules, each backed by a written `PACKET.md` rule:

- `op-fence` (error) — a bare `<<` Plurnk op in prose belongs in a ```plurnk fence.
- `op-syntax` (error/warning) — ops inside a ```plurnk fence parse statement-level via `@plurnk/plurnk-grammar`'s `PlurnkParser`. Delegated — plurnkdown never re-implements op parsing.
- `run-on` (warning) — a sentence ≥180 chars, or ≥120 chars with a semicolon weld, measured per line. Keep prose atomic: split, don't weld. Soft warning, a human-review heuristic, not a gate.

The jsonplurnk log fence and mermaid fences are code tokens of other languages; the linter leaves them alone by construction.

#### Lane conventions

- **Positive steers.** Model-steering content (imperatives, directives, Gherkin) describes the GOOD behavior; flip negatives to positives. Leave factual "is not a turn" distinctions alone.
- **Messages state the fact or the law, never a how-to.** A steer or error names the missing structure or the rule. Tutorials live in the taught docs and the packet, never in the message (root doctrine: errors point at shape, not content menus).
- **State current truth.** Docs and this file say what IS — no "was X, now Y", no retired-tombstones, no version-trophy citations. History lives in git.
- **Ownership boundaries — own the standard, route the findings.** Plurnkdown owns `PACKET.md` and the linter. GRAMMAR owns `plurnk.md` (the canon the doc region renders) and `jsonplurnk` (the log format, #437) — a deviation found in either ROUTES to grammar, never a plurnkdown edit. A packet-construction deviation ROUTES to core. The lane's DIVERGENCES register (GFM converged-plus, mermaid-beta, jsonplurnk) lives in `PACKET.md § Divergences`.

#### The evaluation capability — measure real packets, not synthetic tests

The linter's real value is against emitted packets, not fixtures. `plurnk-core/bin/digest.ts <run.db> <dir>` writes `packetNNN.system.md` + `packetNNN.user.md` per turn, byte-identical to what the model saw — Engine and digest both render through one `PacketWire`, so there is no drift. Lint those to find where core's construction deviates from clean plurnkdown. Read the flagged content before filing: a fenced-op placeholder like `mcp://<server>/` is a real deviation (an unparseable URI in a catalog that must validate), while a hit in the user prompt may be the benchmark author's prose, not core's. This is the packet-analysis discipline — a green linter proves no-regression; reading the rendered packet is the real gate.

#### Mechanics (lane quick-reference; `../AGENTS.md` is authoritative)

- **Source resolves via `--conditions=plurnk-dev` only.** Plain `node`/`tsc` hits an unbuilt `dist/` and throws — that is NOT a broken install. Every run carries the condition (baked into package scripts).
- **Per-worktree `npm install`.** A fresh worktree needs its own install. A stale worktree lags the lockstep version and false-reds `npm outdated`.
- **Push flow.** Work in `~/repo/plurnk/worktrees/plurnkdown` on branch `lane/plurnkdown`; land via `git push origin lane/plurnkdown:main` (fetch-rebase first). The pre-push drill gates main; a scoped change runs intg for this workspace only. Use a `feat/*` branch for a preview push that renders on GitHub without landing.
- **Publish gate.** `prepublishOnly` = `npm outdated && npm audit --audit-level=moderate && npm test`.
- **Commits + issues (root doctrine).** One-line conventional subject ≤80 chars, no body, no trailers, `--author="Claude <noreply@anthropic.com>"`, `(#N)` reference (`#0` if none). Every issue and comment opens **"Plurnkdown agent here —"** — the only author signal, since all issues file under one account.
