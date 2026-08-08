# Provider Contract

`@plurnk/plurnk-providers` adapts model endpoints to one stable PLURNK
`Provider`. It does not maintain a parallel vendor registry or reproduce
ordinary provider protocols.

## §1 Ownership

The provider stack has four owners:

1. Models.dev supplies a release-time snapshot of provider package, API
   endpoint, credential names, models, context windows, output limits,
   reasoning capability, and USD prices.
2. Official AI SDK providers own vendor request and response protocols.
3. This package owns the PLURNK contract: aliases, envelopes, normalized usage
   and errors, evidence, local capabilities, and first-party metadata.
4. The operator owns secrets, machine-specific endpoints, and deliberate
   metadata overrides through environment variables.

Facts MUST have one owner. Do not copy a cataloged endpoint, credential name,
model prefix, context window, price, or vendor request shape into a PLURNK
table. A missing or wrong catalog fact is fixed upstream, overridden through a
provider declaration, or left explicitly unknown.

## §2 Provider interface

§provider-interface `Provider` exposes immutable model facts and one generation
operation:

```ts
interface Provider {
  readonly model: string;
  readonly contextWindow: number | null;
  readonly servedModel?: string;
  readonly constrainsOutput?: boolean;
  readonly requiresMaxTokens?: boolean;
  readonly reasoningReserve?: number | null;
  readonly completionReserve?: number | null;

  countPromptTokens(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<PromptTokenMeasurement>;
  tokenize?(text: string): Promise<number[]>;
  calculateCost(usage: ProviderUsage): number;
  calculateCharge?(usage: ProviderUsage): Exclude<ProviderCost, { kind: "authoritative" }>;
  generate(args: GenerateArgs): Promise<ProviderResponse>;
}
```

`contextWindow` is provider physics and resolves under
{§model-fact-resolution}. `null` means genuinely unknown; a consumer MUST NOT
invent a stand-in. The context-window knob never carries model-facing prompt
policy or grinder pressure.

`PromptTokenMeasurement` is a discriminated request-level result:

| `kind`        | Meaning                                                | May authorize physical admission |
| ------------- | ------------------------------------------------------ | -------------------------------- |
| `exact`       | Exact count for the complete provider request.         | Yes.                             |
| `upper_bound` | Proven upper bound for the complete provider request.  | Yes.                             |
| `estimate`    | Empirical prediction with required causal `detail`.    | No.                              |

Every result carries a non-negative integer `tokens` and a non-empty `source`.
`countPromptTokens` receives the same messages supplied to `generate` and may
perform cancellable provider I/O. The common fallback is chars/2 over message
content; it is announced once and reported honestly as an estimate because it
knows neither the serving vocabulary nor provider-owned request framing.
An unavailable optional counting endpoint likewise returns an estimate naming
the cause. A malformed measurement is a provider contract violation and fails
hard; consumers do not reinterpret it as ordinary unavailability.

`tokenize` is the separate content-token capability and exists only when the
endpoint exposes its real vocabulary. Content tokenization does not substitute
for complete-request measurement.

§provider-monetary-evidence A provider response may carry an authoritative
settled `charge`; it wins over every local calculation. Otherwise
`calculateCharge` returns estimated, explicitly free, or unknown evidence under
{§provider-cost}. The numeric `calculateCost` method remains only as a frozen
1.x compatibility surface: a positive value adapts to an estimate, while zero
adapts to unknown because it cannot prove free.

### Generation

`generate` requires a non-empty, stable, opaque `workerId`. It accepts:

- `messages`: system, user, and assistant text messages;
- caller cancellation through `signal`;
- optional `grammar` and `maxTokens`;
- standard `sampling` intent;
- opaque attribution tags plus client, strike, workspace, loop, and turn metadata.

A successful return carries the model's raw content and reasoning, normalized
usage, normalized finish reason, model identity, opaque evidence, optional
metadata, and optional notices. The provider transports and observes model
output; it never retries, discards, or repairs an otherwise completed exchange
because PLURNK grammar did not accept it.

Usage obeys:

```text
total = prompt + completion + reasoning
cached ⊆ prompt
```

