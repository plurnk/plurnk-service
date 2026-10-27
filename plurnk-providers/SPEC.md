# `@plurnk/plurnk-providers` Specification

Stable model-provider contract, capacity and monetary accounting authority, and transport adapter over `@earendil-works/pi-ai` and OpenAI-compatible HTTP endpoints.

## §provider-interface Provider and runtime-neutral contract

`@plurnk/plurnk-providers` exposes four package entrypoints:

| Subpath | Surface | Runtime boundary |
|---|---|---|
| `@plurnk/plurnk-providers` | Full `Provider` contract, `AiSdkProvider`, `Pool`, `Mock`, `instantiateProvider`, `loadActiveProvider`, `discover`, and configuration helpers | Node >= 26 |
| `@plurnk/plurnk-providers/openai` | `AiSdkProvider` and OpenAI-compatible transport | Runtime-neutral (no `node:*` imports) |
| `@plurnk/plurnk-providers/accounting` | `aggregateProviderAccounting`, `estimateProviderCost`, `providerCostNormalizer`, `resolveProviderCost`, `sumProviderCostsUsd`, `validateProviderUsage` | Runtime-neutral (browser-bundlable) |
| `@plurnk/plurnk-providers/errors` | `ProviderError`, `RETRYABLE_PROVIDER_KINDS`, `classifyProviderError`, `toProviderError`, `providerSource` | Runtime-neutral (browser-bundlable) |

Every `Provider` instance exposes:

