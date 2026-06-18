# plurnk-providers — Specification

Contract for `@plurnk/plurnk-providers-*` sibling packages. Audience: implementer of an LLM transport. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §2).

## §1 Manifest

Each provider package's `package.json`:

```json
{
    "name": "@plurnk/plurnk-providers-<name>",
    "plurnk": { "kind": "provider", "name": "<name>" }
}
```

- `kind` MUST be `"provider"`.
- `name` is a vendor identifier (`openai`, `anthropic`, `ollama`).

Collision on `(kind: "provider", name)` at discovery: fail-hard.

## §2 Provider interface

```ts
interface Provider {
    // Identity (immutable across lifetime)
    readonly contextSize: number | null;  // context tokens, null if unresolved.
                                          // PER SLOT under llama-server --parallel N
                                          // (the server splits --ctx-size and reports
                                          // the divided value; verified live).
    readonly model: string;                // configured model id

    // Tokenomic primitives (synchronous, pure)
    countTokens(text: string): number;
    costFor(usage: ProviderUsage): number;  // pico-USD (1e-12 USD)

    // Transport. `runId` is REQUIRED: the opaque, stable identity of the
    // consumer's work stream — providers may key backend affinity on it and
    // never interpret it. `grammar` is an optional GBNF string for
    // grammar-constrained sampling (§13) — attached verbatim by capable
    // backends, ignored by all others. `maxTokens` is the consumer's per-call
    // output ceiling (wire `max_tokens`); absent means the server default,
    // which is typically UNBOUNDED.
    generate(args: { messages: ChatMessage[]; runId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number }): Promise<ProviderResponse>;
}

interface ProviderResponse {
    assistant: {
        content: string;            // raw model emission; consumer parses
        reasoning: string | null;   // wire-reported CoT; null if absent
        usage: ProviderUsage;       // { prompt, completion, reasoning, cached, total }
        finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
        model: string;              // wire-reported (may differ from requested for relay providers)
    };
    assistantRaw: unknown;          // verbatim wire response for forensics
}

interface ProviderUsage {
    prompt: number;       // input tokens (cached ones included)
    completion: number;   // visible output tokens, EXCLUDING reasoning
    reasoning: number;    // reasoning/thinking tokens, billed as output
    cached: number;       // subset of prompt served from cache
    total: number;        // prompt + completion + reasoning
}
```

Usage invariant: `total = prompt + completion + reasoning`; `cached ⊆ prompt`; `completion` excludes reasoning; **billable output = `completion + reasoning`**. Providers report reasoning two ways — inside `completion_tokens` (OpenAI, via `completion_tokens_details.reasoning_tokens`) or only as the `total − prompt − completion` gap (Gemini). The framework's `normalizeUsage` (§11) collapses both to this invariant, so siblings on `OpenAICompatProvider` get it for free.

### Promises

- `assistant.content` is the **verbatim** model emission. Consumer parses via `@plurnk/plurnk-grammar` — providers MUST NOT parse. plurnk uses a **tools-in-body** design: tool invocations are expressed as plurnk DSL *inside the message content*, never via a provider's native tool-calling API, so `content` is always raw text and providers never request, parse, or translate native tool calls.[^tools]

[^tools]: A provider that wants to drive native tool-calling (OpenAI `tool_calls`, Anthropic `tool_use`) would have to normalize those emissions back into a plurnk DSL string at the boundary. No provider does this and it is out of scope for v0 — tools-in-body sidesteps the whole problem. The clause is recorded only so a future native-tools mode has a defined contract.
- `assistant.usage` is authoritative and follows the invariant above. Fill `0`s when the wire response omits a breakdown.
- `countTokens` is **synchronous**, returns a non-negative integer, deterministic for the same input.
- `costFor` is **pure**, returns pico-USD non-negative integer. Returns `0` for siblings with no known rates (local Ollama, generic OpenAI-compat shims).
- `contextSize` resolves to `null` when provider can't determine the model's context window. Consumer treats null as "no budget info available."
- `generate` rejects on signal abort — does NOT resolve with partial content.
- `generate` transports `grammar` verbatim when the backend supports grammar-constrained sampling, and silently ignores it otherwise (§13). The provider never chooses or modifies the grammar.
- **Backend affinity is the provider's internal guarantee, keyed by `runId`.** The consumer says *which run this is*, never *which backend resource serves it* — raw resource identifiers (slot integers, connections) never cross the contract in either direction. On slot-pinning backends (llama-server `--parallel N>1`), the provider keeps each run sticky to one slot and spreads distinct runs across slots, so each concurrent run keeps its KV-cache prefix warm (un-pinned routing is the server's similarity heuristic — slot hops re-pay full prefills). Backends without affinity semantics ignore `runId` entirely.

