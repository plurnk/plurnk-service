# `@plurnk/plurnk-providers` Specification

Stable model-provider contract, capacity and monetary accounting authority, and transport adapter over `@earendil-works/pi-ai` (`@earendil-works/pi-ai/api/*` `stream`) and OpenAI-compatible HTTP endpoints.

## §provider-interface Provider and runtime-neutral contract

`@plurnk/plurnk-providers` exposes three package entrypoints:

| Subpath | Surface | Runtime boundary |
|---|---|---|
| `@plurnk/plurnk-providers` | Full `Provider` contract, `ModelProvider`, `Pool`, `Mock`, `instantiateProvider`, `loadActiveProvider`, `discover`, and configuration helpers | Node >= 26 |
| `@plurnk/plurnk-providers/accounting` | `aggregateProviderAccounting`, `estimateProviderCost`, `providerCostNormalizer`, `resolveProviderCost`, `sumProviderCostsUsd`, `validateProviderUsage` | Runtime-neutral (browser-bundlable) |
| `@plurnk/plurnk-providers/errors` | `ProviderError`, `RETRYABLE_PROVIDER_KINDS`, `classifyProviderError`, `toProviderError`, `providerSource` | Runtime-neutral (browser-bundlable) |

Every `Provider` instance exposes:

| Member | Contract |
|---|---|
| Physical & policy getters | `model`, `servedModel`, `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `outputBudget`, `outputFloor`, `reasoningBudget`, `inputCapacity`, `inputWall`, `supportedEfforts`, `inputModalities` (`ReadonlySet<"image" \| "audio" \| "video" \| "pdf">`), `constrainsOutput`, and `requiresOutputBudget` |
| `countPromptTokens(messages, signal?)` | Measures or estimates prompt token weight (`PromptTokenMeasurement`) |
| `assessRequestCapacity(messages, maxOutputTokens?, signal?)` | Evaluates `inputCapacity`, `inputWall`, admission `decision` (`"admit" \| "defer" \| "reject"`), and flexed `responseMax` |
| `generate(args)` | Requires non-empty `sessionId` (used for KV-cache and slot affinity), optional `callKind` (`"emission"` or `"bare"`), optional `grammar`, `maxOutputTokens`, `sampling`, `observeRequest`, and `observeReasoning`. Native tool calls are unconditionally disabled on every protocol |
| `observeRequest` | Opens before each physical HTTP attempt and settles once with `(requestAccounting, forensicEvidence)`. When `PLURNK_PROVIDERS_RAWBODY=1`, `forensicEvidence.request` records `{ origin, method, body }` with credentials and URL path/query secrets stripped |
| `observeReasoning` | Streams reasoning deltas live from structured reasoning events (`thinking_delta`) or leading tagged reasoning envelopes (`<think>...</think>` when `PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE=think-tags`, or llama-server template envelopes on grammar-constrained turns) |
| `Pool` | Fronts $N \ge 1$ homogeneous backends sharing a `model` id: aggregates limits to conservative floors, pins each `sessionId` to one backend for KV-cache locality, and overflows to a healthy sibling on retryable availability failures (`network_failure`, `rate_limit`, `deadline_exceeded`) while never overflowing terminal errors or `resource_interrupted` attempts |

## §provider-capacity-admission Capacity and prompt measurement

`countPromptTokens` returns a `PromptTokenMeasurement` discriminated by `kind`:

| `kind` | Source & semantics |
|---|---|
| `"exact"` | Measured by the serving vocabulary (such as llama-server `/v1/chat/completions/input_tokens` or `Mock`) |
| `"upper_bound"` | Conservative maximum across a `Pool` of exact counters |
| `"estimate"` | Character heuristic (`ceil(codePoints / 2)`, `source: "heuristic:chars2"`) when no exact endpoint exists or when the endpoint degrades |
| `"unavailable"` | No measurement available |

`assessRequestCapacity` computes:

- `inputCapacity = min(maxInputTokens, contextWindow - outputBudget)` (the soft curation reservation line).
- `inputWall = min(maxInputTokens, contextWindow - outputFloor)` (the hard physical wall; when `outputBudget` is tightened below `outputFloor`, the floor tightens with it).
- `decision`: `"reject"` only when `prompt.kind === "exact"` and `prompt.tokens > inputWall`; `"defer"` when a non-exact measurement exceeds `inputWall` or measurement is unavailable; `"admit"` otherwise.
- `responseMax`: the flexed wire output allowance (`min(maxOutputTokens, contextWindow - prompt.tokens - 256)` bounded below by `outputFloor` for exact measurements, or bounded above by `outputBudget` for estimates).

## §provider-monetary-evidence Usage and monetary accounting

Every physical attempt settles a `ProviderRequestAccounting` record (`{ provider, model, outcome, status?, usage?, cost }` under {§provider-request-accounting}):

- `normalizeUsage` validates non-negative safe integers, recovers additive reasoning when `prompt + completion + reasoning === total`, derives a single missing input cache partition (`noCacheTokens`, `cacheReadTokens`, `cacheWriteTokens`) when the other two and total are known, and rejects contradictory counters (`UsageDetailError`) while preserving valid outer totals.
- Cost precedence resolves in order:
  1. Direct provider charge evidence (`kind: "charged"`, e.g. OpenRouter `usage.cost` and BYOK `upstream_inference_cost`).
  2. Direct provider response estimate (`kind: "estimated"`, e.g. DeepInfra `usage.estimated_cost`).
  3. Operator rate override (`PLURNK_PROVIDERS_COST=input=...,output=...,reasoning=...,cacheRead=...,cacheWrite=...`) over catalog rates (`kind: "estimated"`).
  4. Catalog rates (`kind: "estimated"`). When a model has a distinct rate for a token category (`reasoning`, `cacheRead`, `cacheWrite`) that the response omitted, cost resolves to `kind: "unknown"` rather than guessing.
- `aggregateProviderAccounting` sums `usage` and `costUsd` across requests, returning `null` for `usage` or `costUsd` when any request's usage or cost is unknown while preserving `knownUsage` and `knownCostUsd` subtotals.

## §provider-sdk-boundary SDK and transport boundary

`ModelProvider.ts` delegates streaming, protocol framing, and vendor request assembly to `@earendil-works/pi-ai` (`@earendil-works/pi-ai/api/*` `stream`) across all supported APIs (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`, `bedrock-converse-stream`):

- Prompt cache affinity (`PLURNK_PROVIDERS_CACHE_AFFINITY=1`) projects each provider's documented session key (`sessionId` -> `prompt_cache_key` / `x-session-id` / `x-session-affinity`).
- Stable-system cache write policy (`PLURNK_PROVIDERS_CACHE_WRITE_POLICY=stable-system`) attaches ephemeral cache retention (`cache_control: { type: "ephemeral" }`) on providers that support prompt cache breakpoints (Anthropic and Anthropic routes on OpenRouter).

## §provider-effort Reasoning effort and readable trace

`PLURNK_PROVIDERS_EFFORT` selects one portable policy (`off`, `adaptive`, `low`, `medium`, `high`, `xhigh`, `max`, {§capability-policy-cascade}):

- `catalogEfforts(providerInfo, modelInfo, env)` intersects the model's cataloged effort vocabulary (extended by `PLURNK_PROVIDERS_PROVIDER_<ID>_REASONING_EFFORTS` for reasoning models) with what the provider adapter can preserve on the wire.
- On `adaptive`, routes with native adaptive reasoning (such as Anthropic adaptive thinking or Gemini thinking) request their native adaptive posture; graded effort routes use `PLURNK_PROVIDERS_EFFORT_FALLBACK` (default `high`) when supported by the model's effort set.
- When `PLURNK_PROVIDERS_REASONING_BUDGET` is set alongside `adaptive`, budget-capable routes send the token budget (`thinkingBudgets` / `thinking.budget_tokens` / `thinkingConfig.thinkingBudget` / `reasoning.max_tokens`); setting a fixed effort alongside `PLURNK_PROVIDERS_REASONING_BUDGET` is rejected at construction. On Google routes where `maxOutputTokens` is shared across `thoughtsTokenCount` and `candidatesTokenCount`, `thinkingConfig.thinkingBudget` is bounded by `maxOutputTokens - outputFloor` (or `maxOutputTokens - 1` when tightened below `outputFloor`) so visible output headroom is reserved.
- On detected llama-server routes, `off` and `adaptive` send `chat_template_kwargs: { enable_thinking: false | true }`, and fixed efforts declared in `PLURNK_PROVIDERS_REASONING_EFFORTS` add `reasoning_effort`. When grammar constrains a template-reasoning turn, the adapter sends `reasoning_format: "none"` so the grammar governs the raw stream and projects the leading template block back into `assistant.reasoning`.

## §provider-configuration Environment configuration and envelope

| Knob | Default / Form | Effect |
|---|---|---|
| `PLURNK_PROVIDERS_OUTPUT_BUDGET` | `25%` (`<pct>%` or positive integer tokens) | Soft output reservation subtracted from `contextWindow` to form `inputCapacity` |
| `PLURNK_PROVIDERS_OUTPUT_FLOOR` | `25%` (`<pct>%` of effective output ceiling or integer tokens) | Hard minimum output allowance subtracted from `contextWindow` to form `inputWall` |
| `PLURNK_PROVIDERS_REASONING_BUDGET` | empty (`<pct>%` or integer tokens, `< outputBudget`) | Explicit thinking token budget under `adaptive` effort |
| `PLURNK_PROVIDERS_EFFORT` / `EFFORT_FALLBACK` | `adaptive` / `high` | Portable reasoning effort selector and graded-route fallback |
| `PLURNK_PROVIDERS_FETCH_TIMEOUT` / `OPERATION_TIMEOUT` | `30000` / `600000` ms | Per-attempt fetch/idle timeout and total operation wall-clock timeout |
| `PLURNK_PROVIDERS_RETRY_ATTEMPTS` | `3` | Maximum automatic retry attempts for retryable transport failures |
| `PLURNK_PROVIDERS_MAX_CONCURRENCY` | `-1` (unbounded or positive integer) | Per-endpoint FIFO concurrency gate ({§provider-inference-admission}) |
| `PLURNK_PROVIDERS_RAWBODY` | `0` (`0 \| 1`) | Retains redacted raw request/response forensic bodies in `forensicEvidence` |

- Every knob in `PROVIDERS_KNOBS` is documented in `plurnk-providers/.env.defaults` and supports case-insensitive per-alias suffix scoping (`<KNOB>_<ALIAS>`) via `scopeEnvToAlias(env, alias)`.
- Sampling knobs (`TEMPERATURE`, `TOP_P`, `TOP_K`, `PRESENCE_PENALTY`, `FREQUENCY_PENALTY`, `SEED`, `REPEAT_PENALTY`, `REPEAT_LAST_N`, `DRY_MULTIPLIER`, `DRY_BASE`, `DRY_ALLOWED_LENGTH`) validate at construction; caller `sampling` overrides configured defaults on a per-call basis, and `DRY_MULTIPLIER=0` suppresses all DRY fields.
- `instantiateProvider` resolves cataloged providers and `ollama` in-framework before scanning `node_modules` for third-party provider extensions (gated by `PLURNK_EXTENSIONS_TRUSTED_ONLY`). `providerReadiness(provider, env)` reports missing credentials or endpoint configuration without exposing secret values.

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
- Grammar strings (`generate({ grammar })`) are transported only when `grammarStyle === "llamacpp"` (`constrainsOutput === true`), preserving `grammarEvidence` (`{ input, contentStart, transported }`) on the response. When `tokenize` is available on a grammar turn and billed `outputTokens` exceed visible content + reasoning tokens by more than 64, an `output_unaccounted` notice is attached ({§diagnostic-observation}).

## §provider-failure-normalization Failure normalization and evidence

All transport and response failures normalize into `ProviderError` carrying an RFC 9457 Problem Details payload (`https://problems.plurnk.xyz/provider/<providerId>/<kind>`, {§diagnostic-observation}):

| `ProviderErrorKind` | HTTP / trigger | Problem status | `retryable` | Extensions |
|---|---|---|---|---|
| `unauthorized` | 401, 403 | 401 / 403 | `false` | `cause` |
| `quota_exceeded` | 402 or billing/quota exhaustion | 402 | `false` | `cause` |
| `rate_limit` | 429 | 429 | `true` | `cause` |
| `capacity_exceeded` | Preflight exact wall overflow, 413, or upstream context-length code | 413 | `false` | `cause` |
| `grammar_invalid` | 422 with `error.type === "grammar_invalid"` | 422 | `false` | `cause` |
| `request_rejected` | Other 400, 404, 405, 422 | 400..422 | `false` | `cause` |
| `network_failure` | 408, 409, 5xx, socket/TLS/proxy error, or mid-stream disconnect | 502 / 503 | `true` | `cause`, optional `attempt` |
| `deadline_exceeded` | `PLURNK_PROVIDERS_FETCH_TIMEOUT` or `PLURNK_PROVIDERS_OPERATION_TIMEOUT` | 504 | `true` | `cause`, optional `attempt` |
| `resource_interrupted` | `finishReason === "resource_interrupted"` | 503 | `true` | `attempt` |
| `generation_failed` | `finishReason === "error"` | 502 | `false` | `attempt` |
| `invalid_response` | Malformed 2xx payload, missing finish reason, invalid usage, or output exceeding granted allowance | 502 | `false` | `cause`, optional `attempt` |
| `model_refused` | Upstream safety/content refusal finish reason | 422 | `false` | `attempt` |

- Outbound HTTP requests honor `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`.
- When an upstream stream terminates with an error or length finish reason (`MALFORMED_RESPONSE`, `MALFORMED_FUNCTION_CALL`, `MAX_TOKENS`) after delivering a complete, balanced fenced emission with no unclosed fence, no native tool calls, and no trailing unfenced text, `finishReason` normalizes to `"stop"` while preserving `rawFinishReason` in forensic evidence.
- Transient HTTP failures, upstream malformed-decoder aborts (`MALFORMED_RESPONSE`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`) without a complete fenced emission, and reasoning-only `MAX_TOKENS` cutoffs with empty visible content retry up to `PLURNK_PROVIDERS_RETRY_ATTEMPTS` inside the provider (stepping down Google thinking posture on retry when reasoning starved visible output); if a stream fails after emitting partial visible output and a retry succeeds, a `provider_retry` notice is attached.
- Problem `detail` and structured `cause.causeMessage` strings are bounded to `PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT` characters without leaking raw payloads or headers.

## §provider-inference-admission Inference admission

`InferenceAdmission.forEndpoint(endpoint, maxConcurrency)` coordinates in-flight generations across all `Provider` instances targeting the same canonical endpoint URL (`PLURNK_PROVIDERS_MAX_CONCURRENCY`, default `-1` unbounded, or a positive safe integer):

- Waiters acquire slots in strict FIFO order before opening a physical request (`observeRequest` does not fire while queued) and hold the slot until the response stream or error settles.
- Aborted waiters are removed from the queue immediately without consuming capacity; retry backoff releases the slot before sleeping and re-acquires it for the next attempt.
- Conflicting positive/unbounded `PLURNK_PROVIDERS_MAX_CONCURRENCY` declarations for the same canonical endpoint throw at construction.
