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
| numeric reasoning budget | **YES at LAUNCH: `--reasoning-budget N` (N>0 token budget)** — verified on the live binary, and the local box already runs 4096. Per-request: IGNORED (probed: `reasoning_budget` 64/0 and kwargs variants all no-ops) | none (integer effort → 400, F1) |
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
- O5: forced `</think>` closure at EXACTLY the launch budget under an active
  in-grammar constraint — untested (F6's thinking run closed naturally at 3.3k
  < 4096). Verify the clamp remains grammar-legal at the boundary.
- O6: quality-graded paired run (hard benchmark packet): pro `none` vs
  `adaptive`, gemma thinking-off vs thinking-on-with-launch-budget — decides
  the differentiated per-model posture on task success, not just conformance.

## F7 — llama.cpp numeric reasoning budget (2026-07-03; user-instigated, stale memory corrected)

- `--reasoning-budget N` (N>0 = token budget for thinking) EXISTS on the current
  build; prior session memory claimed 0/-1 only — wrong. The local box already
  launches with `--reasoning-budget 4096 --reasoning-format deepseek`, and F6's
  thinking-on run (3.3k reasoning tokens < 4096) confirms the clamp environment.
- Per-request budget fields are IGNORED (probed live: `reasoning_budget: 64`,
  `: 0`, and `chat_template_kwargs.thinking_budget` — all no-ops). So per-turn
  the provider can only toggle thinking; the NUMERIC clamp is box launch config.
- **Consequence: gemma's R/D balance IS controllable** — the user's original
  design posture (bounded reasoning before the plan) is realizable TODAY on
  llama.cpp as: `enable_thinking:true` + launch `--reasoning-budget 4096` +
  window-derived `max_tokens ≥ 4096 + D_max`. Content cannot be crowded out
  (R clamped server-side) and reasoning isn't crammed into content.
- Fireworks has NO numeric equivalent (enum only, integers 400) — the asymmetry
  is fireworks' API limitation. Their nearest posture is `adaptive` + the cap.
- Operational: any OTHER llama.cpp box serving plurnk (e.g. the endpoint's
  gemma at possumtech) needs the same launch flags — the 28k think-block
  incident is consistent with a box missing `--reasoning-budget`.

## F8 — the launch-flag posture, verified end-to-end (2026-07-03)

Question (user): can the whole gemma posture live server-side — thinking on,
reasoning budget 4096, output cap 8192?

- **Flags exist for all three**: `-rea on --reasoning-budget 4096 -n 8192`.
- **`-n` is a DEFAULT, not a clamp** (source-verified, server-task.cpp:267): a
  request that sends `max_tokens` overrides it uncapped on this build. Since the
  service currently sends none, the launch default IS the missing backstop; but
  it is not defense against a caller-sent larger value.
- **Per-request `enable_thinking` overrides `-rea on`** — our provider sends
  false at budget 0. To run the thinking posture through the provider, the env
  budget must be non-zero (template style then emits true; the NUMERIC clamp
  stays the box's launch flag, F7).
- **Measured on the live box** (real packet + real gbnf, thinking on, cap 8192,
  N=3): 2/3 conformant (1.9–3.1k chars reasoning, ~150–190c content, 4–6.5s);
  1/3 rambled — reasoning clamp HELD (7.5k chars ≈ 2.2k tok < 4096 budget) but
  the CONTENT/preplan free zone ran to the 8192 cap (44.6s, bounded, incomplete).
  The ramble tail is content-side, survives thinking-on, and remains the
  escalate/retry policy's job. O5 (forced closure exactly at the clamp under
  grammar) still unhit — both clean runs closed naturally.
- Fireworks remains request-side only: no launch config exists — the service's
  window-derived `max_tokens` is mandatory there regardless.

