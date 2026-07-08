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
    readonly model: string;                // configured model id (the alias for a local backend)
    // OPTIONAL (#37): backend's SELF-REPORTED served id, from a /v1/models-shaped
    // probe. For a local alias `model` is the alias; this is the real served name
    // (the .gguf) the tokenizer seam maps. Absent when unprobed. Consumers resolve
    // `servedModel ?? model`.
    readonly servedModel?: string;

    // Tokenomic primitives (synchronous, pure)
    countTokens(text: string): number;
    costFor(usage: ProviderUsage): number;  // pico-USD (1e-12 USD)

    // OPTIONAL capability: exact tokenization served by the backend's own vocab
    // (llama-server /tokenize). Probe-gated — undefined means the backend can't.
    tokenize?(text: string): Promise<number[]>;

    // Transport. `runId` is REQUIRED: the opaque, stable identity of the
    // consumer's work stream — providers may key backend affinity on it and
    // never interpret it. `grammar` is an optional GBNF string for
    // grammar-constrained sampling (§13) — attached verbatim by capable
    // backends, ignored by all others. `maxTokens` is the consumer's per-call
    // output ceiling (wire `max_tokens`); absent means the server default,
    // which is typically UNBOUNDED. `attributions`/`client` are optional
    // first-party metadata, forwarded as `Plurnk-*` headers ONLY by a provider
    // configured with `firstPartyMetadata` (the plurnk endpoint) and dropped by
    // every other — structurally unable to reach a third-party backend (§11).
    // `sampling` is an optional bag of standard OpenAI-compat sampling params
    // (temperature, top_p, top_k, min_p, penalties, stop, seed, …) merged into the
    // body UNDER the managed fields — model/messages/grammar/reasoning/max_tokens/
    // slot always win, and transport/protocol keys (stream, response_format,
    // grammar, id_slot) are stripped, so it carries sampling intent only and can't
    // bypass grammar transport (§8). For a PROXY consumer forwarding its own
    // caller's sampling knobs (the plurnk endpoint fronting gemma/Fireworks); a
    // direct consumer leaves it unset.
    // `strikes` is the run's CURRENT rail-strike streak at time-of-generate
    // (0 = clean, distinct from absent = unreported; contract plurnk-service#313).
    // Forwarded as `Plurnk-Strikes` ONLY under the firstPartyMetadata gate,
    // dropped everywhere else. Headers only — never placed in the packet.
    generate(args: { messages: ChatMessage[]; runId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse>;
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
    meta?: Record<string, unknown>; // per-turn provider→client bag: backend extra fields passed through + validated known keys (e.g. balancePico, pico-USD); absent when empty (#23)
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
- `countTokens` is **synchronous**, returns a non-negative integer, deterministic for the same input. Without an exact tokenizer family configured it is the **chars/2 UPPER BOUND** — deliberately conservative (real agentic text measures ~2.9–3.2 chars/token on gemma/deepseek, so the former chars/4 silently UNDERcounted 20–27%; a fallback may overcount, never under) — and it is **surfaced at construction** (`process.emitWarning`, code `PLURNK_TOKENIZER_HEURISTIC`), never silent. Exact counting is the tokenizer seam's job (mimetypes family), fed by `tokenize()` where available.
- `tokenize?` is an **optional async capability**: token ids in the model's real vocabulary, served by the backend itself (llama-server's native root `/tokenize`, surfaced when the §11 probe fingerprints a llama-server and `detectLlamaServer` isn't false). `tokenize === undefined` is the honest "backend can't" signal. Exact-counting consumers prefer it over any client-side tokenizer data — the local model's own vocab needs no bundled `tokenizer.json` at all.
- `costFor` is **pure**, returns pico-USD non-negative integer. Returns `0` for siblings with no known rates (local Ollama, generic OpenAI-compat shims).
- `contextSize` resolves to `null` when provider can't determine the model's context window. Consumer treats null as "no budget info available."
- `generate` rejects on signal abort — does NOT resolve with partial content.
- `generate` transports `grammar` verbatim when the backend supports grammar-constrained sampling, and silently ignores it otherwise (§13). The provider never chooses or modifies the grammar.
- `generate` **returns for every completed exchange — bytes always present, the conformance verdict attached as an observation.** When a grammar was transported (or validated in filter mode), the returned `content` is checked against it; a non-accept verdict rides `response.telemetry` as a `grammar_unenforced` event (message + divergence `position`) and the response returns normally. The provider transports and observes; it never adjudicates — discard, retry, escalate, or feed-back is consumer policy. This is a grammar-**conformance** check against the grammar the provider already holds — *not* a plurnk-DSL parse (that stays consumer-side, below) — so it remains backend- and DSL-agnostic. `ProviderError` remains reserved for exchanges that did NOT complete (transport failure, abort, boundary violations).
- **Backend affinity is the provider's internal guarantee, keyed by `runId`.** The consumer says *which run this is*, never *which backend resource serves it* — raw resource identifiers (slot integers, connections) never cross the contract in either direction. On slot-pinning backends (llama-server `--parallel N>1`), the provider keeps each run sticky to one slot and spreads distinct runs across slots, so each concurrent run keeps its KV-cache prefix warm (un-pinned routing is the server's similarity heuristic — slot hops re-pay full prefills). Backends without affinity semantics ignore `runId` entirely.

## §3 `fromEnv(env, model, options?)` factory

Default export MUST have a static `fromEnv(env, model, options?)` factory:

```ts
class OpenAI {
    static fromEnv(env: NodeJS.ProcessEnv, model: string, options?: ProviderOptions): OpenAI | Promise<OpenAI> {
        // Read provider-specific env (OPENAI_BASE_URL, OPENAI_API_KEY, ...)
        // plus universal operator knobs (PLURNK_PROVIDERS_THINKING, PLURNK_PROVIDERS_FETCH_TIMEOUT,
        // PLURNK_PROVIDERS_CONTEXT_SIZE). `options.baseUrl`, when set, is the per-alias
        // endpoint override (PLURNK_BASEURL_<alias>, §5) and wins over the env base URL.
        return new OpenAI({ /* ... */ });
    }
    constructor(config: OpenAIConfig) { /* ... */ }
}
```

The consumer's instantiation path calls `mod.default.fromEnv(env, alias.model, options?)` generically (§5). `options` is optional — a factory that ignores the third arg keeps working unchanged; a self-hosted provider (`openai`, `ollama`) honors `options.baseUrl` so two aliases can target two boxes.

`fromEnv` MAY be sync or async; return type `Provider | Promise<Provider>`. (Why a factory, where execs/mimes use a base class + constructor injection and schemes a `static manifest`: a provider often **async-probes** at construction — model catalog, context window, slot count — which a constructor can't express. The factory is the seam for that probe.)

`fromEnv` MUST fail fast with a clear error if required env is missing — name the env var the operator needs to set.

## §4 Universal operator knobs

Each provider's `fromEnv` reads these:

- **`PLURNK_PROVIDERS_THINKING`** — REQUIRED, one of `off | adaptive | on` (#33). Pure ACTIVATION intent; **`PLURNK_PROVIDERS_THINKING_CAPACITY`** (positive int, REQUIRED iff `on`) carries the magnitude separately, so a number can never silently flip wire flags. The provider maps intent to the active backend's mechanism — llama-server `chat_template_kwargs: { enable_thinking }` (always emitted; the explicit FALSE is the only working off-switch; the NUMERIC clamp is the box's `--reasoning-budget` LAUNCH flag — per-request numerics are ignored, so env capacity and launch flag are the same number, changed together), Ollama `think`, relay `include_reasoning`, cloud `reasoning_effort` (tier from capacity when `on`; `off`/`adaptive` omit), fireworks `reasoning_effort` **explicit** (`effort_explicit`: `off` SENDS `"none"`, `adaptive` SENDS `"adaptive"` — omission is NOT off on reason-by-default models like DeepSeek V4, #30. Intent maps **identically under a transported grammar** (the former #32 clamp-to-`"none"` is lifted — it caused plan-less turns, service#331; the lift enables best-effort reasoning). BUT reasoning and hard-masked GBNF rails do **NOT reliably coexist** on fireworks (TUNING-EPIC **F9-final**, ~60 live tests). Fireworks' docs: `response_format` (which includes grammar mode) **disables reasoning output**; measured, reasoning reaches the usable `reasoning_content` channel only stochastically (~1/8) and otherwise collapses or leaks into `content` — best lever (prefill `<think>\n`) tops out at 7/10 with a runaway tail. So under a transported grammar, reasoning is **best-effort and unsegregated** (lands in `content`, not `reasoning_content`), and NOT tunable — a consumer wanting the reasoning parses the preplan region of `content`. Fireworks is rails-first; single-call reasoning+rails needs a llama.cpp lazy-grammar host. Envelope: `max_tokens` is a cost circuit-breaker (reasoning-on can run away), not a reasoning reserve), Anthropic `thinking: disabled | enabled+budget_tokens(capacity) | omit`. Consumers state intent, never mechanism. (In-DSL `<<PLAN>>` reasoning has **no provider footprint** and no operator knob: `PLAN` is a required element of the canonical plurnk grammar the consumer attaches via `generate`'s `grammar`. The provider transports that grammar verbatim and never forces, prefills, or toggles `PLAN`.)

Read via `reasoningBudgetFromEnv` and **fail hard when unset** — configuration lives in the operator's env (the consumer's `.env.example` declares every var); the framework never defaults a knob in code.
- **`PLURNK_PROVIDERS_FETCH_TIMEOUT`** — service-wide ms ceiling on any single outbound request (**per attempt**, not shared across retries). Each `fromEnv` reads and passes as `AbortSignal.timeout`. Per-provider override envs are NOT part of the contract.
- **`PLURNK_PROVIDERS_RETRY_ATTEMPTS`** — REQUIRED non-negative integer (read via `parseRequiredInt`). The transient-failure retry budget: **`0`** surfaces the first failure; **`N`** retries up to `N` times on a *transient* classification only (`rate_limit` / `network_failure` — 429, 5xx, timeout, connection reset). Terminal kinds (`unauthorized`, `quota_exceeded`, `invalid_response`, `model_refused`) are never retried. Backoff is exponential from a `2000ms` base (`base * 2^(attempt-1)`), unless the server sent a `Retry-After` (which wins). The caller's `signal` aborts both the in-flight request and the backoff sleep. Lives in the shared `OpenAICompatProvider` so every provider inherits it uniformly; rides on the existing `classifyProviderError` (#18).
- **`PLURNK_PROVIDERS_CONTEXT_SIZE`** — optional positive-integer override for the model's reported context window. Resolution: this env var → provider probe/config/table → `null`.

## §5 Alias cascade resolution

`PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an alias; `PLURNK_MODEL=<alias>` selects which is active.

```
PLURNK_MODEL_gemma=openai/macher.gguf
PLURNK_MODEL_opus=openrouter/anthropic/claude-opus-latest
PLURNK_MODEL=gemma
```

First path segment names the provider; rest is the model identifier (may contain `/` for tri-level providers like openrouter's `publisher/model`).

**Per-alias endpoint override — `PLURNK_BASEURL_<alias>`.** A provider's base URL otherwise binds **one URL per provider *name*** (its `baseUrlVar`, §11), so two `openai/…` aliases collapse onto the same `OPENAI_BASE_URL`. That makes running **N self-hosted boxes of the same kind** — the real case for the two "bring your own box" providers, `openai` (llama.cpp/vLLM/LM Studio) and `ollama` — impossible by name alone. `PLURNK_BASEURL_<alias>` attaches an endpoint to the *alias*, case-folded to match its `PLURNK_MODEL_<alias>`, and **wins over** the provider's own base-URL var:

```
PLURNK_MODEL_HAZEL1=openai/qwen2.5-coder
PLURNK_BASEURL_HAZEL1=http://hazel1:8080/v1      # llama.cpp box 1
PLURNK_MODEL_HAZEL2=openai/qwen3-coder
PLURNK_BASEURL_HAZEL2=http://hazel2:8080/v1      # llama.cpp box 2 — same provider name, different box
PLURNK_MODEL_NOOK=ollama/qwen2.5-coder
PLURNK_BASEURL_NOOK=http://nook:11434            # an ollama box; drives BOTH /v1/chat and /api/show
```

Each alias instantiates against its own URL and probes its own box (openai's `n_ctx`/slots, ollama's `/api/show`). The override threads through the alias → `instantiateProvider` → both tiers; on the tier-2 (daughter) path it arrives as the third `fromEnv(env, model, { baseUrl })` argument (a factory that ignores it is unaffected). A `PLURNK_BASEURL_*` with no matching alias **fails hard** (a typo, not a silent no-op). It's accepted for *any* provider but only meaningful for the self-hosted ones; the hosted providers (`groq`, `fireworks`, …) carry a canonical endpoint you'd never multi-home.

This package's exported resolution surface:

- `parseAliasesFromEnv(env)` — extracts alias entries.
- `resolveActiveAlias(env)` — `{ alias, provider, model } | null`.
- `instantiateProvider(name, env, model)` — full two-tier resolution (below).
- `loadActiveProvider(env)` — boot convenience: active alias → `instantiateProvider`.
- `standardProviderFromEnv(name, env, model)` / `isStandardProvider(name)` — the tier-1 internals, still exported.
- `discover({ cwd?, packageDirs?, env? })` — the tier-2 scan: a `Discovery` (`{ registry, skipped, attributions }`) of every installed provider package. `registry`/`skipped` are `Map<name, packageSpecifier>` partitioned by the trust gate; `attributions` is `Map<name, string | string[]>` carrying each registered provider's raw `plurnk.attribution` for author credit (#21 — surfaced verbatim; the consumer applies the `@plurnk/`-scope reservation policy). Exported so a consumer can enumerate trusted providers — and see which were declined — without instantiating them.

**Two-tier provider resolution — owned entirely by this package.** A provider name resolves in this order:

1. **Standard provider** (`§11`) — if `isStandardProvider(name)`, instantiated directly via `standardProviderFromEnv(name, env, model)`. No package is imported. Covers every plain OpenAI-compatible endpoint (`openai`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `deepinfra`, `anthropic`, `bedrock`, `plurnk`, …) — including first-party Claude (Anthropic's compat endpoint, bearer auth, the `thinking` reasoning param), AWS Bedrock (its compat endpoint at the `/openai/v1` path, Bedrock-API-key bearer; the base is `BEDROCK_BASE_URL` if set, else derived as `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` from the standard `AWS_REGION`/`AWS_DEFAULT_REGION`; its inference-profile model ids resolve a catalog **context window** by stripping the region and looking the model up under its publisher (#22), while cost stays unknown — bedrock marks up over the native rate), and the **`plurnk` hosted model** (a plain remote OpenAI endpoint at its `PLURNK_BASE_URL` base, `.env.example` → `https://plurnk.ai/v1`; reads its server-controlled context window from upstream, sends no grammar and no tuning); none needs a daughter. `plurnk` authenticates with a single optional bearer (`PLURNK_API_KEY`, sent only when set), like any other standard bearer. A spec's `apiKeyVar`/`baseUrlVar` may be a **list** of accepted env-var aliases — the conventional names the wild uses for one credential/base (e.g. `deepinfra` → `DEEPINFRA_API_KEY` / `DEEPINFRA_API_TOKEN` / `DEEPINFRA_TOKEN`; `openai` base → `OPENAI_BASE_URL` / `OPENAI_API_BASE`). First set non-empty wins; a required key unset across *all* aliases fails hard naming each. This is alias resolution over operator-set values, never a fabricated default. (An entry MAY instead supply a custom `headersFromEnv` builder for auth a bearer can't express — multi-header/credential schemes — or a `baseUrlFromEnv` builder to template the base from env, as bedrock does.) The standard table is **authoritative**: a scanned package whose name duplicates a standard one is shadowed (tier 1 returns first).
2. **Discovered package** — otherwise, a **scope-agnostic `node_modules` scan** (`discover()`) maps the provider name to the installed package that declares `plurnk: { kind: "provider", name }`, which is dynamic-imported and `fromEnv(env, model, options?)`-called. Covers first-party daughters with real runtime surface (`openrouter`, `ollama`, `google`, `xai`, `cloudflare`, the planned `vertex`/`cohere`) **and any third-party provider published under its own scope** (`@acme/llm-provider-foo`) — no involvement from us, no `@plurnk` scope assumption. Two installed packages claiming the same name → fail-hard naming both. Unknown name → fail-hard. The scan runs once per process and is memoized.

   Discovery honors the host **trust gate** `PLURNK_PLUGINS_TRUSTED_ONLY` — the same env var the execs/mimes/schemes families read (plurnk-service#229, #15). OFF (unset/empty/`0`) trusts every installed provider; ON (any value) trusts `@plurnk/*` plus a comma-separated allowlist and declines the rest. A declined package is recorded in `skipped` (never registered, never thrown), so requesting its name yields a precise *untrusted* error rather than *unknown*.

The framework is **contract-only** — it does **not** depend on its daughters. First-party daughters install flat via the [`@plurnk/plurnk-providers-all`](https://github.com/plurnk/plurnk-providers-all) aggregator (a code-free package depping the five daughters directly), so npm hoists them to the top of `node_modules` where the scan finds them; a consumer installs `@plurnk/plurnk-providers` + `@plurnk/plurnk-providers-all`. Each daughter declares the framework as a `peerDependency` with a deliberately wide range (`>=0.7.0 <1.0.0`) so one shared copy lives in the tree (class identity for `instanceof ProviderError` included) **without** a framework minor forcing a daughter republish — the next forced bump is `1.0.0`. This mirrors `@plurnk/plurnk-execs` + `@plurnk/plurnk-execs-all`, which proved that framework-aggregates-daughters (execs `0.4.2`) nests the daughters and breaks the scan — reverted at `0.4.3` to exactly this flat-aggregator shape (#12/#14).

## §6 Engine → provider guarantees (consumer side)

- `messages` is a complete prompt. Consumer has pre-assembled all sections. Provider does not add, reorder, or inject turns — the wire `messages` are exactly what the consumer passed. (The provider injects no `PLAN` turn — `PLAN` is part of the consumer's grammar contract, §4.)
- Every `generate` carries `runId` — the run's stable, opaque identity. Same run → same string across its turns; distinct runs → distinct strings.
- `signal` is wired to the run's AbortController.
- `generate` is single-call per turn. No parallel calls on the same instance.
- `assistantRaw` is opaque to the consumer (forensics-only).
- `meta` is the per-turn provider→client metadata bag: the backend's **non-standard top-level response fields passed through verbatim** (every provider), PLUS **validated known keys** the framework holds a contract for — currently `balancePico` (a finite pico-USD number normalized from the plurnk endpoint's balance field, renamed off its raw key; dropped if non-numeric). Absent when the backend reported no extras. The consumer (service) merges `meta` into its Turn metadata and filters what reaches the client; it reads `meta`, never mines `assistantRaw` (#23).
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

1. Default export is a class with `static fromEnv(env, model, options?)` factory.
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
14. `generate` that transported a grammar and received conforming output resolves; output the grammar rejects (or an incomplete match) rejects with a `grammar_unenforced` `ProviderError` (§13). (Inherited from `OpenAICompatProvider`; bespoke siblings on a non-compat transport implement it.)

Sibling-specific behavioral tests (wire-format compliance, model-family quirks, retry logic) live in each package's own test surface.

## §11 Shared OpenAI-compatible machinery

The framework ships the transport spine every OpenAI-compatible provider had been duplicating. Build a sibling *on top of these* — don't re-implement them.

- **`OpenAICompatProvider`** — a `Provider` implementation built by composition. Its `generate` does the universal work (merge `signal` with a `PLURNK_PROVIDERS_FETCH_TIMEOUT` deadline, stream the completion, map `usage`, normalize `finishReason` to the §2 set, assemble the response). Per-provider deltas arrive as config:

  ```ts
  new OpenAICompatProvider({
      model, url,            // fully-resolved chat-completions URL
      fetchTimeoutMs,
      headers,               // fully-resolved request headers (incl. auth)
      contextSize,           // number | null
      reasoningBudget, reasoningStyle,   // "none" | "think" | "include_reasoning" | "effort" | "template" | "anthropic"
      countTokens, costFor,  // strategies; default heuristic / free
      grammarStyle,          // "none" | "llamacpp" | "response_format" — GBNF wire shape (§13); default "none"
      gbnfDebug,             // PLURNK_PROVIDERS_GBNF_DEBUG: validate a grammar locally + throw on invalid, but DON'T send it (§13); default false
      streaming,             // SSE transport; default true (false → one non-streamed JSON)
      supportsSlotPinning, slotCount,  // INTERNAL slot-affinity wiring (run→id_slot); never consumer-facing
      logprobs, rawBody,     // #36 opt-in data capture (PLURNK_PROVIDERS_LOGPROB / _RAWBODY); default off
      servedModel,           // #37 backend's self-reported served id (from the probe) → Provider.servedModel
  });
  ```

  The `openai` standard provider sets `grammarStyle: "llamacpp"`, `supportsSlotPinning`, and `slotCount` from the same llama-server fingerprint (`/v1/models` `meta` block + `/props`). The run→slot mapping lives inside `OpenAICompatProvider`: sticky per `runId`, round-robin across new runs, LRU-bounded.

- **`chatCompletionStream` / `chatCompletion` / `OpenAiHttpError` / `StreamResponse`** — the shared HTTP client (`chatCompletionStream` for SSE, `chatCompletion` for the non-streamed JSON the `streaming: false` path uses). One shared copy.
- **`normalizeUsage(raw)` / `computeCost(usage, {input, output, cached})`** — usage normalization to the §2 invariant (handles both reasoning-reporting conventions) and the single cost formula (bills `completion + reasoning` at the output rate). `OpenAICompatProvider` applies `normalizeUsage` automatically; siblings pass their per-token rates to `computeCost` in their `costFor`.
- **`parseRequiredInt` / `parseOptionalInt` / `requireEnv`** — env helpers; each takes a provider `label` for error prefixing.
- **`effortFromBudget(capacity)`** — the shared thinking-capacity → `low|medium|high` breakpoints.

A **bespoke sibling** therefore reduces to a thin class whose `fromEnv` probes whatever it needs (model catalog, pricing, context window), builds the config, and returns `new OpenAICompatProvider(config)`. A **standard provider** (§5 tier 1) needs no sibling at all — it's a frozen entry in `STANDARD_PROVIDERS` describing its key var, base-URL var, reasoning style, and tokenizer; `standardProviderFromEnv(name, env, model)` (async — returns `Promise<Provider | null>`) does the rest. The endpoint is **required operator config** — read from the base-URL var (or a `baseUrlFromEnv` deriver) with **no in-code default**; the canonical URL lives uncommented in `.env.example`, never baked into the table.

The `plurnk` entry alone sets **`firstPartyMetadata: true`** — it forwards the consumer's per-turn `generate()` `attributions` (which installed plugin packages dispatched) and `client` (the originating frontend, e.g. `plurnk.nvim/1.4.0`) as `Plurnk-Attribution` / `Plurnk-Client` headers, and the opaque `runId` as `Plurnk-Run-Id` (#26). The gate lives on the provider, not the call site, so these first-party signals are **structurally incapable** of reaching a third-party backend. Empty values emit no header. It also alone sets **`balanceMetaKey: "balance_pico"`** — the top-level response field the plurnk endpoint reports the running account balance (pico-USD) in. `OpenAICompatProvider` surfaces the backend's extra top-level fields as `ProviderResponse.meta` for **every** provider (passed through), and for a provider that set `balanceMetaKey` it additionally normalizes that field into a validated `meta.balancePico`. So `balancePico` appears only from plurnk; the raw pass-through `meta` is general (#23).

A spec may carry a **`modelPrefix`** — a constant model-id segment the backend requires but the operator's alias shouldn't repeat. `fireworks` sets `"accounts/fireworks/models/"`, so `PLURNK_MODEL_fast=fireworks/deepseek-v4-pro` carries only the distinctive tail; `standardProviderFromEnv` prepends it idempotently (an already-prefixed id is untouched) to form the wire id, which is **also** the catalog key (models.dev keys fireworks-ai on the full id). Specs without a `modelPrefix` use the model string verbatim.

`contextSize` for a standard provider resolves: `PLURNK_PROVIDERS_CONTEXT_SIZE` → endpoint `n_ctx` (for `probeNctx`-flagged specs like `openai`, queried from `GET /v1/models` — llama-server reports its loaded window at `data[].meta.n_ctx`, vLLM top-level; cloud endpoints don't, yielding `null`) → `null`. The same probe fingerprints llama-server (the `meta` block) to enable grammar transport (§13), and reads the row's `id` as `servedModel` (#37) — the real served name behind a local alias — so it runs even when the env var pins the window. The probe is best-effort: any failure resolves to `null` context / no grammar capability (a legitimate "unknown"), never throws.

## §12 Telemetry — provider failures

Transport failures surface as a `ProviderError` (extends `Error`, so existing catchers keep working) that carries the plurnk **TelemetryEvent** envelope via `toTelemetryEvent()`:

```ts
{ source: "provider:<vendor>", kind: ProviderTelemetryKind, message: string, position: null }
```

- `source` is `provider:<vendor>` (schema pattern `^[a-z]+(:[a-z][a-z0-9-]*)?$`); standard providers set it from their name, siblings via the `source` config field (default `"provider"`).
- `kind` ∈ `rate_limit | network_failure | model_refused | invalid_response | unauthorized | quota_exceeded | grammar_unenforced`. HTTP status maps: 401/403→`unauthorized`, 402→`quota_exceeded`, 429→`rate_limit`, ≥500→`network_failure`, other 4xx→`invalid_response`; timeouts/fetch errors→`network_failure`. (`model_refused` is response-level — minted consumer-side from a `content_filter` finish reason, not from a thrown error.) **`grammar_unenforced`** is response-level too, with two deliveries (§13): on the **constrained** path it's a thrown `ProviderError` (terminal, never retried — the backend ignored a grammar it was sent); in **GBNF-filter mode** it's a **non-fatal `TelemetryEvent` on a successful response** (`ProviderResponse.telemetry`), carrying the divergence `position` so the consumer can drive model self-correction (#24).
- `message` is terse and factual (no guidance prose); `position` is `null` (provider failures aren't localizable into prior content).
- **Caller-initiated abort is NOT telemetry** — an aborted `signal` rethrows the original abort, never a `ProviderError`.

The `TelemetryEvent` shape is mirrored **locally** (`./telemetry.ts`), structurally matching `@plurnk/plurnk-grammar`'s `TelemetryEvent.json`, so the framework keeps zero grammar dependency (§11). Consumers route provider events through the same `source`+`kind` discriminator as parse/rail events.

## §13 Grammar-constrained sampling (GBNF)

`@plurnk/plurnk-grammar` ships `@plurnk/plurnk-grammar/plurnk.gbnf` — a generated llama.cpp grammar constraining sampling to the canonical plurnk form. Ownership splits three ways:

- **plurnk-grammar** owns the artifact (canonical-form GBNF, `L(GBNF) ⊂ L(ANTLR)` invariant, tests).
- **This layer** owns capability detection, transport, **and enforcement verification**: `generate({ …, grammar })` attaches the string **verbatim** as the `grammar` body field when the backend supports it, sends no grammar-related field otherwise (cloud APIs reject unknown params), and — when it did transport a grammar — checks that the response actually conforms. The provider never chooses or modifies the grammar.
- **The consumer** owns policy: whether to constrain a given call, and which root variant to send (e.g. the `root ::= statement` single-statement substitution that forces EOS at the close tag — the shipped `statement+` root never forces EOS, so greedy generation runs to `max_tokens`).

**Sampling guard.** Greedy decoding under hard constraint degenerates into repetition loops without a penalty floor, so `OpenAICompatProvider` sends a per-request `1.15` floor alongside **every** attached grammar — never relying on server launch flags. The wire field differs by style: `repeat_penalty` on `llamacpp`, `repetition_penalty` on `response_format` (the OpenAI-compat spelling; verified honored on Fireworks, #20). (Probed live on llama.cpp b894 + gemma-4-26B; reference: plurnk-grammar `test/llama/gbnf-live.test.ts`.)

**The cap is the consumer's required guard.** The repeat-penalty floor suppresses short repetition cycles, NOT long-cycle degeneration: under the multi-op root (optional EOS) at near-greedy temperatures, a constrained emission can answer correctly in its first tokens and then loop to the **context wall** (observed live: 30,736 junk tokens to `finish_reason: length`, minutes of decode reading as a "hang", with the junk echoed into the next turn's prompt — providers#10). No layer defaults a cap: the wire default is unbounded (`n_predict: -1`) and the provider transports policy, never invents it. A consumer enabling constrained sampling MUST pass `maxTokens` (or send a root variant that forces EOS).

**Native reasoning and the grammar are mutually exclusive; in-DSL reasoning is the working pattern.** The GBNF masks every sampled token. With NATIVE thinking live (llama-server's own `--reasoning-budget` default, or `enable_thinking: true`), the server auto-gates the grammar past the think block — reasoning flows free — but content-channel enforcement then **leaks** (unconstrained prose, degenerates) or content never arrives; explicit `grammar_lazy`/`grammar_triggers` are ignored on the chat-completions path. The constrained configuration therefore requires the native channel **explicitly closed** — `PLURNK_PROVIDERS_THINKING=off`, which the `template` style emits as `enable_thinking: false`; mere field omission leaves the server default live, and think-inviting tasks then break the loop. With the channel closed, the model reasons **inside the DSL**: the canonical grammar's required `PLAN` statement is a free-text body the model fills with genuine step-by-step reasoning before acting (probed live, b894+gemma: correct chain-of-thought inside `<<PLAN:…:PLAN`, then a clean `SEND`, `finish_reason: stop`). The `PLAN` element belongs to the consumer's grammar contract; the provider's only job is closing the native channel deterministically.

**Grammar transport — same GBNF, different wire shapes (`grammarStyle`, default `"none"`).** Backends carry the *same* grammar string differently:
- **`"llamacpp"`** — top-level `grammar` field + the repeat-penalty floor (`PLURNK_PROVIDERS_REPEAT_PENALTY`, §9). Detected from the §11 probe: only llama-server rows on `GET /v1/models` carry a `meta` block. This is any local llama-server (e.g. the generic `openai` provider fronting llama.cpp). `plurnk` opts out via `detectLlamaServer: false` — it reads a window but is treated as a plain OpenAI endpoint, never fingerprinted and never sent a grammar.
- **`"response_format"`** — `response_format: { type: "grammar", grammar }` **+ the repeat-penalty floor (`PLURNK_PROVIDERS_REPEAT_PENALTY`, canonical 1.15)** (the OpenAI-compat spelling). **Fireworks** (set statically, `grammarStyle: "response_format"`). Verified live: a forcing grammar constrains the output, and `repetition_penalty` is honored (#20). ⚠️ Fireworks' *streamed* response mislabels grammar-constrained output as `reasoning_content`, so `generate` drops streaming **for that request only** when a grammar is attached under `response_format` — the non-streamed JSON returns it as `content` (the contract is atomic either way). Grammarless calls on the same provider still stream. Live-confirmed on `deepseek-v4-flash`/`-pro`.
- **`"none"`** — the grammar is **not sent** (never silently — a constrained consumer must not mistake unconstrained output for enforced).

vLLM/Deepinfra was probed and does **not** expose working GBNF over its OpenAI-compat surface (`guided_grammar` silently ignored; `response_format` accepts only `'text'`) — deliberately left `"none"`. Bespoke siblings opt in via config when their backend qualifies. Capability stays provider-internal.

**Enforcement verification (the response side).** Transporting the grammar is necessary but not sufficient — a backend can silently drop the `grammar` field, mislabel the constrained channel (the Fireworks `reasoning_content` case above), or leak unconstrained prose. So when `generate` *did* transport a grammar (`grammarStyle !== "none"`), it validates the returned `content` against that grammar with **`@plurnk/gbnf`** — a zero-dependency, faithful TypeScript port of llama.cpp's own grammar engine, differentially tested against the compiled C validator, hence authoritative for the `llamacpp` path. (This is `@plurnk/gbnf`, the generic GBNF *validator* — **not** `@plurnk/plurnk-grammar`, the plurnk artifact + parser the framework still never depends on; §11.) The check is a grammar-**conformance** test against a string the provider already holds, carrying zero plurnk-DSL semantics, so it does not breach §7/§8 (no `content`→`PlurnkStatement[]` parse).

- **Observed, never adjudicated.** Any non-`accept` verdict — a `reject` (a code point the grammar forbids) or an `incomplete` (a valid prefix that never reached a terminal state) — attaches a `grammar_unenforced` telemetry event to the returned response, message naming the divergence and `position` carrying its code-point offset. The bytes and usage flow regardless; policy is the consumer's.
- **Verify gap is non-fatal.** If the validator cannot even parse the grammar the backend accepted (a port-vs-llama.cpp divergence), `generate` does **not** fail a transport that may have worked — it skips the check and emits a `process` warning (`code: "PLURNK_GRAMMAR_UNVERIFIABLE"`). That gap is a validator bug to fix, not a backend failure.

**Debug mode — diagnose grammar/model conflicts unconstrained (`PLURNK_PROVIDERS_GBNF_DEBUG`).** An optional, off-by-default toggle (`0`/empty = off; any other value = on; the standard-provider config field is `gbnfDebug`). When on and a grammar would be transported, `generate` first validates it with `@plurnk/gbnf` **before any wire call** and **throws fail-hard on a malformed grammar**; it then **withholds** the grammar so the model generates **unconstrained** — and runs that free output back through the grammar to locate the exact code point where the model's natural output diverges.

Crucially, this path does **NOT throw** (#24). Non-conformance is *expected* here — the model ran free — so a throw would discard the very bytes you're debugging (and, in a service loop, collapse the turn to empty and cascade). Instead `generate` **returns normally**: the model's emission rides the response (`assistant.content` + `assistant.reasoning`, both channels intact), and the conflict is attached as a **non-fatal `grammar_unenforced` `TelemetryEvent`** in `ProviderResponse.telemetry`, carrying the divergence `position` (a code-point offset into `content`). The consumer renders the model its own emission around `position` — the same self-correction affordance it already gives plurnk-DSL parse errors — instead of looping on a description it can't act on. A `SEND[200]` the grammar's `no200` rule forbids, or a `</think>` the committed-`PLAN` region rejects, surfaces as data the model can fix, not an exception that erases the turn. (Contrast the **constrained** path above, which still throws: there the backend was *told* to enforce and didn't — a hard failure.) Withholding-without-verifying would be indistinguishable from sending no grammar at all — the verification is the point. Leave it off in production, where a constrained call should actually constrain.

Zero grammar dependency (§11) is preserved: the GBNF string arrives per call; this package never imports the artifact.

## §14 Data capture — logprobs + verbatim body (#36)

Two OPT-IN knobs surface the full signal of a paid turn for downstream IQ scoring and model distillation. Both are **OFF by default** and **per-alias-scopable** (`PLURNK_PROVIDERS_<KNOB>_<alias>`): the flag *is* the isolation, so a serving turn requests nothing on the wire and carries nothing on the response — only a dataset-scraping alias opts in. Universal: any provider (standard or daughter), any backend that returns the data.

**`PLURNK_PROVIDERS_LOGPROB`** (non-negative int = `top_logprobs`; unset = off). When set, `generate` requests `logprobs:true, top_logprobs:<n>` and surfaces `response.assistant.logprobs: Array<{ token, logprob, top? }>` plus `assistant.meanLogprob`. These are **managed fields** — reserved from caller `sampling`, so the env flag is the single control (a proxy consumer can't forge them). A backend that returns no logprobs yields an absent field — **never synthesized**.

**The `logprob` vs `sampling_logprob` decision (the honest-confidence call).** Fireworks returns both per token: `logprob` (raw model log-probability) and `sampling_logprob` (post-sampling-transform). The structured `logprob` we surface is the **raw** value — the sampling-transform-invariant measure of the model's native belief, the correct confidence signal AND distillation target. This was settled empirically, not by assumption: under grammar the two measured **identical to full float precision**, including an *adversarial* mask (grammar forcing a token the model assigned ~8%: `logprob` −2.5229365 == `sampling_logprob` −2.5229365). A post-mask renormalization would inflate confidence toward the constraint; the raw value stays honest. Anyone wanting `sampling_logprob` reads it from `rawBody`.

**`PLURNK_PROVIDERS_RAWBODY`** (truthy = on). When on, `response.rawBody` carries the **verbatim** backend body — the full wire JSON for a non-streamed turn (exact; grammar turns already run non-streamed), or the reassembled equivalent for a streamed one. `assistantRaw` remains the normalized **digest** (it drops `choices[]`); `rawBody` is the capture-everything record that keeps `sampling_logprob`, `token_id`, `bytes`, and any backend-specific per-token fields. Off by default so serving turns never pay the retention cost.