- Physical and policy getters: `model`, `servedModel`, `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `outputBudget`, `outputFloor`, `reasoningBudget`, `inputCapacity`, `inputWall`, `supportedEfforts`, `inputModalities` (`ReadonlySet<"image" | "audio" | "video" | "pdf">`), `constrainsOutput`, and `requiresOutputBudget`.
- `countPromptTokens(messages, signal?)` and `assessRequestCapacity(messages, maxOutputTokens?, signal?)`.
- `generate(args)` — requires a non-empty `sessionId` (used for KV-cache and slot affinity), optional `callKind` (`"emission"` or `"bare"`), optional `grammar`, `maxOutputTokens`, `sampling`, `observeRequest`, and `observeReasoning`. Native tool calls are unconditionally disabled on every protocol (`tools: []`, `tool_choice: "none"` / `{ type: "none" }` / `mode: "NONE"`).
- `observeRequest` opens before each physical HTTP attempt and settles once with `(requestAccounting, forensicEvidence)`. When `PLURNK_PROVIDERS_RAWBODY=1`, `forensicEvidence.request` records `{ origin, method, body }` with credentials and URL path/query secrets stripped.
- `observeReasoning` streams reasoning deltas live from structured reasoning events or leading tagged reasoning envelopes (`<think>...</think>` when `PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE=think-tags`, or llama-server template envelopes on grammar-constrained turns).
- `Pool` fronts $N \ge 1$ homogeneous backends sharing a `model` id: it aggregates limits to conservative floors, pins each `sessionId` to one backend for KV-cache locality, and overflows to a healthy sibling on retryable availability failures (`network_failure`, `rate_limit`, `deadline_exceeded`) while never overflowing terminal errors or `resource_interrupted` attempts.

## §provider-capacity-admission Capacity and prompt measurement

`countPromptTokens` returns a `PromptTokenMeasurement` discriminated by `kind`:

- `"exact"` — measured by the serving vocabulary (such as llama-server `/v1/chat/completions/input_tokens` or `Mock`).
- `"upper_bound"` — conservative maximum across a `Pool` of exact counters.
- `"estimate"` — character heuristic (`ceil(codePoints / 2)`, `source: "heuristic:chars2"`) when no exact endpoint exists or when the endpoint degrades.
- `"unavailable"` — no measurement available.

`assessRequestCapacity` computes:

- `inputCapacity = min(maxInputTokens, contextWindow - outputBudget)` (the soft curation reservation line).
- `inputWall = min(maxInputTokens, contextWindow - outputFloor)` (the hard physical wall; when `outputBudget` is tightened below `outputFloor`, the floor tightens with it).
- `decision`: `"reject"` only when `prompt.kind === "exact"` and `prompt.tokens > inputWall`; `"defer"` when a non-exact measurement exceeds `inputWall` or measurement is unavailable; `"admit"` otherwise.
- `responseMax`: the flexed wire output allowance (`min(maxOutputTokens, contextWindow - prompt.tokens - 256)` bounded below by `outputFloor` for exact measurements, or bounded above by `outputBudget` for estimates).

## §provider-monetary-evidence Usage and monetary accounting

Every physical attempt settles a `ProviderRequestAccounting` record (`{ provider, model, outcome, status?, usage?, cost }` under `{§provider-request-accounting}`):

- `normalizeUsage` validates non-negative safe integers, recovers additive reasoning when `prompt + completion + reasoning === total`, derives a single missing input cache partition (`noCacheTokens`, `cacheReadTokens`, `cacheWriteTokens`) when the other two and total are known, and rejects contradictory counters (`UsageDetailError`) while preserving valid outer totals.
- Cost precedence resolves in order:
  1. Direct provider charge evidence (`kind: "charged"`, e.g. OpenRouter `usage.cost` and BYOK `upstream_inference_cost`).
  2. Direct provider response estimate (`kind: "estimated"`, e.g. DeepInfra `usage.estimated_cost`).
  3. Operator rate override (`PLURNK_PROVIDERS_COST=input=...,output=...,reasoning=...,cacheRead=...,cacheWrite=...`) over Models.dev catalog rates (`kind: "estimated"`).
  4. Models.dev catalog rates (`kind: "estimated"`, `source: "Models.dev catalog rates"`). When a model has a distinct rate for a token category (`reasoning`, `cacheRead`, `cacheWrite`) that the response omitted, cost resolves to `kind: "unknown"` rather than guessing.
- `aggregateProviderAccounting` sums `usage` and `costUsd` across requests, returning `null` for `usage` or `costUsd` when any request's usage or cost is unknown while preserving `knownUsage` and `knownCostUsd` subtotals.

## §provider-sdk-boundary SDK and transport boundary

`sdkModels.ts` and `aiSdkTransport.ts` adapt `@earendil-works/pi-ai` and vendor HTTP protocols (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/xai`, `@ai-sdk/groq`, `@ai-sdk/cerebras`, `@ai-sdk/deepinfra`, `@ai-sdk/togetherai`, `@openrouter/ai-sdk-provider`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/openai-compatible`) behind `AiSdkProvider`:

- Prompt cache affinity (`PLURNK_PROVIDERS_CACHE_AFFINITY=1`) projects each provider's documented session key (`promptCacheKey` on OpenAI, `prompt_cache_key` on DeepInfra, `x-session-id` header on OpenRouter, `x-session-affinity` header on Fireworks and Cloudflare Workers AI).
- Stable-system cache write policy (`PLURNK_PROVIDERS_CACHE_WRITE_POLICY=stable-system`) attaches ephemeral cache breakpoints on system messages only for providers that support them (Anthropic and Anthropic routes on OpenRouter).
- SDK warnings surface as `provider_warning` notices (`{§notice}`).

## §provider-effort Reasoning effort and readable trace

`PLURNK_PROVIDERS_EFFORT` selects one portable policy (`off`, `adaptive`, `low`, `medium`, `high`, `xhigh`, `max`, `{§capability-policy-cascade}`):

- `catalogEfforts(providerInfo, modelInfo, env)` intersects the model's cataloged effort vocabulary (extended by `PLURNK_PROVIDERS_PROVIDER_<ID>_REASONING_EFFORTS` for reasoning models) with what the provider adapter can preserve on the wire.
- On `adaptive`, routes with native adaptive reasoning (such as Anthropic adaptive thinking or Gemini thinking) request their native adaptive posture; graded effort routes use `PLURNK_PROVIDERS_EFFORT_FALLBACK` (default `high`) when supported by the model's effort set.
- When `PLURNK_PROVIDERS_REASONING_BUDGET` is set alongside `adaptive`, budget-capable routes send the token budget (`thinking.budget_tokens`, `thinkingConfig.thinkingBudget`, or `reasoning.max_tokens`); setting a fixed effort alongside `PLURNK_PROVIDERS_REASONING_BUDGET` is rejected at construction.
- On detected llama-server routes, `off` and `adaptive` send `chat_template_kwargs: { enable_thinking: false | true }`, and fixed efforts declared in `PLURNK_PROVIDERS_REASONING_EFFORTS` add `reasoning_effort`. When grammar constrains a template-reasoning turn, the adapter sends `reasoning_format: "none"` so the grammar governs the raw stream and projects the leading template block back into `assistant.reasoning`.

## §provider-configuration Environment configuration and envelope

- Every knob in `PROVIDERS_KNOBS` is documented in `plurnk-providers/.env.defaults` and supports case-insensitive per-alias suffix scoping (`<KNOB>_<ALIAS>`) via `scopeEnvToAlias(env, alias)`.
- `generationEnvelopeFromEnv` resolves `PLURNK_PROVIDERS_OUTPUT_BUDGET`, `PLURNK_PROVIDERS_OUTPUT_FLOOR`, and optional `PLURNK_PROVIDERS_REASONING_BUDGET` (as `<pct>%` of `min(contextWindow, maxOutputTokens)` or positive integer tokens), requiring `reasoningBudget < outputBudget < contextWindow` and clamping `outputFloor` to `outputBudget`.
- Sampling knobs (`TEMPERATURE`, `TOP_P`, `TOP_K`, `PRESENCE_PENALTY`, `FREQUENCY_PENALTY`, `SEED`, `REPEAT_PENALTY`, `REPEAT_LAST_N`, `DRY_MULTIPLIER`, `DRY_BASE`, `DRY_ALLOWED_LENGTH`) validate at construction; caller `sampling` overrides configured defaults on a per-call basis, and `DRY_MULTIPLIER=0` suppresses all DRY fields.
- `instantiateProvider` resolves cataloged providers and `ollama` in-framework before scanning `node_modules` for third-party provider extensions (gated by `PLURNK_EXTENSIONS_TRUSTED_ONLY`, `{§extension-trust-boundary}`). `providerReadiness(provider, env)` reports missing credentials or endpoint configuration without exposing secret values.

## §model-fact-resolution Route facts and local probes

| Route family | Fact authority |
|---|---|
| Cataloged cloud provider (`catalogProvider.ts`) | `resolveModel(provider, model)` from `@plurnk/plurnk-models`, capped by optional `PLURNK_PROVIDERS_CONTEXT_WINDOW`. Uncataloged models on a catalog provider require an explicit `PLURNK_PROVIDERS_CONTEXT_WINDOW`. Catalog credential names (`info.env`) or `PLURNK_PROVIDERS_PROVIDER_<ID>_API_KEY_ENV` (one exact variable name, never a comma list) supply authentication. |
| Local / compatible endpoint (`compatibleProvider.ts`) | Probes `GET <baseUrl>/models` for `n_ctx` / `max_model_len` / `context_length`. When llama-server is detected (`meta.n_ctx` or `PLURNK_PROVIDERS_LLAMA_SERVER=1`), probes `/props` for `total_slots` and `eos_token` and measures prompts via `/v1/chat/completions/input_tokens`. |
| Built-in Ollama rail (`ollama.ts`) | Probes `POST <origin>/api/show` for `*.context_length`, capped by optional `PLURNK_PROVIDERS_CONTEXT_WINDOW`, and dispatches chat completions to `<origin>/v1/chat/completions`. |
| Operator probe scripts (`scripts/`) | `providers-ping.mjs` probes one cheapest declared route per keyed provider and writes redacted JSON evidence; `token-envelope-probe.mjs` probes explicit aliases across configured or physical output limits. |

## §provider-request-authority Request controls and grammar transport

- Caller `sampling` and extension body fields cannot override protocol-owned fields (`model`, `messages`, `stream`, `tools`, `tool_choice`, `response_format`, `grammar`, `logprobs`, `top_logprobs`).
- `PLURNK_PROVIDERS_SERVICE_TIER` and `PLURNK_PROVIDERS_TOP_LOGPROBS` project onto native SDK requests only when the route's SDK documents the control; unsupported controls emit a single `PLURNK_REQUEST_CONTROL_UNSUPPORTED` process warning and are omitted from the wire.
- OpenRouter requests attach `HTTP-Referer` and `X-OpenRouter-Title` from `PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_URL` (validated as an absolute HTTP(S) URL) and `PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_NAME`.
- Grammar strings (`generate({ grammar })`) are transported only when `grammarStyle === "llamacpp"` (`constrainsOutput === true`), preserving `grammarEvidence` (`{ input, contentStart, transported }`) on the response. When `tokenize` is available on a grammar turn and billed `outputTokens` exceed visible content + reasoning tokens by more than 64, an `output_unaccounted` notice is attached (`{§diagnostic-observation}`).

## §provider-failure-normalization Failure normalization and evidence

All transport and response failures normalize into `ProviderError` carrying an RFC 9457 Problem Details payload (`{§problem-details}`):

| `ProviderErrorKind` | HTTP / trigger | `retryable` |
|---|---|---|
| `unauthorized` | 401, 403 | `false` |
| `quota_exceeded` | 402 | `false` |
| `rate_limit` | 429 | `true` |
| `capacity_exceeded` | Preflight exact wall overflow, 413, or upstream context-length code | `false` |
| `grammar_invalid` | 422 with `error.type === "grammar_invalid"` | `false` |
| `request_rejected` | Other 400, 404, 405, 422 | `false` |
| `network_failure` | 408, 409, 5xx, socket/TLS/proxy error, or mid-stream disconnect | `true` |
| `deadline_exceeded` | `PLURNK_PROVIDERS_FETCH_TIMEOUT` or `PLURNK_PROVIDERS_OPERATION_TIMEOUT` (504) | `true` |
| `resource_interrupted` | `finishReason === "resource_interrupted"` (503, carries `attempt`) | `true` |
| `generation_failed` | `finishReason === "error"` (502, carries `attempt`) | `false` |
| `invalid_response` | Malformed 2xx payload, missing finish reason, invalid usage, or output exceeding granted allowance | `false` |
| `model_refused` | Upstream refusal finish reason | `false` |

- Outbound HTTP requests honor `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`.
- Transient HTTP failures retry up to `PLURNK_PROVIDERS_RETRY_ATTEMPTS` inside the provider when `isRetryable` is true; if a stream fails after emitting partial output and a retry succeeds, a `provider_retry` notice is attached.
- Problem `detail` and structured `cause.causeMessage` strings are bounded to `PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT` characters without leaking raw payloads or headers.

## §provider-inference-admission Inference admission

`InferenceAdmission.forEndpoint(endpoint, maxConcurrency)` coordinates in-flight generations across all `Provider` instances targeting the same canonical endpoint URL (`PLURNK_PROVIDERS_MAX_CONCURRENCY`, default `-1` unbounded, or a positive safe integer):

- Waiters acquire slots in strict FIFO order before opening a physical request (`observeRequest` does not fire while queued) and hold the slot until the response stream or error settles.
- Aborted waiters are removed from the queue immediately without consuming capacity; retry backoff releases the slot before sleeping and re-acquires it for the next attempt.
- Conflicting positive/unbounded `PLURNK_PROVIDERS_MAX_CONCURRENCY` declarations for the same canonical endpoint throw at construction.
