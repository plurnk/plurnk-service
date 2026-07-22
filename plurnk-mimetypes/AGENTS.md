# Mimetypes lane — agent context

Layers under the monorepo-root `AGENTS.md` (family model, commits, `.env.defaults`, fail-fast/forward, freshness-as-release-gate, "read the wire" — all inherited, not repeated here). This file is the mimetypes lane's own surface: what it is, how to work it, and the misalignments we already paid for so a fresh agent doesn't re-buy them.

## What the lane is

- **The head** `@plurnk/plurnk-mimetypes` owns the *contract*: the duck-typed handler surface, channel selection (§5), the query dialects (§11), channel architecture (§12), and the classification / embedder / tokenizer authorities (§20/§17/§19). **`SPEC.md` is authoritative** — §1–22, and a drifting spec is a bug, not a nicety (#444). `spec:check` enforces that every section is test-cited or declared `<!-- coverage: policy -->`.
- **In-lane workspaces** (~14): the framework + `application-*` / `text-*` floor handlers + `embeddings` + `tokenizers`. These are lockstep monorepo members.
- **Outside leaves**: 28 `plurnk-mimetypes-grammar-*` + ~24 community `text-*` + gguf/safetensors. Independent repos, `peer "^1"` on the head, **instructed via issues on their own repos** — never edited from here. They are family-operated but not workspaces.
- **Division:** the head owns the algebra (which content is line- vs tree-navigable, how a dialect dispatches, what a channel means); a **handler owns its per-mimetype material** only. Cross-cutting behavior lives at the head, never copied into a handler.

## Working the lane

- Dev runs TS **source** (`--conditions=plurnk-dev`, no build in the inner loop); `tsc → dist` only at `prepack`. Cross-package imports resolve source-first via the `plurnk-dev` export condition — a leaf that installs the *published* head gets `dist/`, so never assume a leaf sees `src/`.
- **Gates (all under `npm test`):** `test:lint` (tsc) · `spec:check` · `test:unit` · `test:conf` (the `queryLines` + refs **conformance harness** — the ecosystem-wide regression net, exported at `@plurnk/plurnk-mimetypes/conformance` so external leaves certify against the *same* invariants) · `test:intg`. Conformance is the layer that catches "my green suite lied" — respect it.
- **Parser backends are tiered (§9), quality over coverage:** tree-sitter registry → per-grammar WASM package → `antlr4ng` (grammars-v4) → hand-rolled. A language *defers* rather than ship a half-grammar with README caveats.
- **One engine per dialect, never a second:** jsonpath = **RFC 9535** (`json-p3`, grammar-closed, no eval sandbox — #490); xpath = XPath 1.0 (`xpath` pkg); glob = the body-matcher dialect's `globToRegex` (§11.3 / §22). Reuse the existing engine; grep before writing a matcher.
- Every operator knob ships in the package's own `.env.defaults` (embed workers, pdf caps, `NO_EMBED`); optional caps default **unbounded** (the library invents no budget it can't validate as intent).

## Hard-won lessons — the misalignments, with receipts

These are lane-specific traps that cost real rework. Each is a rule *plus* the scar that earned it.

1. **Verify in-session; never claim ready/green/fresh from memory.** Every "ready", "current", "passes" is a claim you must have *just run*. `npm outdated` / `deps:check` / the suite, this session — the cost is seconds; the cost of a stale "ready" is a torn publish. (Corrected repeatedly.)

2. **Default forward, validated.** While solo-dark, **staleness is the expensive failure, not breakage** — breakage is loud, local, cheap signal; staleness is silent rot that surfaces at deploy. Roll upstream same-touch (a grammar minor, a dep major → bump + let the suite veto); a freshness sweep is *step zero* of any staging. A HOLD needs a **reproduced breakage + an issue**, never a vibe. (Nine grammar dumps + a TS7 major + `@cucumber/gherkin` 42 absorbed as non-events this way — #541.)

3. **Prove against the real consumer, not your own green suite.** A passing head suite is *not* proof the thing works. #490 shipped "full suite green, zero changes" and hid a fleet-wide jsonpath recursion regression (#523) that only surfaced when a real leaf **installed the published head and ran its own conformance** (json-p3's default 50-node recursion cap vs. a 348-node parse tree). After any head change, spot-verify a *sample of leaves install-and-pass against the published artifact* — not against your worktree.

4. **Eliminate ambiguity at the source; never downstream detect-and-strip.** A matcher/stripper over ambiguous input *structurally* corrupts legitimate look-alikes — it can't tell signal from real content that matches. #564: a `^\d+:\t` edit-strip would swallow genuine tabs in Makefiles/TSV/diff headers. #47: a minified-content line-length heuristic would exclude large-record JSONL / wide CSV from search. The fix removes the marker where it's *created* (stop emitting it) or makes the call **operator config** (`NO_EMBED` patterns) — never a pattern-match that treats signal and content identically. "Robust" = no ambiguity to misjudge, not "a matcher that usually wins."

5. **Read your *own* wire, not just the model's.** Twice I diagnosed off a reproduction I had contaminated: my own `--conditions=plurnk-dev` manufactured an `ERR_MODULE_NOT_FOUND` I chased as a bug (#523), and I ran with a premise ("embedBatch is single-core") a 30-second benchmark disproved (#420). Confirm the reproduction is real and unaltered by your own flags/assumptions *before* classifying. (The root's "read the wire body, not the config" — turned on yourself.)

6. **The contract is the head's and the grammar's; consumer asks flow to the supplier.** A body-matcher/classification behavior a consumer wants is *stated as a deliverable*, negotiated on an issue — never redesigned unilaterally or worked around in the consumer. jsonpath became RFC 9535 by owner ruling routed through the standards audit (#490/#494), not by a quiet swap. A grammar/protocol shape change is argued, never slipped in.

## Fastpath

Read `SPEC.md` first (it *is* the contract). To touch a dialect, find its engine (`src/query.ts`) — don't add a second. To touch classification, `src/classify.ts` + §20. To touch a seam, `src/Embeddings.ts` / `src/Tokenizers.ts` + §17/§19. Every issue/comment opens by naming the lane ("Mimetypes agent here."). Never `--no-verify` a push — the root pre-push gate *is* the CI.