`completion` excludes reasoning. Ordinary vendor finish reasons normalize to
`stop`, `length`, `tool_calls`, or `content_filter`; an unknown value becomes
`null` and emits a warning. `resource_interrupted` is the distinct failed-attempt
disposition defined by {§provider-interrupted-attempt}.

### Tagged reasoning responses

§provider-tagged-reasoning Structured provider or SDK reasoning fields are
authoritative. Visible content is interpreted as tagged reasoning only under an
explicit alias-scoped response style:

| Effective style | Leading content                                            | Normalized result                                                                                         |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `verbatim`      | Any bytes.                                                 | Content remains exact; only structured reasoning fields populate `reasoning`.                             |
| `think-tags`    | No exact leading `<think>`.                                | Content remains exact.                                                                                   |
| `think-tags`    | `<think>reasoning</think>visible`.                         | The first envelope body becomes reasoning; the exact suffix becomes content. Later tags remain literal.  |
| `think-tags`    | `<think>reasoning` with no close, including a capped turn. | The complete post-open tail becomes reasoning; content is empty.                                         |

Tag projection never runs when readable structured reasoning is already
present. Streamed and buffered transports converge on this response boundary.
When the upstream reports only combined output usage, the existing
sum-preserving text-proportion estimate reclassifies completion versus reasoning
without changing prompt, cached input, total output, or billed output.

Grammar evidence retains the exact pre-projection sentence and its Unicode
content offset. Response classification cannot rewrite what a transported GBNF
rail observed.

## §3 AI SDK boundary

§provider-sdk-boundary Cataloged providers instantiate their
Models.dev-declared AI SDK package.
Standard request shaping, streaming, retries, cancellation, timeouts, usage,
and vendor error parsing belong to the SDK.

PLURNK maps its generic settings to AI SDK call settings:

- `temperature`, `top_p`, `top_k`;
- presence and frequency penalties;
- stop sequences and seed;
- output-token ceiling;
- `off`, `adaptive`, or budget-derived reasoning intent.

Provider-specific options are permitted only where they preserve a documented
PLURNK product contract the generic SDK surface cannot express.

§deepseek-reasoning-request The direct DeepSeek catalog path maps the common
reasoning intent to its OpenAI-compatible controls:

| PLURNK mode | `thinking`            | `reasoning_effort`   |
| ----------- | --------------------- | -------------------- |
| `off`       | `{ type: disabled }`  | omitted              |
| `adaptive`  | omitted               | omitted              |
| `on`        | `{ type: enabled }`   | budget-derived tier  |

The compatible transport is deliberately retained for:

- `openai` local endpoints, including llama-server and vLLM;
- `ollama`, after its native `/api/show` probe;
- the first-party `plurnk` endpoint;
- operator-declared `@ai-sdk/openai-compatible` providers.

It carries PLURNK-only fields and raw wire evidence without reimplementing the
SDK's ordinary transport.

## §4 Operator configuration

§provider-configuration Every operational value is an environment knob
documented in `.env.defaults`.
There are no hidden tuning constants. Every `PLURNK_PROVIDERS_*` knob may be
scoped to an alias by appending `_<alias>`; the scoped value wins.

The public Node provider registry applies this package's committed
`.env.defaults` as a set-if-unset operational floor. Consumers pass their
operator environment, not a manually composed copy of the provider floor.
Explicit operator values always win and invalid explicit values fail at the
knob's owning contract.

The universal groups are:

- reasoning activation and optional explicit budget;
- explicit reasoning response-content style;
- decode tuning;
- request, stream-idle, retry, and probe budgets;
- local GBNF and llama-server capability pins;
- context-window and generation-envelope overrides;
- explicit input, cached-input, and output USD-per-million rates for models
  absent from the snapshot or deliberate operator overrides;
- opt-in logprob and raw-body capture.

Operator secrets and machine-specific values never belong in committed
defaults.

## §5 Resolution