## §3 `fromEnv(env, model)` factory

Default export MUST have a static `fromEnv(env, model)` factory:

```ts
class OpenAI {
    static fromEnv(env: NodeJS.ProcessEnv, model: string): OpenAI | Promise<OpenAI> {
        // Read provider-specific env (OPENAI_BASE_URL, OPENAI_API_KEY, ...)
        // plus universal operator knobs (PLURNK_PROVIDERS_REASONING_BUDGET, PLURNK_FETCH_TIMEOUT,
        // PLURNK_PROVIDER_CONTEXT_SIZE).
        return new OpenAI({ /* ... */ });
    }
    constructor(config: OpenAIConfig) { /* ... */ }
}
```

The consumer's instantiation path calls `mod.default.fromEnv(env, alias.model)` generically (§5).

`fromEnv` MAY be sync or async; return type `Provider | Promise<Provider>`. (Why a factory, where execs/mimes use a base class + constructor injection and schemes a `static manifest`: a provider often **async-probes** at construction — model catalog, context window, slot count — which a constructor can't express. The factory is the seam for that probe.)

`fromEnv` MUST fail fast with a clear error if required env is missing — name the env var the operator needs to set.

## §4 Universal operator knobs

Each provider's `fromEnv` reads these:

- **`PLURNK_PROVIDERS_REASONING_BUDGET`** — REQUIRED integer `>= -1`. One knob carries the whole side-channel-reasoning space: **`0`** off, **`-1`** on/adaptive (no cap — model/backend decides depth), **`N>0`** on/capped at `N`. The provider maps this single intent to the active backend's mechanism — llama-server `chat_template_kwargs: { enable_thinking }` (always emitted; the explicit FALSE is the only working off-switch — llama-server ignores `think` and per-request budgets, and its `--reasoning-budget` default otherwise keeps the channel live, fatal under an active grammar, §13), Ollama `think`, relay `include_reasoning`, cloud `reasoning_effort` (tier from `N`; adaptive `-1` omits the field, letting the API pick its depth), Anthropic `thinking: { type: "adaptive" }` (`-1`) / `budget_tokens` (`N`). For native backends the magnitude is irrelevant — only zero vs non-zero matters. Consumers state intent, never mechanism. (There is deliberately **no** knob for in-DSL `<<PLAN>>` reasoning — PLAN is forced by the grammar itself, the `plurnk-plan.gbnf` variant whose root opens with `<<PLAN:`, plus a consumer prompt line; it has no provider footprint. The former `PLURNK_PLAN` assistant-prefill was removed in 0.4.0 — it broke under grammar-constrained generation, stacking malformed plans, since the prefill is prompt text the grammar never sees. Plan-forcing now lives entirely in the grammar (`plurnk-plan.gbnf`) and the service prompt, #16.)

Read via `reasoningBudgetFromEnv` and **fail hard when unset** — configuration lives in the operator's env (the consumer's `.env.example` declares every var); the framework never defaults a knob in code.
- **`PLURNK_FETCH_TIMEOUT`** — service-wide ms ceiling on any single outbound request (**per attempt**, not shared across retries). Each `fromEnv` reads and passes as `AbortSignal.timeout`. Per-provider override envs are NOT part of the contract.
- **`PLURNK_PROVIDER_RETRY_ATTEMPTS`** — REQUIRED non-negative integer (read via `parseRequiredInt`). The transient-failure retry budget: **`0`** surfaces the first failure; **`N`** retries up to `N` times on a *transient* classification only (`rate_limit` / `network_failure` — 429, 5xx, timeout, connection reset). Terminal kinds (`unauthorized`, `quota_exceeded`, `invalid_response`, `model_refused`) are never retried. Backoff is exponential from a `2000ms` base (`base * 2^(attempt-1)`), unless the server sent a `Retry-After` (which wins). The caller's `signal` aborts both the in-flight request and the backoff sleep. Lives in the shared `OpenAICompatProvider` so every provider inherits it uniformly; rides on the existing `classifyProviderError` (#18).
- **`PLURNK_PROVIDER_CONTEXT_SIZE`** — optional positive-integer override for the model's reported context window. Resolution: this env var → provider probe/config/table → `null`.