## F9 — reasoning AND rails coexist on fireworks; the #32 clamp is lifted (2026-07-06; user-instigated — "the grammar is DESIGNED to allow reasoning")
The survival question ("does any cloud endpoint deliver reasoning + rails?") answered YES, decisively, on the wire (bench/fireworks-reasoning-rails-matrix.mjs; real packet001 + real plurnk.gbnf 32,337c; verdicts via @plurnk/gbnf `validateGbnf`, status-discriminated).
- **Enforcement is real, not model politeness**: adversarial canary `root ::= "ZQXJ-CANARY-7"` under `response_format:{type:grammar}` → content EXACTLY `ZQXJ-CANARY-7`. The mask is live.
- **The mask covers ONLY the content channel**: deepseek-v4-flash, `reasoning_effort:"low"` + grammar → `reasoning_content` populated with free CoT (966c/859c, two runs) AND content ACCEPT (textbook 4-op turn, terminal SEND). `high` + grammar: ACCEPT twice (reasoning native-channel or in-band). Reasoning and rails, one call.
- **The grammar's design intent works**: deepseek-v4-pro (fireslow), `low` + grammar → reasoning flowed IN-BAND into the preplan free region ("We need to respond according to the system instructions…") then conformant ops → ACCEPT at 3,795c. `reasoning?`/preplan absorb spillover exactly as designed.
- **Envelope, not structure**: pro at `high` + grammar overran max_tokens 4096 (17k chars across channels, finish=length, INCOMPLETE). High-effort reasoners need cap headroom; low/adaptive conform within 4k. The old #32 measurements (low→cycles, high→spirals) were pre-cap artifacts.
- **Root cause of service#331 confirmed**: the #32 clamp (reasoning_effort→"none" under response_format) removed planning from every constrained fireworks turn. Clamp LIFTED in 0.36.0 — intent maps identically with or without grammar.
- **xai is decisively NO rails** (owner call, wire-confirmed): `response_format:{type:grammar}` → 422 "unknown variant `grammar`, expected `text`/`json_object`/`json_schema`"; top-level llama.cpp-style `grammar` field → 200 but IGNORED (canary not honored; output was packet-taught DSL, not the forced string). Dark rails — never transport grammar to xai.
- Together/DeepInfra previously verified dropping guided_grammar. **Cloud reasoning+rails = fireworks. Local = llama-server.** Those are the both-worlds backends.
- **Reliability, honestly**: across 13 grammar-transported fireworks calls today, 11 conformant, 1 cap-overrun (INCOMPLETE — mask held, decode outran max_tokens), and **1 genuine enforcement drop** (identical wire body to 3 consecutive ACCEPTs; reject@880 mid-emission, prose under a "live" mask). Fireworks masking is ~92% reliable in this sample, NOT absolute — the provider's `grammar_unenforced` observation catches exactly this, and discard/retry is the consumer's policy (SPEC §13). Rails on fireworks = enforced-with-verification, not enforced-by-faith.

## F9-corr — the reasoning CHANNEL under grammar is effort-dependent, not reliably native (2026-07-07; providers#41)
F9 said "reasoning rides reasoning_content beside the rails." Refined by the #41 localization matrix (flash & pro, grammar on/off, effort low/high, streamed/not):
- **response_format grammar DEMOTES the CoT into `content`** (the grammar's `reasoning?`/preplan free zone absorbs it), NOT the model. Without a grammar, `reasoning_content` populates fine even at high effort.
- **Effort modulates it**: high → demotes near-certainly (flash & pro both 0c reasoning_content, prose in content); low → stochastic (clean 2×, bled 1× in-sample).
- **Streamed is worse**: mislabels the constrained OUTPUT into reasoning_content (content empty) — the standing reason grammar turns are non-streamed (:377).
- Conformance is UNAFFECTED (preplan legally holds the prose); the cost is channel reliability — `assistant.reasoning` is empty when the CoT lands in content. The robust consumer fix is to source the reasoning mirror from the PARSED preplan region of content, not from the native channel (which fireworks doesn't reliably populate under the mask). Provider unchanged (can't split preplan-reasoning without parsing DSL, §8).