§provider-resolution `PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an
alias.
`PLURNK_MODEL=<alias>` selects the boot alias. Model IDs may contain `/`.
`PLURNK_BASEURL_<alias>` is a per-alias endpoint override.

### §model-fact-resolution Model fact precedence

Provider and model facts resolve independently:

| Fact                 | Natural source                                         | Operator source                                      | Effective value                                                                                                                                        |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context window       | Catalog metadata or a local endpoint probe.            | `PLURNK_PROVIDERS_CONTEXT_WINDOW`.                   | Minimum when both exist; the sole value otherwise. A cataloged cloud miss fails construction; a compatible probe miss remains `null` with one warning. |
| Completion envelope  | Catalog `maxOutput`; there is no live limit probe.     | `PLURNK_PROVIDERS_COMPLETION_RESERVE`.               | An absolute reserve wins. A percentage derives from the effective window and is capped by catalog `maxOutput` when present.                            |
| Reasoning capability | Catalog `reasoning: true`, exposed by snapshot lookup. | Runtime activation, reserve, and adapter wire style. | The catalog bit is informational; provider construction neither activates nor blocks reasoning from it.                                                |
| Estimated USD rates  | Catalog input, output, and optional cache-read rates.  | Complete input/output rate override; cache optional. | Operator rates win; otherwise catalog rates apply. Missing rates produce unknown evidence; explicit all-zero rates produce free evidence. No live price fetch exists. |

The cached-input override defaults to the explicit input rate when omitted.
Catalog cache-read cost likewise defaults to catalog input cost. Catalog
cache-write cost remains snapshot information; the current usage estimator has
no cache-write quantity to price.

`instantiateProvider` resolves in this order:

1. A Models.dev provider and model, using its declared AI SDK package.
2. An operator provider declaration:
   `PLURNK_PROVIDERS_PROVIDER_<NAME>_{NPM,BASE_URL,API_KEY_ENV}`.
3. The local `openai`, `ollama`, or first-party `plurnk` adapter.
4. A discovered AI SDK provider plugin.
5. A precise unknown-provider error.

Earlier sources are authoritative. Installed plugins cannot shadow a cataloged
or explicitly declared name. This remains true when a named model is absent
from the Models.dev snapshot: construction requires an explicit
`PLURNK_PROVIDERS_CONTEXT_WINDOW` and never falls through to a same-name
plugin.

Model IDs resolve exactly first. A unique catalog suffix is accepted to avoid
forcing a vendor-owned resource prefix into PLURNK aliases. Ambiguous suffixes
fail to resolve.

Provider declarations configure facts, not credentials:

```dotenv
PLURNK_PROVIDERS_PROVIDER_ACME_NPM=@ai-sdk/openai-compatible
PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL=https://api.acme.example/v1
PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV=ACME_API_KEY,ACME_TOKEN
```

The named secret remains in the operator environment. `${ENV_NAME}` inside a
catalog or declared endpoint is expanded at construction and fails clearly
when absent.

## §6 Provider plugins

Provider plugins are the escape hatch for a protocol binding not represented by
Models.dev, installed SDK providers, or a declaration. Most extensibility
belongs in MCP, schemes, executors, or mimetypes instead.

A provider plugin:

1. declares the exact string `plurnk: { kind: "provider", name }` in `package.json` ({§plugin-family-kind});
2. may declare always-on package-level `plurnk.attribution` and/or implement the
   synchronous runtime `attributions(context)` hook under {§plugin-attribution};
3. may use any npm scope;
4. default-exports an AI SDK provider with `languageModel(modelId)`;
5. peers on compatible `ai` and `@plurnk/plurnk-providers` majors.

PLURNK adapts the returned language model. The plugin does not implement the
PLURNK `Provider`, read PLURNK tuning knobs, or reproduce transport policy.

Discovery is scope-agnostic and memoized per process. Duplicate names fail hard.
The common plugin trust gate applies before import ({§plugin-trust-boundary}). A plugin absent from
Models.dev requires an explicit context-window pin because PLURNK will not guess
model physics. `Discovery.packageAttributions` carries the canonical package map;
the published name-keyed `Discovery.attributions` remains its 1.x projection.

## §7 Local capabilities

§provider-local-capabilities The `openai` local adapter probes `/v1/models`. A
llama-server fingerprint may
also expose:

- the actual served model and per-slot context window;
- request-scoped reasoning parsing and a cumulative response-wide allowance;
- GBNF constrained sampling;
- slot count and worker-sticky slot affinity;
- EOS marker removal;
- exact complete-request counting through `/v1/chat/completions/input_tokens`;
- exact content token IDs through `/tokenize`;
- the requirement that the caller provide `maxTokens`.

`PLURNK_PROVIDERS_LLAMA_SERVER` may force or disable detection. Probe attempts
and delay are knobs. A failed probe does not silently assert capabilities.

Ollama probes `/api/show` for its model context and uses its documented
OpenAI-compatible generation endpoint through the SDK adapter.

### llama-server reasoning

For a detected llama-server, PLURNK sends the complete reasoning contract on
every request:

| Mode | Template activation | `thinking_budget_tokens` |
|---|---:|---:|
| `off` | false | `0` |
| `adaptive` | true | resolved reasoning reserve |
| `on` | true | explicit reasoning budget |

The explicit budget may tighten but MUST NOT exceed the resolved reasoning
reserve. `reasoning_format: "auto"` requests a separate readable reasoning
channel. Process-wide llama-server flags are fallback server configuration, not
part of the PLURNK contract and need not be synchronized with an alias.

§llama-reasoning-request The allowance is cumulative across the complete response. Opening a second or
later reasoning block does not replenish it. Template parsing, the reasoning
sampler, normalized usage, and the returned reasoning channel MUST agree on that
response boundary.

## §8 Request authority

§provider-request-authority The caller's `sampling` bag expresses sampling
intent. It cannot override:

- model or messages;
- stream mode;
- grammar or response format;
- backend slot;
- data-capture settings;
- tool, modality, or multi-choice behavior;
- the consumer-owned output envelope;
- prompt-cache identity.

Generic AI SDK calls accept only settings represented by the SDK's portable
surface. Compatible endpoints may carry additional sampling keys after reserved
keys are removed.

First-party attribution, client, strike, workspace, loop, turn, and worker
headers are sent only by the `plurnk` provider. They never leak to another
backend.

## §9 Failures, retries, and cancellation

§provider-failure-normalization Provider failures normalize to `ProviderError`.
Its public contract is an RFC
9457 Problem Details object with an exact status, stable type, occurrence
detail, and provider-kind extension; the original error remains its cause.
A caught failure is surfaced or deliberately preserved; it is never converted
into an empty model turn or reduced to a message plus a generic status.
Upstream diagnostic text is bounded by
`PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT`; the committed `.env.defaults` owns its
normal value. Retry exhaustion is preserved as `attempts` and
`retryExhausted`, and the resulting Problem is not marked retryable after the
provider has consumed its automatic retry budget.

The AI SDK owns one attempt scheduler around the complete generation exchange.
`PLURNK_PROVIDERS_RETRY_ATTEMPTS` is the maximum retry count, including a
configured stream-chunk deadline that expires while consuming a response body.
The total generation deadline and caller cancellation span that scheduler and
every attempt; neither restarts during replay. Total and stream-chunk deadlines
are separately configurable.

HTTP 408, 409, 429, and ordinary 5xx responses are retryable unless the endpoint
explicitly says otherwise. Endpoint control responses 520–527 are final so a
router can prevent multiplicative retries behind its own retry policy.

### §provider-interrupted-attempt Provider-declared interruption

A successful transport response can still declare that inference did not
complete. That response is evidence for one failed provider attempt, never a
completed exchange.

| Concern                    | Contract                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Normalized finish reason   | Exact `insufficient_system_resource` becomes `resource_interrupted`; the raw value remains in `assistantRaw`.                |
| `generate` outcome         | Throw `ProviderError(kind="resource_interrupted")` at local status 503 with the normalized attempt on `error.attempt`.       |
| Partial response           | Preserve content, reasoning, usage, model, metadata, optional raw body, and other evidence without admitting it as success.  |
| Automatic replay           | None; the Problem has `retryable: false`, and AI SDK retry scheduling has already completed at the successful transport.     |
| Capacity-pool overflow     | None; a sibling success would erase the known billed failed attempt from the current `ProviderResponse` surface.             |
| Consumer admission         | Persist the evidence as an unaccepted attempt; never parse it into executable work, even when its frame looks complete.      |

## §10 Grammar

GBNF is a local llama-server capability, not a generic provider expectation.
The consumer chooses whether to supply a grammar. The provider never creates or
rewrites one.

GBNF defines the accepted raw sampled text; it runs before response reasoning
is separated from regular content. The shipped PLURNK sentence is owned by
`plurnk-contracts` {§gbnf-turn-shape} and {§gbnf-reasoning-boundary}; this package does
not restate or rewrite it.

When a grammar-capable adapter receives a grammar, `ProviderResponse` carries
`grammarEvidence: { input, contentStart, transported }`. `input` is the exact
pre-projection sentence represented by the response, `contentStart` is its
Unicode-code-point offset to `assistant.content`, and `transported` says whether
the grammar was actually sent. For active llama-server template reasoning, the
adapter reconstructs the Harmony enclosure only when the response demonstrates
that `reasoning_format: "auto"` projected it; otherwise it cannot claim evidence.
For an unsplit response, `input` is `content` and `contentStart` is zero.

§gbnf-response-observation The provider transports and represents; it does not grade its own enforcement.
The consumer validates `grammarEvidence.input` outside the enforcer's failure
domain. `PLURNK_PROVIDERS_GBNF_DEBUG` still validates grammar syntax before the
call and sets `transported: false` for the unconstrained comparison.


## §11 Evidence and metadata

§provider-evidence `assistantRaw` is an opaque normalized transport record.
Provider top-level
metadata is forwarded as an open bag without reinterpreting currencies or
vendor fields.

Logprobs and verbatim response capture are opt-in, alias-scoped dataset features.
When disabled, the request asks for neither and the response carries neither.
When enabled, raw per-token model logprob is canonical; alternatives are
preserved when returned. Raw body/chunks preserve wire evidence the normalized
record omits.

§provider-encrypted-reasoning **Readable reasoning and encrypted reasoning are
separate.** Encrypted payload bytes remain opaque and are never decoded. The
provider boundary distinguishes preserved detail evidence from derived entity
classification:

| Provider fact                    | Meaning |
| -------------------------------- | ------- |
| `id`                             | The provider's reasoning-detail identity, or `null`; never an AG-UI message or tool-call identity. |
| `subtype`                        | A provider-normalized classification supported by wire structure. OpenAI-compatible `message.reasoning_details` is `message`; no PLURNK operation is reclassified as a native tool call. |
| `encrypted[*].data` / `format`   | Ordered provider evidence, retained without decoding or concatenation across distinct details. |

Unrecognized detail shapes are omitted at this normalization boundary. Core
may preserve normalized items as forensic evidence, but a client protocol must
correlate them to an entity it actually created rather than reusing `id`.

## §12 Generation envelopes

§provider-generation-envelope Reasoning and completion reserves are percentages
of the resolved context
window or absolute token counts. Absolute pins win. The provider reports the
resolved reserves; the consumer owns prompt packing and the per-call output
cap. Model-limit precedence is defined once in {§model-fact-resolution}.

## §13 Capacity pool

§provider-capacity-pool `Pool` fronts interchangeable `Provider` instances. It
keeps workers sticky for
cache locality, selects a healthy sibling for overflow, and preserves the same
Provider contract. Whether endpoints are interchangeable is a consumer
decision, not inferred from provider names. Overflow is limited to transport
availability and rate-limit failures that carry no normalized response attempt;
{§provider-interrupted-attempt} propagates without overflow.

Prompt measurement covers every backend that could receive the request. The
pool takes the largest result; differing exact counts or any proven bound yield
an `upper_bound`, while any estimate makes the aggregate an estimate.

## §14 Conformance

Coverage MUST prove:

- catalog, declaration, local, and plugin resolution;
- exact and unique-suffix model lookup;
- native SDK request mapping and normalized responses;
- compatible extension preservation;
- timeout, retry, cancellation, interrupted-attempt, and final-error behavior;
- local capability probes and pins;
- exact, bounded, and estimated complete-request token measurements;
- local reasoning activation, response-wide allowance, and GBNF coexistence;
- explicit tagged-reasoning projection across streamed, buffered, capped, and
  literal-tag responses;
- usage, costs, evidence, metadata isolation, and grammar observation;
- alias scoping and fail-hard invalid configuration.

Mock-only green tests do not establish a vendor integration. Live drills and
integration tests complement this contract; they do not replace its unit-level
proof.