## §5 Alias cascade resolution

`PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an alias; `PLURNK_MODEL=<alias>` selects which is active.

```
PLURNK_MODEL_gemma=openai/macher.gguf
PLURNK_MODEL_opus=openrouter/anthropic/claude-opus-latest
PLURNK_MODEL=gemma
```

First path segment names the provider; rest is the model identifier (may contain `/` for tri-level providers like openrouter's `publisher/model`).

This package's exported resolution surface:

- `parseAliasesFromEnv(env)` — extracts alias entries.
- `resolveActiveAlias(env)` — `{ alias, provider, model } | null`.
- `instantiateProvider(name, env, model)` — full two-tier resolution (below).
- `loadActiveProvider(env)` — boot convenience: active alias → `instantiateProvider`.
- `standardProviderFromEnv(name, env, model)` / `isStandardProvider(name)` — the tier-1 internals, still exported.
- `discover({ cwd?, packageDirs?, env? })` — the tier-2 scan: a `Discovery` (`{ registry, skipped }`, each a `Map<name, packageSpecifier>`) of every installed provider package, partitioned by the trust gate. Exported so a consumer can enumerate trusted providers — and see which were declined — without instantiating them.

**Two-tier provider resolution — owned entirely by this package.** A provider name resolves in this order:

1. **Standard provider** (`§11`) — if `isStandardProvider(name)`, instantiated directly via `standardProviderFromEnv(name, env, model)`. No package is imported. Covers every plain OpenAI-compatible endpoint (`openai`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `deepinfra`, `anthropic`, `bedrock`, `plurnk`, …) — including first-party Claude (Anthropic's compat endpoint, bearer auth, the `thinking` reasoning param), AWS Bedrock (its compat endpoint, Bedrock-API-key bearer, region-templated `BEDROCK_BASE_URL`), and the **`plurnk` hosted model** (a llama.cpp endpoint hardcoded to `model.plurnk.ai`, overridable via `PLURNK_BASE_URL`); none needs a daughter. An entry may carry a custom `headersFromEnv` builder for auth the single-var bearer can't express — `plurnk` uses it for optional two-credential auth (`PLURNK_KEY` bearer + the OpenAI-org-style `Plurnk-Account` routing header, both optional → blank is a first-class **anonymous** request and the server decides what it returns — the policy is server-side, not encoded here). A present-but-rejected credential `401`s → `unauthorized` (terminal); there is no silent downgrade to anonymous. The standard table is **authoritative**: a scanned package whose name duplicates a standard one is shadowed (tier 1 returns first).
2. **Discovered package** — otherwise, a **scope-agnostic `node_modules` scan** (`discover()`) maps the provider name to the installed package that declares `plurnk: { kind: "provider", name }`, which is dynamic-imported and `fromEnv(env, model)`-called. Covers first-party daughters with real runtime surface (`openrouter`, `ollama`, `google`, `xai`, `cloudflare`, the planned `vertex`/`cohere`) **and any third-party provider published under its own scope** (`@acme/llm-provider-foo`) — no involvement from us, no `@plurnk` scope assumption. Two installed packages claiming the same name → fail-hard naming both. Unknown name → fail-hard. The scan runs once per process and is memoized.

   Discovery honors the host **trust gate** `PLURNK_PLUGINS_TRUSTED_ONLY` — the same env var the execs/mimes/schemes families read (plurnk-service#229, #15). OFF (unset/empty/`0`) trusts every installed provider; ON (any value) trusts `@plurnk/*` plus a comma-separated allowlist and declines the rest. A declined package is recorded in `skipped` (never registered, never thrown), so requesting its name yields a precise *untrusted* error rather than *unknown*.

The framework is **contract-only** — it does **not** depend on its daughters. First-party daughters install flat via the [`@plurnk/plurnk-providers-all`](https://github.com/plurnk/plurnk-providers-all) aggregator (a code-free package depping the five daughters directly), so npm hoists them to the top of `node_modules` where the scan finds them; a consumer installs `@plurnk/plurnk-providers` + `@plurnk/plurnk-providers-all`. Each daughter declares the framework as a `peerDependency` with a deliberately wide range (`>=0.7.0 <1.0.0`) so one shared copy lives in the tree (class identity for `instanceof ProviderError` included) **without** a framework minor forcing a daughter republish — the next forced bump is `1.0.0`. This mirrors `@plurnk/plurnk-execs` + `@plurnk/plurnk-execs-all`, which proved that framework-aggregates-daughters (execs `0.4.2`) nests the daughters and breaks the scan — reverted at `0.4.3` to exactly this flat-aggregator shape (#12/#14).

## §6 Engine → provider guarantees (consumer side)

- `messages` is a complete prompt. Consumer has pre-assembled all sections. Provider does not add, reorder, or inject turns — the wire `messages` are exactly what the consumer passed. (Plan-forcing is the grammar's + consumer prompt's job, not a provider prefill — §4, #16.)
- Every `generate` carries `runId` — the run's stable, opaque identity. Same run → same string across its turns; distinct runs → distinct strings.
- `signal` is wired to the run's AbortController.
- `generate` is single-call per turn. No parallel calls on the same instance.
- `assistantRaw` is opaque to the consumer (forensics-only).
- `countTokens` is cheap by contract; consumer calls frequently.

## §7 Provider → engine guarantees

- **No DB access.** Provider never touches `node:sqlite` or storage layers.
- **No service access.** No imports from `@plurnk/plurnk-service`.
- **No grammar runtime dep.** Type-imports from `@plurnk/plurnk-grammar` are fine; invoking `PlurnkParser.parse` is consumer-side.
- **Raw `content`.** Returned verbatim. Tools are expressed in-body as plurnk DSL (see §2); providers do not use native tool-calling.
- **Atomic.** One `generate` call resolves with one complete `ProviderResponse`. No streaming partial resolves (v0).
- **Honors `signal`.** Aborted calls reject; resources free; no orphaned connections.
- **Single model.** One provider instance speaks to one model.
- **Synchronous `countTokens`, pure `costFor`.** No I/O, no async, no state beyond cached tokenizer artifacts.

## §8 Forbidden

| ❌ |
|---|
| Database access |
| Filesystem access beyond reading provider-internal config |
| Imports from `@plurnk/plurnk-service/*` |
| Resolving with partial content on abort |
| Mutating `messages` |
| Parsing `content` into `PlurnkStatement[]` |
| Streaming the resolve (atomic only; v0) |
| Holding state across `generate` calls beyond connection pooling, config, and backend-affinity bookkeeping (run→resource maps, §2) |
| Exposing backend resource identifiers (slot ids, connections) on the consumer surface |
| Reading model output via `console.*` |
| Ignoring `signal` |
| Spawning subprocesses for inference |

## §9 Reference — `Mock`

`./src/Mock.ts` — test-fixture provider + worked example. Queue of pre-built responses; `generate` shifts one off.

```ts
import { Mock } from "@plurnk/plurnk-providers";

const mock = new Mock({
    contextSize: 100000,
    responses: [{ assistant: { content: "<<SEND[200]:hi:SEND", reasoning: null } }],
});
const result = await mock.generate({ messages: [] });
```

`MockResponse.assistant.ops?: unknown[]` is a pre-parsed escape hatch consumed by plurnk-service intg tests (skips parse roundtrip); the consumer casts to `PlurnkStatement[]` on its side. It is typed `unknown[]` deliberately so **this package has no dependency on `@plurnk/plurnk-grammar` at all** — not runtime, not peer, not even a type import — so grammar releases never force a providers re-pin. Production providers don't expose `ops`.

## §10 Conformance

A sibling package satisfies the contract when:

1. Default export is a class with `static fromEnv(env, model)` factory.
2. Instance exposes `contextSize: number | null` and `model: string` (non-empty).
3. Instance exposes `countTokens(text): number` and `costFor(usage): number`.
4. `countTokens("")` returns `0`; `countTokens("…")` returns a non-negative integer.
5. `costFor({prompt:0,completion:0,reasoning:0,cached:0,total:0})` returns `0` (or non-negative pico-USD for non-free models).
6. Identity getters return stable values across reads.
7. `generate` resolves with a valid `ProviderResponse` shape.
8. `generate` invoked with a pre-aborted `signal` rejects without making a wire call.
9. `generate` invoked, then aborted mid-flight rejects within ≤5s; no connection leak.
10. `assistantRaw` is present (any value, including `null`).
11. No DB access, no imports from `@plurnk/plurnk-service`.
12. No runtime import of `@plurnk/plurnk-grammar` parser entry points.
13. `generate` invoked with `grammar` against a backend without grammar support sends no grammar-related wire fields and does not error (§13).

Sibling-specific behavioral tests (wire-format compliance, model-family quirks, retry logic) live in each package's own test surface.

## §11 Shared OpenAI-compatible machinery

The framework ships the transport spine every OpenAI-compatible provider had been duplicating. Build a sibling *on top of these* — don't re-implement them.

- **`OpenAICompatProvider`** — a `Provider` implementation built by composition. Its `generate` does the universal work (merge `signal` with a `PLURNK_FETCH_TIMEOUT` deadline, stream the completion, map `usage`, normalize `finishReason` to the §2 set, assemble the response). Per-provider deltas arrive as config:

  ```ts
  new OpenAICompatProvider({
      model, url,            // fully-resolved chat-completions URL
      fetchTimeoutMs,
      headers,               // fully-resolved request headers (incl. auth)
      contextSize,           // number | null
      reasoningBudget, reasoningStyle,   // "none" | "think" | "include_reasoning" | "effort" | "template"
      countTokens, costFor,  // strategies; default heuristic / free
      supportsGrammar,       // backend accepts a `grammar` body field (§13); default false
      supportsSlotPinning, slotCount,  // INTERNAL slot-affinity wiring (run→id_slot); never consumer-facing
  });
  ```

  The `openai` standard provider sets `supportsGrammar` and `supportsSlotPinning` from the same llama-server fingerprint, and `slotCount` from a `/props` probe (§11). The run→slot mapping itself lives inside `OpenAICompatProvider`: sticky per `runId`, round-robin across new runs, LRU-bounded.

- **`chatCompletionStream` / `OpenAiHttpError` / `StreamResponse`** — the SSE client. One shared copy.
- **`normalizeUsage(raw)` / `computeCost(usage, {input, output, cached})`** — usage normalization to the §2 invariant (handles both reasoning-reporting conventions) and the single cost formula (bills `completion + reasoning` at the output rate). `OpenAICompatProvider` applies `normalizeUsage` automatically; siblings pass their per-token rates to `computeCost` in their `costFor`.
- **`parseRequiredInt` / `parseOptionalInt` / `requireEnv`** — env helpers; each takes a provider `label` for error prefixing.
- **`tokenizerFor(family)` / `tokenizerByPublisher(model, table, index)` / `parseTokenizerFamily(...)`** — synchronous tokenizer strategies (`heuristic` | `cl100k` | `llama`) and per-publisher dispatch for relay providers.
- **`effortFromBudget(budget)`** — the shared `PLURNK_PROVIDERS_REASONING_BUDGET` → `low|medium|high` breakpoints.

A **bespoke sibling** therefore reduces to a thin class whose `fromEnv` probes whatever it needs (model catalog, pricing, context window), builds the config, and returns `new OpenAICompatProvider(config)`. A **standard provider** (§5 tier 1) needs no sibling at all — it's a frozen entry in `STANDARD_PROVIDERS` describing its key var, base URL, reasoning style, and tokenizer; `standardProviderFromEnv(name, env, model)` (async — returns `Promise<Provider | null>`) does the rest.

`contextSize` for a standard provider resolves: `PLURNK_PROVIDER_CONTEXT_SIZE` → endpoint `n_ctx` (for `probeNctx`-flagged specs like `openai`, queried from `GET /v1/models` — llama-server reports its loaded window at `data[].meta.n_ctx`, vLLM top-level; cloud endpoints don't, yielding `null`) → `null`. The same probe fingerprints llama-server (the `meta` block) to enable grammar transport (§13), so it runs even when the env var pins the window. The probe is best-effort: any failure resolves to `null` context / no grammar capability (a legitimate "unknown"), never throws.

## §12 Telemetry — provider failures

Transport failures surface as a `ProviderError` (extends `Error`, so existing catchers keep working) that carries the plurnk **TelemetryEvent** envelope via `toTelemetryEvent()`:

```ts
{ source: "provider:<vendor>", kind: ProviderTelemetryKind, message: string, position: null }
```

- `source` is `provider:<vendor>` (schema pattern `^[a-z]+(:[a-z][a-z0-9-]*)?$`); standard providers set it from their name, siblings via the `source` config field (default `"provider"`).
- `kind` ∈ `rate_limit | network_failure | model_refused | invalid_response | unauthorized | quota_exceeded`. HTTP status maps: 401/403→`unauthorized`, 402→`quota_exceeded`, 429→`rate_limit`, ≥500→`network_failure`, other 4xx→`invalid_response`; timeouts/fetch errors→`network_failure`. (`model_refused` is response-level — minted consumer-side from a `content_filter` finish reason, not from a thrown error.)
- `message` is terse and factual (no guidance prose); `position` is `null` (provider failures aren't localizable into prior content).
- **Caller-initiated abort is NOT telemetry** — an aborted `signal` rethrows the original abort, never a `ProviderError`.

The `TelemetryEvent` shape is mirrored **locally** (`./telemetry.ts`), structurally matching `@plurnk/plurnk-grammar`'s `TelemetryEvent.json`, so the framework keeps zero grammar dependency (§11). Consumers route provider events through the same `source`+`kind` discriminator as parse/rail events.

## §13 Grammar-constrained sampling (GBNF)

`@plurnk/plurnk-grammar` ships `@plurnk/plurnk-grammar/plurnk.gbnf` — a generated llama.cpp grammar constraining sampling to the canonical plurnk form. Ownership splits three ways:

- **plurnk-grammar** owns the artifact (canonical-form GBNF, `L(GBNF) ⊂ L(ANTLR)` invariant, tests).
- **This layer** owns capability detection + transport: `generate({ …, grammar })` attaches the string **verbatim** as the `grammar` body field when the backend supports it, and sends no grammar-related field otherwise (cloud APIs reject unknown params). The provider never chooses or modifies the grammar.
- **The consumer** owns policy: whether to constrain a given call, and which root variant to send (e.g. the `root ::= statement` single-statement substitution that forces EOS at the close tag — the shipped `statement+` root never forces EOS, so greedy generation runs to `max_tokens`).

**Sampling guard.** Greedy decoding under hard constraint masks degenerates into repetition loops at `repeat_penalty: 1.0`, so `OpenAICompatProvider` sends a per-request `repeat_penalty: 1.15` floor alongside every attached grammar — never relying on server launch flags. (Probed live on llama.cpp b894 + gemma-4-26B; reference: plurnk-grammar `test/llama/gbnf-live.test.ts`.)

**The cap is the consumer's required guard.** The repeat-penalty floor suppresses short repetition cycles, NOT long-cycle degeneration: under the multi-op root (optional EOS) at near-greedy temperatures, a constrained emission can answer correctly in its first tokens and then loop to the **context wall** (observed live: 30,736 junk tokens to `finish_reason: length`, minutes of decode reading as a "hang", with the junk echoed into the next turn's prompt — providers#10). No layer defaults a cap: the wire default is unbounded (`n_predict: -1`) and the provider transports policy, never invents it. A consumer enabling constrained sampling MUST pass `maxTokens` (or send a root variant that forces EOS).

**Native reasoning and the grammar are mutually exclusive; in-DSL reasoning is the working pattern.** The GBNF masks every sampled token. With NATIVE thinking live (llama-server's own `--reasoning-budget` default, or `enable_thinking: true`), the server auto-gates the grammar past the think block — reasoning flows free — but content-channel enforcement then **leaks** (unconstrained prose, degenerates) or content never arrives; explicit `grammar_lazy`/`grammar_triggers` are ignored on the chat-completions path. The constrained configuration therefore requires the native channel **explicitly closed** — `PLURNK_PROVIDERS_REASONING_BUDGET=0`, which the `template` style emits as `enable_thinking: false`; mere field omission leaves the server default live, and think-inviting tasks then break the loop. With the channel closed, the model willingly reasons **inside the DSL**: the grammar's `PLAN` statement is a free-text body the model fills with genuine step-by-step reasoning before acting (probed live, b894+gemma: correct chain-of-thought inside `<<PLAN:…:PLAN`, then a clean `SEND`, `finish_reason: stop`). Channeling reasoning through `PLAN` is consumer/prompt policy; the provider's job is closing the native channel deterministically.

**Capability detection.** `OpenAICompatConfig.supportsGrammar` (default `false`). The `openai` standard provider detects it from the §11 probe: only llama-server rows on `GET /v1/models` carry a `meta` block, and llama-server is the backend whose chat-completions accepts `grammar`. vLLM speaks a different guided-decoding dialect and is deliberately excluded. Bespoke siblings opt in via config when their backend qualifies. Capability stays provider-internal — no `ProviderDeclaration` schema field until the consumer actually needs to branch on it.

Zero grammar dependency (§11) is preserved: the GBNF string arrives per call; this package never imports the artifact.
