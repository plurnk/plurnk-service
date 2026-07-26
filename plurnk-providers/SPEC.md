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
    readonly contextWindow: number | null;  // context tokens, null if unresolved.
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
    calculateCost(usage: ProviderUsage): number;  // estimated USD

    // OPTIONAL capability: exact tokenization served by the backend's own vocab
    // (llama-server /tokenize). Probe-gated — undefined means the backend can't.
    tokenize?(text: string): Promise<number[]>;

    // OPTIONAL resolved capabilities — introspectable facts for boot-time policy:
    // constrainsOutput (#34): a transported grammar WILL constrain this decode
    //   (rails live) — consumers fail hard on a dark-rails boot instead of
    //   discovering it from unconstrained emissions.
    // requiresMaxTokens (#43): this backend decodes UNBOUNDED absent a caller cap
    //   (llama-server honors n_predict to the context wall, providers#10) — a
    //   consumer MUST bring an output envelope (§13), and can refuse AT BOOT a
    //   local alias whose envelope was never declared. Self-clamping cloud
    //   backends never set it; undefined = no claim.
    readonly constrainsOutput?: boolean;
    readonly requiresMaxTokens?: boolean;
    // #507 (owner-ruled): generation-envelope reserves derived from the DETECTED
    // window (floor percentages; absolute per-alias pins win outright). null =
    // underivable -> the consumer's no-cap path. The consumer's prompt budget is
    // window - reasoningReserve - completionReserve - its OWN safety margin;
    // its generation cap is the two reserves pooled. Absent = no claim.
    readonly reasoningReserve?: number | null;
    readonly completionReserve?: number | null;

    // Transport. `workerId` is REQUIRED: the opaque, stable identity of the
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
    // slot always win, and reserved keys are stripped (#477): transport/protocol
    // (stream, response_format, grammar, id_slot, logprobs), paradigm breakers
    // (n, the tools/functions family, modalities/audio, prediction), and the
    // token caps (max_tokens/max_completion_tokens -- the envelope is the managed
    // maxTokens, never bypassable). It carries sampling intent + platform knobs
    // only (§8). For a PROXY consumer forwarding its own
    // caller's sampling knobs (the plurnk endpoint fronting gemma/Fireworks); a
    // direct consumer leaves it unset.
    // `strikes` is the worker's CURRENT rail-strike streak at time-of-generate
    // (0 = clean, distinct from absent = unreported; contract plurnk-service#313).
    // Forwarded as `Plurnk-Strikes` ONLY under the firstPartyMetadata gate,
    // dropped everywhere else. Headers only — never placed in the packet.
    // `workspaceId`/`loop`/`turn` (#404): the turn coordinate, stamped as
    // `Plurnk-Workspace-Id`/`Plurnk-Loop`/`Plurnk-Turn` under the SAME gate.
    // 1-based; absent/0 emits no header. Headers only, never the packet.
    // `primaryWorkerId` (#522): the ROOT worker of this turn's lineage (the
    // no-parent ancestor the worker tree descends from) — a worker id, stamped as
    // `Plurnk-Worker-Primary` under the SAME gate. Lets a consumer classify
    // root-vs-descendant by equality (`primaryWorkerId == workerId` ⇒ the primary
    // worker) and group a worker tree by its root, for telemetry/analytics. The
    // provider EMITS what the consumer supplies and never invents a primary; the
    // consumer's contract is to supply it every turn (including the primary's own,
    // where it equals workerId). Absent emits no header.
    generate(args: { messages: ChatMessage[]; workerId: string; primaryWorkerId?: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; workspaceId?: string; loop?: number; turn?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse>;
}

interface ProviderResponse {
    assistant: {
        content: string;            // raw model emission; consumer parses
        reasoning: string | null;   // wire-reported reasoning content; null if absent
        // sealed relay reasoning (#482): items { id, subtype, encrypted:
        // [{data, format}] } verbatim, never decoded; `id` from the wire,
        // `subtype` from wire position (message-attached; plurnk is tools-in-body
        // so it is constant). Absent when none. agui projects REASONING_ENCRYPTED_VALUE.
        reasoningEncrypted?: Array<{ id: string | null; subtype: string; encrypted: Array<{ data: string; format: string | null }> }>;
        usage: ProviderUsage;       // { prompt, completion, reasoning, cached, total }
        finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
        model: string;              // wire-reported (may differ from requested for relay providers)
    };
    assistantRaw: unknown;          // verbatim wire response for forensics
    meta?: Record<string, unknown>; // verbatim per-turn provider metadata; absent when empty (#23)
}

interface ProviderUsage {
    prompt: number;       // input tokens (cached ones included)
    completion: number;   // visible output tokens, EXCLUDING reasoning
    reasoning: number;    // reasoning tokens, billed as output
    cached: number;       // subset of prompt served from cache
    total: number;        // prompt + completion + reasoning
}
```

Usage invariant: `total = prompt + completion + reasoning`; `cached ⊆ prompt`; `completion` excludes reasoning; **billable output = `completion + reasoning`**. Providers report reasoning THREE ways: inside `completion_tokens` (OpenAI, via `completion_tokens_details.reasoning_tokens`), only as the `total - prompt - completion` gap (Gemini), or folded into `completion_tokens` with NO itemization while shipping the reasoning as TEXT (Fireworks, #425). The AI SDK parses the wire usage; PLURNK's result mapper applies `normalizeUsage` (§11) to preserve this stricter invariant, including the sum-preserving Fireworks text split.

### OpenAI-compatible request execution

The Vercel AI SDK's OpenAI-compatible provider owns HTTP execution, SSE parsing,
standard request and response fields, retries, cancellation, timeouts, standard
reasoning channels, finish-reason extraction, usage parsing, and typed HTTP
failures. PLURNK does not maintain parallel implementations of those general
transport concerns. Its result mapper retains the stricter usage invariant,
finish-reason vocabulary, and evidence fields described by this contract.

`OpenAICompatConfig.fetch?: typeof globalThis.fetch` selects request execution
for one provider instance. When omitted, the AI SDK uses `globalThis.fetch`.
A platform or vendor binding adapter belongs to its consuming integration and
returns a standards-compatible `Response`.

PLURNK retains only product-specific policy at this boundary: managed grammar
and sampler extensions, worker affinity, first-party headers, GBNF conformance
observation, exact-tokenization probes, and conversion from AI SDK results into
the stable `ProviderResponse` interface. Provider-specific request extensions
ride the AI SDK provider-options mechanism; raw chunks and provider metadata are
preserved as evidence.

An upstream retry domain MAY return `X-Should-Retry: false` to declare its
failure final. The adapter supplies this fact to the AI SDK's error structure;
the SDK MUST NOT retry that response even when its status would ordinarily be
retryable. This prevents nested retry domains from multiplying attempts.
The small Zod schema at this adapter seam exists because
`ProviderErrorStructure` requires it. It is not PLURNK's validation architecture;
JSON Schema and the grammar remain authoritative for PLURNK-owned contracts.

The `@plurnk/plurnk-providers/openai` subpath is the runtime-neutral import
surface for this contract. Its transitive module graph MUST NOT import provider
discovery, registries, filesystem access, or environment-owned construction.
The package root remains the Node daemon integration surface.

### Promises

- `assistant.content` is the **verbatim** model emission. Consumer parses via `@plurnk/plurnk-grammar` — providers MUST NOT parse. plurnk uses a **tools-in-body** design: tool invocations are expressed as plurnk DSL *inside the message content*, never via a provider's native tool-calling API, so `content` is always raw text and providers never request, parse, or translate native tool calls.[^tools]

[^tools]: A provider that wants to drive native tool-calling (OpenAI `tool_calls`, Anthropic `tool_use`) would have to normalize those emissions back into a plurnk DSL string at the boundary. No provider does this and it is out of scope for v0 — tools-in-body sidesteps the whole problem. The clause is recorded only so a future native-tools mode has a defined contract.
- `assistant.usage` is authoritative and follows the invariant above. Fill `0`s when the wire response omits a breakdown.
- `countTokens` is **synchronous**, returns a non-negative integer, deterministic for the same input. Without an exact tokenizer family configured it is the **chars/2 UPPER BOUND** — deliberately conservative (real agentic text measures ~2.9–3.2 chars/token on gemma/deepseek, so the former chars/4 silently UNDERcounted 20–27%; a fallback may overcount, never under) — and it is **surfaced at construction** (`process.emitWarning`, code `PLURNK_TOKENIZER_HEURISTIC`), never silent. Exact counting is the tokenizer seam's job (mimetypes family), fed by `tokenize()` where available.
- `tokenize?` is an **optional async capability**: token ids in the model's real vocabulary, served by the backend itself (llama-server's native root `/tokenize`, surfaced when the §11 probe fingerprints a llama-server and `detectLlamaServer` isn't false). `tokenize === undefined` is the honest "backend can't" signal. Exact-counting consumers prefer it over any client-side tokenizer data — the local model's own vocab needs no bundled `tokenizer.json` at all.
- `calculateCost` is **pure** and returns a finite, non-negative USD number. Returns `0` for siblings with no known rates (local Ollama, generic OpenAI-compat shims).
- `contextWindow` resolves to `null` when a PROBING provider (openai/llama-server) can't determine the window (consumer treats null as "no budget info"); a CLOUD provider with no window source FAILS HARD instead (#419, §11).
- `generate` rejects on signal abort — does NOT resolve with partial content.
- `generate` transports `grammar` verbatim when the backend supports grammar-constrained sampling, and silently ignores it otherwise (§13). The provider never chooses or modifies the grammar.
- `generate` **returns for every completed exchange — bytes always present, the conformance verdict attached as an observation.** When a grammar was transported (or validated in filter mode), the returned `content` is checked against it; a non-accept verdict rides `response.telemetry` as a `grammar_unenforced` event (message + divergence `position`) and the response returns normally. The provider transports and observes; it never adjudicates — discard, retry, escalate, or feed-back is consumer policy. This is a grammar-**conformance** check against the grammar the provider already holds — *not* a plurnk-DSL parse (that stays consumer-side, below) — so it remains backend- and DSL-agnostic. `ProviderError` remains reserved for exchanges that did NOT complete (transport failure, abort, boundary violations).
- **Backend affinity is the provider's internal guarantee, keyed by `workerId`.** The consumer says *which run this is*, never *which backend resource serves it* — raw resource identifiers (slot integers, connections) never cross the contract in either direction. On slot-pinning backends (llama-server `--parallel N>1`), the provider keeps each worker sticky to one slot and spreads distinct runs across slots, so each concurrent run keeps its KV-cache prefix warm (un-pinned routing is the server's similarity heuristic — slot hops re-pay full prefills). Backends without affinity semantics ignore `workerId` entirely.

## §3 `fromEnv(env, model, options?)` factory

Default export MUST have a static `fromEnv(env, model, options?)` factory:

```ts
class OpenAI {
    static fromEnv(env: NodeJS.ProcessEnv, model: string, options?: ProviderOptions): OpenAI | Promise<OpenAI> {
        // Read provider-specific env (OPENAI_BASE_URL, OPENAI_API_KEY, ...)
        // plus universal operator knobs (PLURNK_PROVIDERS_REASONING, PLURNK_PROVIDERS_FETCH_TIMEOUT,
        // PLURNK_PROVIDERS_CONTEXT_WINDOW). `options.baseUrl`, when set, is the per-alias
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

Defaults use four evidence states:

- **Measured** — a controlled behavioral experiment demonstrates the parameter's
  effect on the relevant endpoint and model family.
- **Documented** — the provider's primary documentation defines the parameter and
  its semantics.
- **Accepted** — a live request carrying the parameter succeeds. This proves wire
  compatibility only; an endpoint may accept and ignore a field.
- **Unknown** — neither semantics nor compatibility are established.

Measured evidence outranks documented evidence when they conflict. A portable
nonzero tuning default requires measured or documented semantics that actually
generalize across its scope. Accepted evidence permits transport but never
justifies a magnitude. PLURNK does not maintain a provider-characterization
harness; upstream provider contracts and focused regression specimens own that
knowledge.

Each provider's `fromEnv` reads these:

- **`PLURNK_PROVIDERS_REASONING`** — REQUIRED, one of `off | adaptive | on`. **`PLURNK_PROVIDERS_REASONING_BUDGET`** is a positive integer required when reasoning is `on`. The provider maps this intent to the backend's supported controls. Backends may omit, combine, or expose reasoning differently when grammar-constrained output is enabled; the provider reports the channels it actually receives rather than synthesizing a separate reasoning channel. `max_tokens` remains an output limit, not a reasoning budget. The model-facing `PLAN` operation is part of the grammar and is independent of provider reasoning controls.

Read via `reasoningFromEnv` and **fail hard when unset**: the budget is required only when `on` and carries no floor default. Configuration lives in the operator's env over the package's `.env.defaults` floor (which declares every var and ships its default); the framework never bakes a knob default into code.
- **`PLURNK_PROVIDERS_FETCH_TIMEOUT`** — REQUIRED non-negative milliseconds from the shipped floor; the AI SDK's total deadline for one provider execution. The caller's earlier abort still wins. Per-provider override envs are NOT part of the contract.
- **`PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT`** — REQUIRED non-negative milliseconds from the shipped floor; the AI SDK's maximum silence between streamed response-body chunks. `0` disables the chunk deadline. The portable default is `0`: slow local inference may legitimately pause for minutes, so a nonzero deadline is a measured per-alias deployment policy, not a universal provider assumption. Once a streamed exchange has started, a chunk timeout fails that exchange without replaying its partial output.
- **`PLURNK_PROVIDERS_RETRY_ATTEMPTS`** — REQUIRED non-negative integer (read via `parseRequiredInt`) passed to the AI SDK as `maxRetries`. **`0`** surfaces the first request failure; **`N`** permits up to `N` SDK retries for request-level failures under its standard status policy (408, 409, 429, and 5xx). `Retry-After` and SDK backoff policy remain SDK-owned. PLURNK's error structure additionally makes edge statuses 520–527 final and honors `X-Should-Retry: false` from an upstream retry domain. A 422 `grammar_invalid` and a failure after streamed bytes are completed exchanges from the transport's perspective and are not replayed here; the engine owns any decision to start another model exchange.
- **`PLURNK_PROVIDERS_CONTEXT_WINDOW`** -- optional positive-integer override (alias-scopable) for the model's context window. Resolution (#419): this env var -> endpoint `n_ctx` probe (probing specs only) -> `@plurnk/plurnk-models` catalog -> then a PROBING provider degrades to `null`, a CLOUD provider (no probe) FAILS HARD (an uncataloged, unpinned cloud model is a config error, not a guessable window). See §11.
- **`PLURNK_PROVIDERS_REASONING_RESERVE` / `PLURNK_PROVIDERS_COMPLETION_RESERVE`** (#507, owner-ruled) -- the generation-envelope reserves, REQUIRED (floor ships `10%` / `25%`). A percentage derives from the DETECTED window (llama-server n_ctx, the plurnk.ai router, the catalog) so every advertising endpoint gets sane defaults with ZERO operator tuning; an absolute token count wins outright (per-alias-scopable -- the measured-envelope override). These MIGRATED from core's `PLURNK_SERVICE_{CONTEXT_WINDOW,REASONING,COMPLETION}` (provider quantities wearing a service prefix; core keeps only its own packing-safety margin). Surfaced as `Provider.reasoningReserve`/`completionReserve`.
- **`PLURNK_PROVIDERS_TEMPERATURE` / `PLURNK_PROVIDERS_REPEAT_PENALTY` / `PLURNK_PROVIDERS_FREQUENCY_PENALTY`** -- REQUIRED sampling controls (read via `parseRequiredFloat`, values from the `.env.defaults` floor). `REPEAT_PENALTY` (canonical `1.15`) is the measured llama.cpp multiplier. `FREQUENCY_PENALTY` is the optional cloud analogue, but its portable floor is `0`: endpoint acceptance proves only that the field may ride, not that one magnitude has a portable semantic effect. Enable it per alias from provider documentation or controlled behavioral evidence. The controls are keyed per backend (§13).
- **`PLURNK_PROVIDERS_SERVICE_TIER`** -- optional fixed request tier, alias-scopable. Fireworks accepts its published `auto | default | flex | priority` vocabulary and owns those values' routing semantics; when configured, the value is validated at construction and wins over per-call sampling on every request. Unset delegates to the provider default. Other standard providers reject the knob rather than silently ignoring a paid routing choice.
- **`PLURNK_PROVIDERS_DRY_MULTIPLIER` / `_DRY_BASE` / `_DRY_ALLOWED_LENGTH`** -- the llama.cpp DRY loop-breaker (#567), customer-overridable per alias. The generic floor is deliberately **off** (`MULTIPLIER=0`): the turboderp/Gemma sweep proved the community-standard `0.8`/`1.75`/`2` settings worse than off for both runaway emissions and exact-identifier corruption. That same sweep measured `0.8`/`1.75`/`32` as a safe alias-specific deployment setting (zero corruption, about 6% runaways versus 19% off), so `.env.defaults` carries `BASE=1.75` and `ALLOWED_LENGTH=32` as inert override companions without pretending one model's multiplier is universal. DRY penalizes repeated sequences with a penalty escalating in run length -- the tool for a plan-restart loop a single-token `repeat_penalty` over a short window cannot see. **`PLURNK_PROVIDERS_REPEAT_LAST_N`** (optional) widens the older `repeat_penalty` window past the box's 64. These knobs are sent **only on the detected `llamacpp` path**; cloud providers parse but never emit them.

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

Each alias instantiates against its own URL and probes its own box (openai's `n_ctx`/slots, ollama's `/api/show`). The override threads through the alias → `instantiateProvider` → both tiers; on the tier-2 (plugin) path it arrives as the third `fromEnv(env, model, { baseUrl })` argument (a factory that ignores it is unaffected). A `PLURNK_BASEURL_*` with no matching alias **fails hard** (a typo, not a silent no-op). It's accepted for *any* provider but only meaningful for the self-hosted ones; the hosted providers (`groq`, `fireworks`, …) carry a canonical endpoint you'd never multi-home.

This package's exported resolution surface:

- `parseAliasesFromEnv(env)` — extracts alias entries.
- `resolveActiveAlias(env)` — `{ alias, provider, model } | null`.
- `instantiateProvider(name, env, model)` — full two-tier resolution (below).
- `loadActiveProvider(env)` — boot convenience: active alias → `instantiateProvider`.
- `standardProviderFromEnv(name, env, model)` / `isStandardProvider(name)` — the tier-1 internals, still exported.
- `discover({ cwd?, packageDirs?, env? })` — the tier-2 scan: a `Discovery` (`{ registry, skipped, attributions }`) of every installed provider package. `registry`/`skipped` are `Map<name, packageSpecifier>` partitioned by the trust gate; `attributions` is `Map<name, string | string[]>` carrying each registered provider's raw `plurnk.attribution` for author credit (#21 — surfaced verbatim; the consumer applies the `@plurnk/`-scope reservation policy). Exported so a consumer can enumerate trusted providers — and see which were declined — without instantiating them.

**Two-tier provider resolution — owned entirely by this package.** A provider name resolves in this order:

1. **Standard provider** (`§11`) — if `isStandardProvider(name)`, instantiated directly via `standardProviderFromEnv(name, env, model)`. No package is imported. Covers every plain OpenAI-compatible endpoint (`openai`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `deepinfra`, `anthropic`, `bedrock`, `plurnk`, …) — including first-party Claude (Anthropic's compat endpoint, bearer auth, the `thinking` reasoning param), AWS Bedrock (its compat endpoint at the `/openai/v1` path, Bedrock-API-key bearer; the base is `BEDROCK_BASE_URL` if set, else derived as `https://bedrock-runtime.{region}.amazonaws.com/openai/v1` from the standard `AWS_REGION`/`AWS_DEFAULT_REGION`; its inference-profile model ids resolve a catalog **context window** by stripping the region and looking the model up under its publisher (#22), while cost stays unknown — bedrock marks up over the native rate), and the **`plurnk` hosted model** (a plain remote OpenAI endpoint at its `PLURNK_BASE_URL` base, `.env.defaults` → `https://plurnk.ai/v1`; reads its server-controlled context window from upstream, sends no grammar and no tuning -- `suppressTuningFloors` drops the client temperature/penalty floors so the router's per-model tuning is never overridden (#507); caller `sampling` still passes); none needs a plugin. `plurnk` authenticates with a single optional bearer (`PLURNK_API_KEY`, sent only when set), like any other standard bearer. A spec's `apiKeyVar`/`baseUrlVar` may be a **list** of accepted env-var aliases — the conventional names the wild uses for one credential/base (e.g. `deepinfra` → `DEEPINFRA_API_KEY` / `DEEPINFRA_API_TOKEN` / `DEEPINFRA_TOKEN`; `openai` base → `OPENAI_BASE_URL` / `OPENAI_API_BASE`). First set non-empty wins; a required key unset across *all* aliases fails hard naming each. This is alias resolution over operator-set values, never a fabricated default. (An entry MAY instead supply a custom `headersFromEnv` builder for auth a bearer can't express — multi-header/credential schemes — or a `baseUrlFromEnv` builder to template the base from env, as bedrock does.) The standard table is **authoritative**: a scanned package whose name duplicates a standard one is shadowed (tier 1 returns first).
2. **Discovered package** — otherwise, a **scope-agnostic `node_modules` scan** (`discover()`) maps the provider name to the installed package that declares `plurnk: { kind: "provider", name }`, which is dynamic-imported and `fromEnv(env, model, options?)`-called. Covers first-party plugins with real runtime surface (`openrouter`, `ollama`, `google`, `xai`, `cloudflare`, the planned `vertex`/`cohere`) **and any third-party provider published under its own scope** (`@acme/llm-provider-foo`) — no involvement from us, no `@plurnk` scope assumption. Two installed packages claiming the same name → fail-hard naming both. Unknown name → fail-hard. The scan runs once per process and is memoized.

   Discovery honors the host **trust gate** `PLURNK_PLUGINS_TRUSTED_ONLY` — the same env var the execs/mimes/schemes families read (plurnk-service#229, #15). OFF (unset/empty/`0`) trusts every installed provider; ON (any value) trusts `@plurnk/*` plus a comma-separated allowlist and declines the rest. A declined package is recorded in `skipped` (never registered, never thrown), so requesting its name yields a precise *untrusted* error rather than *unknown*.

The framework is **contract-only**: it does not depend on provider plugins. The daemon declares its bundled providers as ordinary direct dependencies, and operators install additional providers at the application root so Node's package resolution and the scope-agnostic scan can find them. Provider plugins declare the framework as a peer dependency using the repository's normal same-minor compatibility range; this preserves one shared contract instance without coupling a plugin release to every framework patch.

## §6 Engine → provider guarantees (consumer side)

- `messages` is a complete prompt. Consumer has pre-assembled all sections. Provider does not add, reorder, or inject turns — the wire `messages` are exactly what the consumer passed. (The provider injects no `PLAN` turn — `PLAN` is part of the consumer's grammar contract, §4.)
- Every `generate` carries `workerId` — the worker's stable, opaque identity. Same run → same string across its turns; distinct runs → distinct strings.
- `signal` is wired to the worker's AbortController.
- `generate` is single-call per turn. No parallel calls on the same instance.
- `assistantRaw` is opaque to the consumer (forensics-only).
- `meta` is the per-turn provider→client metadata bag: the backend's non-standard top-level response fields pass through verbatim. Monetary metadata carries an explicit decimal-string `amount` and `currency`; the provider never guesses or converts its unit. Absent when the backend reported no extras. The consumer (service) merges `meta` into its Turn metadata and filters what reaches the client; it reads `meta`, never mines `assistantRaw` (#23).
- `countTokens` is cheap by contract; consumer calls frequently.

## §7 Provider → engine guarantees

- **No DB access.** Provider never touches `node:sqlite` or storage layers.
- **No service access.** No imports from `@plurnk/plurnk-service`.
- **No grammar runtime dep.** Type-imports from `@plurnk/plurnk-grammar` are fine; invoking `PlurnkParser.parse` is consumer-side.
- **Raw `content`.** Returned verbatim. Tools are expressed in-body as plurnk DSL (see §2); providers do not use native tool-calling.
- **Atomic.** One `generate` call resolves with one complete `ProviderResponse`. No streaming partial resolves (v0).
- **Honors `signal`.** Aborted calls reject; resources free; no orphaned connections.
- **Single model.** One provider instance speaks to one model.
- **Synchronous `countTokens`, pure `calculateCost`.** No I/O, no async, no state beyond cached tokenizer artifacts.

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
    contextWindow: 100000,
    responses: [{ assistant: { content: "<<SEND[200]:hi:SEND", reasoning: null } }],
});
const result = await mock.generate({ messages: [] });
```

`MockResponse.assistant.ops?: unknown[]` is a pre-parsed escape hatch consumed by plurnk-service intg tests (skips parse roundtrip); the consumer casts to `PlurnkStatement[]` on its side. It is typed `unknown[]` deliberately so **this package has no dependency on `@plurnk/plurnk-grammar` at all** — not runtime, not peer, not even a type import — so grammar releases never force a providers re-pin. Production providers don't expose `ops`.

## §10 Conformance

A sibling package satisfies the contract when:

1. Default export is a class with `static fromEnv(env, model, options?)` factory.
2. Instance exposes `contextWindow: number | null` and `model: string` (non-empty).
3. Instance exposes `countTokens(text): number` and `calculateCost(usage): number`.
4. `countTokens("")` returns `0`; `countTokens("…")` returns a non-negative integer.
5. `calculateCost({prompt:0,completion:0,reasoning:0,cached:0,total:0})` returns `0` (or non-negative USD for non-free models).
6. Identity getters return stable values across reads.
7. `generate` resolves with a valid `ProviderResponse` shape.
8. `generate` invoked with a pre-aborted `signal` rejects without making a wire call.
9. `generate` invoked, then aborted mid-flight rejects within ≤5s; no connection leak.
10. `assistantRaw` is present (any value, including `null`).
11. No DB access, no imports from `@plurnk/plurnk-service`.
12. No runtime import of `@plurnk/plurnk-grammar` parser entry points.
13. `generate` invoked with `grammar` against a backend without grammar support sends no grammar-related wire fields and does not error (§13).
14. `generate` that transported a grammar ALWAYS resolves with the bytes; non-conforming output (reject or incomplete) attaches a `grammar_unenforced` `TelemetryEvent` on `response.telemetry` with the divergence position — an observation, never a throw (#24, §13). (Inherited from `OpenAICompatProvider`; bespoke siblings on a non-compat transport implement it.)

Sibling-specific behavioral tests (wire-format compliance, model-family quirks, retry logic) live in each package's own test surface.

## §11 Shared OpenAI-compatible machinery

The framework ships the transport spine every OpenAI-compatible provider had been duplicating. Build a sibling *on top of these* — don't re-implement them.

- **`OpenAICompatProvider`** — a `Provider` implementation built by composition. Its `generate` does the universal work (merge `signal` with a `PLURNK_PROVIDERS_FETCH_TIMEOUT` deadline, stream the completion, map `usage`, normalize `finishReason` to the §2 set (translating known per-backend cap synonyms -- `max_tokens`, `MAX_TOKENS`, ... -> `length` -- so a consumer's `=== "length"` holds across backends, warning once on any unmapped value, #425), assemble the response). Per-provider deltas arrive as config:

  ```ts
  new OpenAICompatProvider({
      model, url,            // fully-resolved chat-completions URL
      fetchTimeoutMs,
      headers,               // fully-resolved request headers (incl. auth)
      contextWindow,           // number | null
      reasoning, reasoningStyle,   // {mode,budget} intent + style: "none"|"think"|"include_reasoning"|"effort"|"effort_explicit"|"template"|"anthropic"
      temperature, repeatPenalty, frequencyPenalty,  // sampling + anti-degeneration floor; frequency_penalty guards the plain cloud path (#426)
      countTokens, calculateCost,  // strategies; default heuristic / free
      grammarStyle,          // "none" | "llamacpp" — optional local GBNF transport (§13)
      gbnfDebug,             // PLURNK_PROVIDERS_GBNF_DEBUG: validate a grammar locally + throw on invalid, but DON'T send it (§13); default false
      streaming,             // SSE transport; default true (false → one non-streamed JSON)
      supportsSlotPinning, slotCount,  // INTERNAL slot-affinity wiring (run→id_slot); never consumer-facing
      topLogprobs, rawBody,  // #36 opt-in data capture (PLURNK_PROVIDERS_TOP_LOGPROBS / _RAWBODY); default off
      servedModel,           // #37 backend's self-reported served id (from the probe) → Provider.servedModel
  });
  ```

  The `openai` standard provider sets `grammarStyle: "llamacpp"`, `supportsSlotPinning`, and `slotCount` from the same llama-server fingerprint (`/v1/models` `meta` block + `/props`). The worker→slot mapping lives inside `OpenAICompatProvider`: sticky per `workerId`, round-robin across new runs, LRU-bounded.

- **`executeOpenAICompatible`** — the narrow adapter from PLURNK's stable provider contract to the AI SDK's OpenAI-compatible provider. It preserves PLURNK extensions and evidence while delegating generic transport behavior to the SDK.
- **`normalizeUsage(raw, reasoningText?, contentText?)` / `calculateCostUsd(usage, rates)`** — result mapping to the §2 invariant (handles all three reasoning-reporting conventions; the optional text args feed the Fireworks re-split, #425) and the single cost formula. Rates use the Models.dev convention of USD per million tokens; billable output is `completion + reasoning`. The AI SDK adapter applies `normalizeUsage` after parsing the wire usage; provider instances expose `calculateCost(usage)`.
- **`parseRequiredInt` / `parseOptionalInt` / `requireEnv`** — env helpers; each takes a provider `label` for error prefixing.
- **`effortFromBudget(budget)`** — the shared reasoning-budget → `low|medium|high` breakpoints.

A **bespoke sibling** therefore reduces to a thin class whose `fromEnv` probes whatever it needs (model catalog, pricing, context window), builds the config, and returns `new OpenAICompatProvider(config)`. A **standard provider** (§5 tier 1) needs no sibling at all — it's a frozen entry in `STANDARD_PROVIDERS` describing its key var, base-URL var, reasoning style, and tokenizer; `standardProviderFromEnv(name, env, model)` (async — returns `Promise<Provider | null>`) does the rest. The endpoint's **canonical URL ships as a floored default** in `.env.defaults` (set-if-unset, overridable in the operator's env or per-alias); it is read from the base-URL var (or a `baseUrlFromEnv` deriver) with **no in-code default**, the value living in the shipped floor, never baked into the table. Only the API **key** is required operator config (a secret with no default; fail-hard when unset).

The `plurnk` entry alone sets **`firstPartyMetadata: true`** — it forwards the consumer's per-turn `generate()` `attributions` (which installed plugin packages dispatched) and `client` (the originating frontend, e.g. `plurnk.nvim/1.4.0`) as `Plurnk-Attribution` / `Plurnk-Client` headers, and the opaque `workerId` as `Plurnk-Worker-Id` (#26, wire-name completed #511), and the lineage root `primaryWorkerId` as `Plurnk-Worker-Primary` (#522 — root-vs-descendant classification and worker-tree grouping key, always stamped when supplied). The gate lives on the provider, not the call site, so these first-party signals are structurally incapable of reaching a third-party backend. Empty values emit no header. Endpoint response metadata follows the same general pass-through contract as every provider.

**Prompt-cache affinity (`promptCacheKey`, #518).** Standard providers send the OpenAI-standard `prompt_cache_key` set to the `workerId` on every request, **default-ON** (opt out per spec). Serverless backends prompt-cache automatically but the cache is REPLICA-LOCAL; without an affinity key a worker's turns scatter across replicas and the stable prefix never hits (verified live: `cached_tokens` 0 without the key). `workerId` -- already the slot-affinity identity -- is exactly the opaque per-conversation key the cache wants, so a worker's turns pin to one replica and its stable prefix caches. Managed + reserved from caller `sampling`. It's the OpenAI-standard field and broadly accepted -- verified live on fireworks, together, deepinfra, xai, openrouter, and llama-server (6/6, all accept it, every serverless one caches). A backend that caches by a DIFFERENT mechanism opts out (`anthropic`: cache_control breakpoints); a backend later found to strict-reject the field opts out the same way.

A spec may carry a **`modelPrefix`** — a constant model-id segment the backend requires but the operator's alias shouldn't repeat. `fireworks` sets `"accounts/fireworks/models/"`, so `PLURNK_MODEL_fast=fireworks/deepseek-v4-pro` carries only the distinctive tail; `standardProviderFromEnv` prepends it idempotently to form the wire id, which is **also** the catalog key (models.dev keys fireworks-ai on the full id). A fully qualified Fireworks resource under `accounts/fireworks/` is preserved verbatim, including `routers/` and `deployments/`. Specs without a `modelPrefix` use the model string verbatim.

`contextWindow` for a standard provider resolves (#419): `PLURNK_PROVIDERS_CONTEXT_WINDOW` -> endpoint `n_ctx` (for `probeNctx`-flagged specs like `openai`, queried from `GET /v1/models`: llama-server reports its loaded window at `data[].meta.n_ctx`, vLLM top-level; cloud endpoints don't) -> the `@plurnk/plurnk-models` catalog -> **then the hybrid: a PROBING provider degrades to `null`, a CLOUD provider (no probe) FAILS HARD** (uncataloged + unpinned = config error, the #417 kimi case, not a guessed window). The same probe fingerprints llama-server (the `meta` block) to enable grammar transport (§13), and reads the row's `id` as `servedModel` (#37) — the real served name behind a local alias — so it runs even when the env var pins the window. The probe is best-effort: any failure resolves to `null` context / no grammar capability (a legitimate "unknown"), never throws. For a PROBING provider, an underivable window (env, probe, and catalog ALL missed) is surfaced once via a **`PLURNK_CONTEXT_UNKNOWN`** warning naming the model and the remediation (`PLURNK_PROVIDERS_CONTEXT_WINDOW`, alias-scopable) -- null stays legitimate but never silent (a CLOUD provider throws here instead, above). Operator-facing warnings (`PLURNK_TOKENIZER_HEURISTIC`, `PLURNK_PROBE_FAILED`, `PLURNK_GRAMMAR_UNVERIFIABLE`, `PLURNK_CONTEXT_UNKNOWN`, `PLURNK_FINISH_REASON_UNKNOWN`) are deduplicated **once per process per (code, message)** (#40) — repeat constructions don't re-fire them, but a *different* provider/model's first surfacing is never suppressed.

## §12 Telemetry — provider failures

Transport failures surface as a `ProviderError` (extends `Error`, so existing catchers keep working) that carries the plurnk **TelemetryEvent** envelope via `toTelemetryEvent()`:

```ts
{ source: "provider:<vendor>", kind: ProviderTelemetryKind, message: string, position: null }
```

- `source` is `provider:<vendor>` (schema pattern `^[a-z]+(:[a-z][a-z0-9-]*)?$`); standard providers set it from their name, siblings via the `source` config field (default `"provider"`).
- `kind` ∈ `rate_limit | network_failure | model_refused | invalid_response | unauthorized | quota_exceeded | grammar_invalid | grammar_unenforced`. HTTP status maps: 401/403→`unauthorized`, 402→`quota_exceeded`, 429→`rate_limit`, ≥500→`network_failure`, a 422 whose `error.type` is `grammar_invalid`→`grammar_invalid`, other 4xx→`invalid_response`; timeouts/fetch errors→`network_failure`. Classification describes the failed exchange and does not itself prescribe replay. (`model_refused` is response-level — minted consumer-side from a `content_filter` finish reason, not from a thrown error.) **`grammar_unenforced`** is response-level too, and ALWAYS an observation, never a throw (#24, §2 Promises): whether the grammar was transported or withheld (GBNF-filter mode), a completed exchange returns its bytes with a **non-fatal `TelemetryEvent`** on `ProviderResponse.telemetry` carrying the divergence `position`, so the consumer can drive discard/retry/self-correction. `ProviderError` stays reserved for exchanges that did NOT complete.
- `message` is terse and factual (no guidance prose); `position` is `null` (provider failures aren't localizable into prior content).
- **Caller-initiated abort is NOT telemetry** — an aborted `signal` rethrows the original abort, never a `ProviderError`.

The `TelemetryEvent` shape is mirrored **locally** (`./telemetry.ts`), structurally matching `@plurnk/plurnk-grammar`'s `TelemetryEvent.json`, so the framework keeps zero grammar dependency (§11). Consumers route provider events through the same `source`+`kind` discriminator as parse/rail events.

## §13 Grammar-constrained sampling (GBNF)

GBNF is an optional aid for local llama.cpp hobbyists, not the PLURNK language
contract and not a baseline cloud capability. The canonical language is parsed
by `@plurnk/plurnk-grammar`'s ANTLR grammar. That package also ships a generated
`plurnk.gbnf` whose language is a tested subset of the canonical grammar.

- **plurnk-grammar** owns the artifact (canonical-form GBNF, `L(GBNF) ⊂ L(ANTLR)` invariant, tests).
- **This layer** detects or accepts an operator pin for llama-server, transports
  the caller's GBNF verbatim as its top-level `grammar` field, and reports
  conformance. Cloud providers never receive a grammar-related field.
- **The consumer** decides whether to configure a local constraint and which
  artifact to send. Endpoint-managed constraints are endpoint settings, not a
  provider capability inferred from their absence here.

`grammarStyle` is `"none"` or `"llamacpp"`. A llama-server fingerprint or
`PLURNK_PROVIDERS_LLAMA_SERVER=1` selects `"llamacpp"`; all other providers
remain `"none"`. `constrainsOutput` is true only for the former.

When a grammar is transported, the provider independently validates returned
content with `@plurnk/gbnf`. A non-accept verdict attaches
`grammar_unenforced` telemetry without discarding the completed response.
`meta.railsAttached` and `meta.railsVerdict` record the observed local
transport and verdict. If the validator cannot parse the supplied grammar, the
provider emits `PLURNK_GRAMMAR_UNVERIFIABLE`.

`PLURNK_PROVIDERS_GBNF_DEBUG` validates and withholds an otherwise transportable
local grammar, then reports how the unconstrained output diverges. It is a
development diagnostic, not a cloud compatibility mode.

Hard constraints can amplify repetition and do not replace the normal output
envelope. The llama.cpp path therefore carries its configured
`repeat_penalty`; ordinary cloud requests use the standard configured
`frequency_penalty`. The GBNF string still arrives per call, so this package
does not depend on the PLURNK grammar artifact.

## §14 Data capture — logprobs + verbatim body (#36)

Two OPT-IN knobs surface the full signal of a paid turn for downstream IQ scoring and model distillation. Both are **OFF by default** and **per-alias-scopable** (`PLURNK_PROVIDERS_<KNOB>_<alias>`): the flag *is* the isolation, so a serving turn requests nothing on the wire and carries nothing on the response — only a dataset-scraping alias opts in. Universal: any provider (standard or plugin), any backend that returns the data.

**`PLURNK_PROVIDERS_TOP_LOGPROBS`** (non-negative int = the OpenAI `top_logprobs`; unset = off). When set, `generate` requests `logprobs:true, top_logprobs:<n>` and surfaces `response.assistant.logprobs: Array<{ token, logprob, top? }>` plus `assistant.meanLogprob`. These are **managed fields** — reserved from caller `sampling`, so the env flag is the single control (a proxy consumer can't forge them). A backend that returns no logprobs yields an absent field — **never synthesized**.

**The `logprob` vs `sampling_logprob` decision (the honest-confidence call).** Fireworks returns both per token: `logprob` (raw model log-probability) and `sampling_logprob` (post-sampling-transform). The structured `logprob` we surface is the **raw** value — the sampling-transform-invariant measure of the model's native belief, the correct confidence signal AND distillation target. This was settled empirically, not by assumption: under grammar the two measured **identical to full float precision**, including an *adversarial* mask (grammar forcing a token the model assigned ~8%: `logprob` −2.5229365 == `sampling_logprob` −2.5229365). A post-mask renormalization would inflate confidence toward the constraint; the raw value stays honest. Anyone wanting `sampling_logprob` reads it from `rawBody`.

**`PLURNK_PROVIDERS_RAWBODY`** (truthy = on). When on, `response.rawBody` carries the **verbatim** backend body — the full wire JSON for a non-streamed turn (exact; grammar turns already run non-streamed), or the reassembled equivalent for a streamed one. `assistantRaw` remains the normalized **digest** (it drops `choices[]`); `rawBody` is the capture-everything record that keeps `sampling_logprob`, `token_id`, `bytes`, and any backend-specific per-token fields. Off by default so serving turns never pay the retention cost.

## §15 Capacity pool (`Pool`)

`Pool` fronts **N interchangeable backends as one `Provider`** - capacity scaling, not model blend. It ships the MECHANISM (round-robin across workers, sticky within a worker, overflow to a healthy sibling); the blend/escalation DECISION (which SKU, when to switch) stays the **consumer's**, one level up, by choosing WHICH pool to call. `new Pool(backends: Provider[])` - the consumer resolves the backends (per-alias `instantiateProvider`) and composes them.

**Interchangeable, or it throws.** Construction fails on mixed `model`: a heterogeneous "pool" is the consumer's per-turn selection, not this primitive. The surface is the honest aggregate - `contextWindow` is the **safe floor** (min; `null` if any backend's window is unknown, so the consumer never improvises a cap, #421) with its matching reserves; `constrainsOutput` is claimed only if EVERY backend does; `requiresMaxTokens` if ANY does; `servedModel` the common id (else absent); `countTokens`/`tokenize`/`calculateCost` delegate.

**Affinity is the point (§11, one level up).** A worker's turns stick to one backend so its stable prompt prefix keeps hitting the same KV cache; scattering a worker across backends shreds the prefix cache (#531). `worker -> backend` is the `worker -> slot` slot-affinity pattern (#11) across a fleet: round-robin assigns a NEW worker, a returning worker re-pins, the map is LRU-bounded (`N*8`).

**Overflow is availability-only.** A backend that throws `network_failure`/`rate_limit` (having already exhausted its own transient retries, §11) hands the worker to the next untried backend and **re-sticks** it there (its cache moves with it; worst case one cold prefill). Auth/quota/content failures and caller aborts **propagate** - a peer fails them the same, and failing over would only multiply the spend. Whole fleet down -> the last error is thrown.
