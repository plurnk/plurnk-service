# EPIC: cross-backend tuning under GBNF (gemma/llama.cpp × fireworks/ds4)

Captain: providers agent. Charter (user, 2026-07-02): end the fix-gemma↔break-firefast
whack-a-mole with theory, paired measurement, and record-keeping — no other agent
dragged in. This file IS the record: every finding cites its source; no tuning
change ships without a paired both-backend run recorded here.

## Constraints (user-set)

- **One `generate()` per turn.** Two-phase reason-then-constrain is OFF the table.
- **4096-token reasoning bound is a SKETCH** — derive the real R+D worst case from measurement.
- **Real artifacts only**: every epic test uses a REAL plurnk packet (adapt from
  plurnk-service `test/digest` or `~/repo/plurnk/benchmarks/**`) + the REAL
  `plurnk.gbnf` (from `@plurnk/plurnk-grammar` via the service's install). Toy
  substitutes repeatedly failed to transfer (#29 vs the 0.27.0 toy verification).
- **plurnk.gbnf is not the suspect** (user): grammar changes need a demonstrated,
  grammar-shaped divergence before grandma is approached.

## Theory (what is established, with sources)

### T1 — The grammar's shape (read from the real artifact, 0.74.49)
`root-turn ::= reasoning? preplan plan sep tail-clean`
- `reasoning ::= think-block | channel-block` — the model's NATIVE thinking
  delimiters (`<think>…</think>`, `<|channel>…<channel|>`) legalized in-band,
  unbounded inside. This is what "lazy" means here: not llama.cpp's
  `grammar_lazy`/trigger request feature, but an in-grammar production shaped to
  the model's natural emission so the active mask is near-invisible during thinking.
- `preplan` — a 35-state byte-machine permitting FREE TEXT (guarding against
  premature op-openings, grammar#47) until the literal `<<PLAN`. Also unbounded.
- So there are TWO unbounded legal free-text zones before the strict document:
  the optional think block and preplan. Every observed "never terminated" failure
  (#29 re-verify, endpoint#7, the 28k local think-block) is a model living
  legally inside one of these zones. Enforcement was conformant in every case.

### T2 — GBNF cannot bound the zones (user, confirmed empirically)
Length bounds are counting; grammars count only via O(N) automaton states.
Measured: flat `{0,16384}` silently MIS-enforces on llama.cpp (emitted `<<SEND`
where `<<PLAN` was mandatory) and fails to parse in `@plurnk/gbnf`; fireworks
handled it. Chunked encodings work everywhere but are the same degeneracy
smuggled in, and they bound chars, not tokens. **The bound cannot live in the
grammar. It lives in decode settings.**

### T3 — The knob matrix is NOT 1:1 (the whack-a-mole root)
| | gemma / llama.cpp | fireworks / ds4 pro+flash |
|---|---|---|
| reasoning switch | `chat_template_kwargs.enable_thinking` — binary, per-request | `reasoning_effort` enum; V4 promotes low/medium→high silently, 400s integers → effectively {none, adaptive, high} |
| numeric reasoning budget | none per-request (launch `--reasoning-budget` is 0/-1) | none |
| where reasoning lands | separate thought channel (template-gated) | in-band under `response_format` |
| grammar transport | top-level `grammar`; lazy/trigger REQUEST mode exists | `response_format:{type:grammar}`; whole-emission, no trigger |
| decode cap | `max_tokens` (n_predict) | `max_tokens` |

**`max_tokens` is the ONLY knob with identical semantics on both.** Instance of
the failure mode: endpoint's `BUDGET=8192` was a no-op on fireworks and broke
gemma (`enable_thinking:true` under grammar) — one knob, two semantics (endpoint#7/#8).

### T4 — The settings-vs-grammar tension (open, central)
The grammar's design EXPECTS native thinking (T1 legalizes the delimiters); our
0.27/0.28 out-of-the-box defaults turn thinking OFF (budget 0 → `enable_thinking:false`
/ `reasoning_effort:"none"`). Thinking ON → risk of unbounded in-block spirals
(28k local). Thinking OFF → the model is denied its natural channel and rambles
prose in preplan (fireworks #29 re-verify: synonym spirals, flavored by the
repeat-penalty floor forcing novel tokens). NEITHER default aligns with the
grammar's intent WITHOUT a decode cap — and per #29, the service sends no
`max_tokens` by design. **That is the systemic hole: the one universal bound is
the one nobody sets.**

### T5 — Enforcement fidelity is an AXIS, not an assumption (user, 2026-07-02)
Fireworks reportedly masks logits against a compiled automaton; llama.cpp
integrates the exact grammar automaton into sampling. The two need not agree at
token-boundary-sensitive productions (the byte-machine chains are maximally
sensitive). Measured so far: the only PROVEN infidelity is llama.cpp's at flat
`{0,16384}` (T2); fireworks has passed every exactness probe including bounded
repetition. Both engines get fidelity-verified under the REAL grammar in Phase 1;
the provider's `grammar_unenforced` gate is the backstop either way.

## Findings log

- F1 (2026-07-02, #30, endpoint agent): fireworks ds4 + grammar, reasoning
  omitted → 0/5 conformant, all max_tokens; `reasoning_effort:"none"` +
  `temperature:0.2` → 30/30, ~50–60 tok. Adopted as 0.27.0 defaults.
- F2 (2026-07-02, endpoint#7/#8): gemma + grammar + `enable_thinking:true`
  (budget 8192) → never terminates; budget 0 → 369ms/24 tok conformant (toy doc).
- F3 (2026-07-02, #29 re-verify, service): REAL grammar + 0.27.0 settings on
  flash → prose spiral in the free zones to max_tokens 2000. Toy results did not
  transfer (→ the real-artifacts rule).
- F4 (2026-07-02, this repo): flat `{0,16384}` — llama.cpp silently mis-enforces,
  `@plurnk/gbnf` won't parse, fireworks OK. Large flat bounds are hazardous.
- F5 (prior sessions, bench/): lazy-grammar trigger probes, reasoning×grammar
  sweep w/ objective grading (gemma), thinking-grammar-v2 (free roots + `<<PLAN:`
  prefill), speed-survivors. Single-backend; predates fireworks. To re-read in
  Phase 1 design.
- F6 (2026-07-03, `paired-tuning-sweep.mjs`, REAL packet001 + REAL gbnf 0.74.49,
  N=1 matrix then N=5 confirmation):
  - **fw flash `effort:none` temp0.2 cap4096: 5/5 conformant, 63–69 tok, 1.2s median.**
  - **fw pro same: 5/5, 74–83 tok, 3.9s median.** The 0.27.0 defaults + the real
    packet WORK — directly contradicting F3; the service's negative re-verify
    almost certainly did not use the real teaching packet. The packet is
    load-bearing in BOTH directions.
  - **gemma in-grammar `enable_thinking:false` temp0.2 cap4096: 4/5, 63–72 tok,
    465ms median; 1/5 rambled to cap** (legal-prefix tail risk — the free zones).
  - gemma in-grammar thinking ON: conformant but ~3.5k tok / 23s per turn
    (11k-char think block) — measured and REJECTED as default (cost).
  - gemma lazy-trigger (`grammar_lazy` + `<<PLAN` word trigger, honored on
    chat/completions on this build — the F5 limitation is gone): thinking-on
    3/5, 520–4096 tok, 16s median — high variance, two cap-outs. REJECTED.
  - fw `effort:high`: thinking lands in the legal preplan free zone; one cap-out
    at 1024. Confirms T4: thinking-on needs generous caps on every backend.
  - Cap arithmetic: every conformant turn on this packet is ≤85 tok; a 1024 cap
    bounds the ramble tail at ~6s local / trivial cost; 4096 is generous.

## Phase 2 decisions (from F6)

- **Defaults stand as shipped** (0.27.0/0.28.0): budget 0 → fw `reasoning_effort:
  "none"` / gemma `enable_thinking:false`, grammar temp default 0.2, penalty
  floor 1.15. Both backends 4–5/5 conformant on the real packet with ~70-token
  turns. No provider change needed from Phase 1.
- **The one missing setting is the SERVICE's: send `max_tokens`.** Per #29 it
  deliberately sends none; per T2/T3 the decode cap is the ONLY cross-backend
  bound and the only place the R+D budget can live.
  - **CORRECTION (user, 2026-07-03; supersedes the initial 1024 rec):** 1024 was
    calibrated on ONE small-task packet (~70-tok turns) — but legitimate
    documents (an EDIT carrying a file body, multi-op turns) run to thousands of
    tokens; a typical-turn-sized cap forces real content through a straw and
    422s legitimate work. The cap must be sized to the LARGEST legitimate
    document, not the typical turn: **window-derived** — `max_tokens =
    min(contextSize − promptTokens − safety, policy ceiling)` — generous by
    default, still finite. Its job is bounding the DEGENERATE tail, not
    budgeting the typical case.
  - **`max_tokens` allocates NOTHING between reasoning and content** — it is one
    undifferentiated pool (llama-server n_predict counts think tokens; fireworks
    counts in-band reasoning). The R/D split is controlled ONLY by the reasoning
    switches: reasoning OFF (the shipped default) ⇒ R≈0 ⇒ the whole pool is
    content. Reasoning ON shares the pool, and an over-thinking model starves
    its own document — reasoning postures therefore REQUIRE generous caps.
- **gemma's 1/5 ramble tail** is bounded-cost once capped, and the endpoint's
  existing reject→escalate/retry policy converts it to ~99% effective
  conformance. No grammar change proposed — the tail is a free-zone property,
  and per the charter the grammar isn't the suspect.

## Phase plan

- **Phase 0 — this document.** Theory + matrix + findings, consolidated. DONE
  pending review.
- **Phase 1 — paired harness.** One script, BOTH backends, same REAL packet +
  REAL plurnk.gbnf, objective grading (conformance via `@plurnk/gbnf`, terminated,
  wall-clock, completion tokens, cost). Sweep axes: thinking on/off ×
  `max_tokens` ∈ {none, R+D tiers} × temperature × (llama.cpp only) lazy/trigger
  mode vs in-grammar. Output: the measured R+D worst case and per-backend
  fidelity verdicts (T5).
- **Phase 2 — defaults from the matrix.** Encode per-backend out-of-the-box
  settings in the provider specs, each line citing a Findings row. Standing rule:
  no tuning change without a paired run appended here.

## Open questions

- O1: what does gemma-4 do at budget 0 when the grammar legalizes `<think>`
  but the template says don't think — does it ever open the block? (Phase 1.)
- O2 (T5): fireworks mask fidelity under the real byte-machines. (Phase 1.)
- O3: does llama.cpp's lazy/trigger REQUEST mode outperform the in-grammar
  prefix on gemma — and is there ANY fireworks analog? (Phase 1; F5 prior art.)
- O4: where should the service's `max_tokens` (R+D) live — per-alias env, or a
  provider default when a grammar is attached? (Decide from Phase 1 data;
  provider-side default would be a SPEC conversation.)
