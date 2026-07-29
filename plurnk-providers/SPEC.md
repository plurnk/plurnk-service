# Provider Contract

`@plurnk/plurnk-providers` adapts model endpoints to one stable PLURNK
`Provider`. It does not maintain a parallel vendor registry or reproduce
ordinary provider protocols.

## §1 Ownership

The provider stack has four owners:

1. Models.dev supplies a build-time snapshot of provider package, API endpoint,
   credential names, models, context windows, output limits, and USD prices.
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

`Provider` exposes immutable model facts and one generation operation:

```ts
interface Provider {
  readonly model: string;
  readonly contextWindow: number | null;
  readonly servedModel?: string;
  readonly constrainsOutput?: boolean;
  readonly requiresMaxTokens?: boolean;
  readonly reasoningReserve?: number | null;
  readonly completionReserve?: number | null;

  countTokens(text: string): number;
  tokenize?(text: string): Promise<number[]>;
  calculateCost(usage: ProviderUsage): number;
  generate(args: GenerateArgs): Promise<ProviderResponse>;
}
```

`contextWindow: null` means genuinely unknown. A consumer MUST NOT invent a
stand-in. A cataloged cloud model without a context window fails construction
unless the operator pins `PLURNK_PROVIDERS_CONTEXT_WINDOW`. A local probe
failure degrades to `null` and emits one warning because a transient probe
failure must not make a usable local endpoint unbootable.

`contextWindow` is provider physics. An operator value is a hard physical
ceiling: the provider reports `min(configured, detected/cataloged)`. When no
natural value is knowable, the explicit value declares the window. This knob
never carries model-facing prompt policy or grinder pressure; those belong to
the consumer.

`countTokens` is synchronous and non-negative. The common fallback is a
conservative chars/2 ruler and is announced once. `tokenize` exists only when
the endpoint exposes its real vocabulary.

`calculateCost` returns estimated USD. Models.dev rates are converted at the
provider boundary. Unknown pricing returns `0`; it is not represented as a
fabricated rate.

### Generation

`generate` requires a non-empty, stable, opaque `workerId`. It accepts:

- `messages`: system, user, and assistant text messages;
- caller cancellation through `signal`;
- optional `grammar` and `maxTokens`;
- standard `sampling` intent;
- first-party attribution, client, strike, workspace, loop, and turn metadata.

It returns the model's raw content and reasoning, normalized usage, normalized
finish reason, model identity, opaque evidence, optional metadata, and optional
notices. The provider transports and observes model output; it never retries,
discards, or repairs an otherwise completed exchange because PLURNK grammar did
not accept it.

Usage obeys:

```text
total = prompt + completion + reasoning
cached ⊆ prompt
```

`completion` excludes reasoning. Known vendor finish reasons normalize to
`stop`, `length`, `tool_calls`, or `content_filter`; an unknown value becomes
`null` and emits a warning.

## §3 AI SDK boundary

Cataloged providers instantiate their Models.dev-declared AI SDK package.
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

The compatible transport is deliberately retained for:

- `openai` local endpoints, including llama-server and vLLM;
- `ollama`, after its native `/api/show` probe;
- the first-party `plurnk` endpoint;
- operator-declared `@ai-sdk/openai-compatible` providers.

It carries PLURNK-only fields and raw wire evidence without reimplementing the
SDK's ordinary transport.

## §4 Operator configuration

Every operational value is an environment knob documented in `.env.defaults`.
There are no hidden tuning constants. Every `PLURNK_PROVIDERS_*` knob may be
scoped to an alias by appending `_<alias>`; the scoped value wins.

The public Node provider registry applies this package's committed
`.env.defaults` as a set-if-unset operational floor. Consumers pass their
operator environment, not a manually composed copy of the provider floor.
Explicit operator values always win and invalid explicit values fail at the
knob's owning contract.

The universal groups are:

- reasoning activation and optional explicit budget;
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

`PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an alias.
`PLURNK_MODEL=<alias>` selects the boot alias. Model IDs may contain `/`.
`PLURNK_BASEURL_<alias>` is a per-alias endpoint override.

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

1. declares `plurnk: { kind: "provider", name }` in `package.json`;
2. may use any npm scope;
3. default-exports an AI SDK provider with `languageModel(modelId)`;
4. peers on compatible `ai` and `@plurnk/plurnk-providers` majors.

PLURNK adapts the returned language model. The plugin does not implement the
PLURNK `Provider`, read PLURNK tuning knobs, or reproduce transport policy.

Discovery is scope-agnostic and memoized per process. Duplicate names fail hard.
The common plugin trust gate applies before import. A plugin absent from
Models.dev requires an explicit context-window pin because PLURNK will not guess
model physics.

## §7 Local capabilities

The `openai` local adapter probes `/v1/models`. A llama-server fingerprint may
also expose:

- the actual served model and per-slot context window;
- GBNF constrained sampling;
- slot count and worker-sticky slot affinity;
- EOS marker removal;
- exact `/tokenize`;
- the requirement that the caller provide `maxTokens`.

`PLURNK_PROVIDERS_LLAMA_SERVER` may force or disable detection. Probe attempts
and delay are knobs. A failed probe does not silently assert capabilities.

Ollama probes `/api/show` for its model context and uses its documented
OpenAI-compatible generation endpoint through the SDK adapter.

## §8 Request authority

The caller's `sampling` bag expresses sampling intent. It cannot override:

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

Provider failures normalize to `ProviderError`. Its public contract is an RFC
9457 Problem Details object with an exact status, stable type, occurrence
detail, and provider-kind extension; the original error remains its cause.
A caught failure is surfaced or deliberately preserved; it is never converted
into an empty model turn or reduced to a message plus a generic status.
Upstream diagnostic text is bounded by
`PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT`; the committed `.env.defaults` owns its
normal value. Retry exhaustion is preserved as `attempts` and
`retryExhausted`, and the resulting Problem is not marked retryable after the
provider has consumed its automatic retry budget.

The AI SDK owns attempt scheduling. `PLURNK_PROVIDERS_RETRY_ATTEMPTS` is the
maximum retry count. Caller cancellation spans the operation. Total and
stream-chunk deadlines are separately configurable.

HTTP 408, 409, 429, and ordinary 5xx responses are retryable unless the endpoint
explicitly says otherwise. Endpoint control responses 520–527 are final so a
router can prevent multiplicative retries behind its own retry policy.

## §10 Grammar

GBNF is a local llama-server capability, not a generic provider expectation.
The consumer chooses whether to supply a grammar. The provider never creates or
rewrites one.

When transported, output is validated locally after completion. Divergence
attaches a `grammar_unenforced` notice with its position; the bytes still
return. `PLURNK_PROVIDERS_GBNF_DEBUG` validates but withholds the grammar and
compares the unconstrained result for diagnostics.

## §11 Evidence and metadata

`assistantRaw` is an opaque normalized transport record. Provider top-level
metadata is forwarded as an open bag without reinterpreting currencies or
vendor fields.

Logprobs and verbatim response capture are opt-in, alias-scoped dataset features.
When disabled, the request asks for neither and the response carries neither.
When enabled, raw per-token model logprob is canonical; alternatives are
preserved when returned. Raw body/chunks preserve wire evidence the normalized
record omits.

Readable reasoning and encrypted reasoning are separate. Encrypted reasoning is
preserved verbatim and never decoded or synthesized.

## §12 Generation envelopes

Reasoning and completion reserves are percentages of the resolved context
window or absolute token counts. Absolute pins win. The provider reports the
resolved reserves; the consumer owns prompt packing and the per-call output cap.

Models.dev `maxOutput` constrains a percentage-derived completion reserve but
does not override an explicit absolute operator choice. Unknown model physics
remain unknown.

## §13 Capacity pool

`Pool` fronts interchangeable `Provider` instances. It keeps workers sticky for
cache locality, selects a healthy sibling for overflow, and preserves the same
Provider contract. Whether endpoints are interchangeable is a consumer
decision, not inferred from provider names.

## §14 Conformance

Coverage MUST prove:

- catalog, declaration, local, and plugin resolution;
- exact and unique-suffix model lookup;
- native SDK request mapping and normalized responses;
- compatible extension preservation;
- timeout, retry, cancellation, and final-error behavior;
- local capability probes and pins;
- usage, costs, evidence, metadata isolation, and grammar observation;
- alias scoping and fail-hard invalid configuration.

Mock-only green tests do not establish a vendor integration. Live drills and
integration tests complement this contract; they do not replace its unit-level
proof.
