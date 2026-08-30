# Provider Contract

`@plurnk/plurnk-providers` adapts model endpoints to one stable PLURNK
`Provider`. It does not maintain a parallel vendor registry or reproduce
ordinary provider protocols.

## §1 Ownership

The provider stack has four owners:

1. Models.dev supplies a release-time snapshot of provider package, API
   endpoint, credential names, models, context/input/output limits, reasoning
   capability, and USD rates including distinct reasoning rates when supplied.
2. Official AI SDK providers own vendor request and response protocols.
3. This package owns the PLURNK contract: aliases, envelopes, normalized usage
   and errors, evidence, local capabilities, and first-party metadata.
4. The operator owns secrets, machine-specific endpoints, and deliberate
   metadata overrides through environment variables.

Facts MUST have one owner. Do not copy a cataloged endpoint, credential name,
model prefix, context window, price, or vendor request shape into a PLURNK
table. A missing or wrong catalog fact is fixed upstream, overridden through a
provider declaration, or left explicitly unknown.

The package exposes two runtime-neutral public surfaces:

| Surface | Contract |
| --- | --- |
| §provider-runtime-neutral-accounting `@plurnk/plurnk-providers/accounting` | Provider-request aggregation, Models.dev cost estimation, and their wire types. |
| §provider-runtime-neutral-errors `@plurnk/plurnk-providers/errors` | Normalized `ProviderError`, `ProviderErrorKind`, and the types of its attempt, accounting, and capacity evidence. |

Both surfaces re-export the package's sole implementations without evaluating
Node-only provider discovery, filesystem defaults, or runtime construction.
The package root remains the Node provider-runtime composition surface and is
not a Worker entrypoint.

## §2 Provider interface

§provider-interface `Provider` exposes immutable model facts and one generation
operation:

```ts
interface Provider {
  readonly model: string;
  readonly contextWindow: number | null;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly outputBudget: number | null;
  readonly reasoningBudget: number | null;
  readonly inputCapacity: number | null;
  readonly servedModel?: string;
  readonly constrainsOutput?: boolean;
  readonly requiresOutputBudget?: boolean;

  countPromptTokens(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<PromptTokenMeasurement>;
  assessRequestCapacity(
    messages: readonly ChatMessage[],
    maxOutputTokens?: number,
    signal?: AbortSignal,
  ): Promise<ProviderRequestCapacity>;
  tokenize?(text: string): Promise<number[]>;
  generate(args: GenerateArgs): Promise<ProviderResponse>;
}
```

`contextWindow` is the effective total context envelope resolved under
{§model-fact-resolution}: the minimum of known model capacity and any stricter
operator cap. `null` means genuinely unknown; a consumer MUST NOT invent a
stand-in. The context-window knob is a hard cap, never a model-facing curation
pressure.

§provider-prompt-measurement `PromptTokenMeasurement` is a discriminated
request-level result:

| `kind` | Meaning | Capacity authority |
| --- | --- | --- |
| `exact` | Exact count for the complete provider request. | May prove fit or overflow. |
| `upper_bound` | Proven upper bound for the complete provider request. | May prove fit; exceeding a limit does not prove overflow. |
| `estimate` | Empirical prediction with required causal `detail`. | Cannot admit or reject. |
| `unavailable` | No quantified measurement, with required causal `detail`. | Cannot admit or reject. |

Every result carries a non-empty `source`; quantified kinds carry non-negative
integer `tokens`.
`countPromptTokens` receives the same messages supplied to `generate` and may
perform cancellable provider I/O. The common fallback is chars/2 over message
content; it is announced once and reported honestly as an estimate because it
knows neither the serving vocabulary nor provider-owned request framing.
An adapter may retain that estimate when an optional counting endpoint fails,
provided its detail names the cause; one unable to quantify anything returns
`unavailable`. A malformed measurement is a provider contract violation and
fails hard.

§provider-capacity-admission `assessRequestCapacity` intersects every known
physical input constraint: independent `maxInputTokens` and
`contextWindow - outputBudget`. Its result is `admit`, `reject`, or `defer` and
retains the complete limit and measurement evidence. Exact fit admits; exact
overflow rejects. A proven upper bound admits only when it fits. Unknown limits,
an upper bound above a limit, estimates, and unavailable measurements defer to
the upstream provider as capacity oracle. The same stable intersection is
exposed as `inputCapacity`; `null` means the available limits cannot establish
one. A known combined context and output budget must leave positive input
capacity. Consumers may display or use that fact as policy, but MUST NOT
substitute their own content heuristic for request-shaped admission.

`tokenize` is the separate content-token capability and exists only when the
endpoint exposes its real vocabulary. Content tokenization does not substitute
for complete-request measurement.

§provider-monetary-evidence One precedence path converts each physical provider
request into {§provider-cost} evidence before the request leaves the provider
boundary:

| Precedence | Evidence | Result |
| --- | --- | --- |
| 1 | A documented monetary field on that response or error | The adapter validates and preserves its documented `charged` or `estimated` character; its exact amount wins. |
| 2 | Known response usage and the exact model's Models.dev rates | The adapter returns an exact decimal USD `estimated` amount only when every differently-priced applicable category is known. |
| 3 | Neither | `unknown` with a concrete reason. |

Models.dev is the sole supported fallback rate table. Missing usage, a missing
applicable category, or missing rates never proves zero. An exact zero rate
produces an ordinary estimated amount of USD `0`. Rate calculation is internal
to the provider request; Core, digest, ping, and clients never call a parallel
pricing method.

### Generation

§provider-cache-identity `generate` requires a non-empty, stable, opaque
`workerId`. A durable worker uses one globally unique value for its lifetime;
independent databases and processes cannot mint the same local sequence. A
`bare` call instead uses a fresh per-call value, preventing unrelated prompts
from acquiring affinity with either the parent worker or another BARE call.
Providers MUST NOT interpret either value.

`generate` accepts:

- `messages`: system, user, and assistant text messages;
- caller cancellation through `signal`;
- optional `grammar` and call-specific `maxOutputTokens` tightening;
- standard `sampling` intent;
- the caller-owned `callKind` output contract when one applies;
- opaque attribution tags plus client, strike, workspace, loop, and turn metadata.

§provider-call-kind `callKind` is either `emission` (the response is a PLURNK
turn emission) or `bare` (the response is unconstrained answer text). The
consumer states this semantic fact explicitly; providers MUST NOT infer it from
message count, grammar presence, worker identity, or another incidental request
shape. The first-party adapter transports a supplied value as
`Plurnk-Call-Kind`; the metadata gate drops it for every third-party backend.
The signal is request metadata and never enters model-facing messages. Generic
provider callers MAY omit it; Core supplies it for every model call.

A successful return carries the model's raw content and reasoning, normalized
finish reason, model identity, its ordered {§provider-request-accounting}, the
request's `ProviderRequestCapacity`, opaque evidence, optional metadata, and
optional notices. A `ProviderError` carries the same available capacity and
accounting evidence. The provider transports and observes model
output; it never retries, discards, or repairs an otherwise completed exchange
because PLURNK grammar did not accept it.

§provider-request-observer When a consumer supplies the request observer, the
adapter opens one durable identity through it immediately before each physical
I/O and settles that identity with the resulting
`ProviderRequestAccounting`. This applies to generation retries and capacity
failover as well as every standard embedding `doEmbed` occurrence. The
observer is a durability sink, not an alternate evidence representation; the
same ordered records remain on the final generation or embedding result or
error.

§provider-reasoning-observer When a consumer supplies `observeReasoning`, the
provider synchronously delivers each exact, ordered, nonempty readable-reasoning
delta as it becomes available. A transport without incremental reasoning emits
the complete normalized value once before resolving. This is transient
observation, not response authority: `ProviderResponse` or `ProviderError`
remains the complete settled evidence. An automatically retried physical
request may therefore expose a partial failed-attempt prefix before a later
attempt settles. The consumer uses each `observeRequest` opening as the boundary
between those physical-request reasoning streams: it preserves the failed
prefix, gives the retry a distinct presentation identity, and never concatenates
separate stochastic attempts into one reasoning message.

Usage obeys {§provider-usage}:

```text
totalTokens = inputTokens + outputTokens
cacheReadTokens, cacheWriteTokens ⊆ inputTokens
reasoningTokens ⊆ outputTokens
```

Unknown fields remain absent. Ordinary vendor finish reasons normalize to
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
When the upstream reports only combined output usage, that value remains
`outputTokens` and its unavailable text/reasoning detail stays absent. The
adapter never apportions tokens from character lengths.

Grammar evidence retains the exact pre-projection sentence and its Unicode
content offset. Response classification cannot rewrite what a transported GBNF
rail observed.

## §3 AI SDK boundary

§provider-sdk-boundary Cataloged providers instantiate their
Models.dev-declared AI SDK package.
Standard request shaping, streaming, usage, and vendor error parsing belong to
the SDK. PLURNK supplies cancellation and deadline signals and owns the sole
cross-attempt scheduler so every physical request remains observable and
accountable.

PLURNK maps its generic settings to AI SDK call settings:

- `temperature`, `top_p`, `top_k`;
- presence and frequency penalties;
- stop sequences and seed;
- output-token ceiling;
- `off`, `adaptive`, or fixed `low`, `medium`, or `high` reasoning policy, with
  an independent optional operator budget.

Provider-specific options are permitted only where they preserve a documented
PLURNK product contract the generic SDK surface cannot express.

§provider-reasoning-policy The portable vocabulary comes from
{§reasoning-policy-wire}. `adaptive` requests the provider's
documented dynamic mechanism where one exists. Otherwise, a cataloged graded
route receives its strongest positive Models.dev effort that the installed
transport can represent; a route with no caller-selectable effort uses its
provider default. A fixed policy retains its exact name and is rejected before
provider I/O when either the route or transport cannot represent it. Every
provider exposes that exact intersection. A numeric reasoning budget constrains
the generation envelope independently and never selects or changes policy.

Models.dev's route-specific `reasoning_options` is the capability authority;
the installed AI SDK or explicit compatible adapter owns the wire projection:

| Catalog fact | `adaptive` projection | Portable policies admitted in addition to `adaptive` |
| --- | --- | --- |
| `reasoning: false` | No reasoning request | `off` |
| `reasoning_options: []` | Provider default | None |
| `effort.values` | Native dynamic mechanism, otherwise strongest transportable positive value | Exact members of `low`, `medium`, and `high`; `off` only when `none` is transportable |
| `toggle` | Native or explicitly declared activation, otherwise provider default | `off` only when that transport owns the toggle wire |
| `budget_tokens` | Does not select policy | None; an adapter may use its bounds when projecting the independent budget |
| No catalog entry | Explicit adapter declaration | Only the declaration's exact subset |

The OpenRouter adapter reads neither the generic `reasoning` call setting nor
provider options for its request; a fixed policy and `off` are represented in
its model settings (`reasoning: { effort }`, `off` as `none`), and `adaptive`
sends no reasoning setting on that route.

Models.dev identifies the route's controls but not a provider-specific toggle
or budget field name. The adapter supplies that last-mile mechanism; it never
invents a cataloged effort value.

§provider-readable-reasoning When the effective reasoning posture is not
`off`, a native adapter MUST request readable reasoning summaries if its
provider requires a separate response-visibility option. That option neither
activates reasoning nor selects its depth. The exact wire projection belongs to
the provider adapter; Models.dev's reasoning bit remains capability metadata.

§provider-sdk-warning AI SDK compatibility, unsupported-feature, deprecation,
and other call warnings become source-attributed provider Notices on the
successful exchange. A lossy adapter projection is therefore observable rather
than disappearing in transport internals.

§provider-cache-affinity **Cache affinity is route-owned request projection.**
When a provider documents a semantics-preserving conversation, session, or
prompt-cache routing key, its catalog adapter projects `workerId` through that
provider's documented header, body field, or native SDK option. The common
transport neither guesses from protocol resemblance nor sends a generic cache
field to an unknown provider. The operator may disable affinity globally or per
alias; automatic provider caching without an affinity control remains untouched.

§provider-cache-write-policy **Cache-write policy is separate from affinity.**
`PLURNK_PROVIDERS_CACHE_WRITE_POLICY` is `off` or `stable-system`. The latter
marks only the final leading system instruction as an explicit reusable cache
boundary, and only on routes whose native SDK documents that control. It does
not mark the changing user packet or enable an API-wide automatic cache mode.
Unsupported routes receive no invented option. The default five-minute
provider lifetime is used; a longer, differently priced lifetime is not an
implicit transport choice.

§deepseek-reasoning-request The direct DeepSeek catalog path maps the common
reasoning intent to its OpenAI-compatible controls:

| PLURNK posture | `thinking`            | `reasoning_effort`   |
| --------------- | --------------------- | -------------------- |
| `off`           | `{ type: disabled }`  | omitted              |
| `adaptive`      | `{ type: enabled }`   | omitted              |
| `high`          | `{ type: enabled }`   | `high`                |

The direct API does not distinguish portable `low` or `medium` intent and
therefore advertises only `off`, `adaptive`, and `high`.

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
- operation, physical-attempt, first-content, stream-idle, retry, and probe budgets;
- local GBNF and llama-server capability pins;
- context-window and generation-envelope overrides;
- provider-documented cache affinity and explicit cache-write policy;
- opt-in logprob and raw-body capture.

Operator secrets and machine-specific values never belong in committed
defaults.

## §5 Resolution

§provider-resolution `PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an
alias.
`PLURNK_MODEL=<selector>` selects either a declared alias or an exact
`<provider>/<model-id>` route. Model IDs may contain `/`; only the first slash
separates provider from model. Exact routes carry no fabricated alias and use
the global provider configuration. Declared aliases retain their provenance,
endpoint override, and alias-scoped tuning.
`PLURNK_BASEURL_<alias>` is a per-alias endpoint override.

§provider-embedding-resolution Embedding-model construction uses the same
provider identity, endpoint precedence, credential declaration, environment
expansion, and readiness predicate as generation-model construction. The
public resolver returns an AI SDK `EmbeddingModelV4` plus the canonical
provider/model identity; it does not own dimensions, token windows,
query/document policy, or vector-space identity. Those are embedding-profile
facts ({§mimetype-embedding-profile}).

| Catalog package | Embedding adapter |
| --- | --- |
| AI SDK package with an embedding-model constructor | Its official embedding model. |
| `@ai-sdk/openai-compatible` | Standard `/embeddings` model using the cataloged or declared base URL and credential. |
| AI SDK package without embedding support | Precise unsupported-capability failure before transport. |

Cloudflare, Fireworks, and a declared local OpenAI-compatible server therefore
share one adapter family; OpenRouter uses its official SDK embedding surface.
Provider construction performs no request and never infers model facts from a
probe.

§model-catalog-readiness **Catalog readiness and construction share one local
configuration predicate.** For each Models.dev provider, readiness evaluates
the same effective credential names, endpoint template coordinates, base-URL
precedence, and alternative Bedrock authentication sets used by construction.
It makes no request and validates no credential value. A ready result therefore
means only “configured enough to attempt”; missing causes contain environment
names without values. Construction rejects the same missing requirements at
the provider boundary instead of deferring a known configuration failure to a
model request.

### §model-fact-resolution Model fact precedence

Provider and model facts resolve independently:

| Fact | Natural source | Operator source | Effective value |
| --- | --- | --- | --- |
| Context window | Catalog metadata or local endpoint probe. | `PLURNK_PROVIDERS_CONTEXT_WINDOW`. | Minimum when both exist; sole value otherwise. Cataloged cloud miss fails construction; compatible probe miss remains `null` with one warning. |
| Maximum input | Catalog `limit.input`; no generic live probe. | None. | Catalog value or `null`; never reconstructed from context and output. |
| Maximum output | Catalog `limit.output`; no generic live probe. | None. | Minimum of catalog value and effective context, or `null`. |
| Total output budget | None. | `PLURNK_PROVIDERS_OUTPUT_BUDGET`. | Percentage of effective context or absolute count, capped by known context/output limits; a call may only tighten it. |
| Reasoning policy | Catalog `reasoning_options` intersected with the installed adapter; explicit adapter declaration for uncataloged routes. | `PLURNK_PROVIDERS_REASONING`, initially; durable worker selection thereafter. | One supported member of `off`, `adaptive`, `low`, `medium`, or `high`; `adaptive` is the default. |
| Reasoning budget | None. | Optional `PLURNK_PROVIDERS_REASONING_BUDGET`. | Percentage of effective context or absolute count; valid only as a strict subset of total output and effective unless reasoning is `off`. |
| Reasoning capability | Catalog `reasoning` and route-specific `reasoning_options`. | Adapter wire style only where the catalog cannot name the native field. | Catalog controls determine admissible policy; the adapter determines its wire projection. |
| Estimated USD rates | Models.dev input, output, optional reasoning, and optional cache rates. | None. | Missing differently-priced usage or rates produces unknown; exact all-zero rates produces estimated USD zero. |

Models.dev cache-read and cache-write rates default to the input rate, and the
reasoning rate defaults to the output rate, when omitted. A differently priced
category requires its corresponding usage detail or the request estimate is
unknown.

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

The catalog package identifies the protocol family, not a mandatory client
implementation. xAI uses its documented OpenAI-compatible response directly
because that wire includes exact cost ticks the corresponding AI SDK projection
omits.

§provider-fact-authority Provider declarations configure facts, not
credentials, and Models.dev is authoritative for cataloged providers: package
defaults never redefine a cataloged provider's NPM package, endpoint, or
credential names, and one declaration's `API_KEY_ENV` holds exactly one
environment name — an ordered fallback list would paper over an
operator/catalog naming mismatch instead of reconciling it at its owning
boundary. A comma-separated value is rejected at construction.

```dotenv
PLURNK_PROVIDERS_PROVIDER_ACME_NPM=@ai-sdk/openai-compatible
PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL=https://api.acme.example/v1
PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV=ACME_API_KEY
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

§provider-grammar-transport A plugin whose backend accepts a llama.cpp-style
GBNF grammar may declare `plurnk.grammarStyle: "llamacpp"` beside its kind and
name; the discovery records it and the adapted Provider carries the capability,
so an operator-configured rail ({§grammar-rail-registration}) rides the wire
exactly as on a probed llama-server. Absence or `"none"` keeps the grammar off
the wire; any other value fails discovery loudly. The declaration is the
plugin author's fact about their backend — a wrong declaration fails at the
rail-truth boundary ({§rail-truth-engine-verdict}), never by degrading
admission.

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
- the requirement that the adapter apply a finite output budget.

`PLURNK_PROVIDERS_LLAMA_SERVER` may force or disable detection. Probe attempts
and delay are knobs. A failed probe does not silently assert capabilities.

Ollama probes `/api/show` for its model context and uses its documented
OpenAI-compatible generation endpoint through the SDK adapter.

### llama-server reasoning

For a detected llama-server, PLURNK sends the complete reasoning contract on
every request:

| Posture | Template activation | `thinking_budget_tokens` |
|---|---:|---:|
| `off` | false | `0` |
| `adaptive` | true | configured reasoning subset, otherwise omitted |

The template control cannot express distinct fixed effort levels, so this
adapter advertises only `off` and `adaptive`.

The allowance is contained by the request's total output budget. Template calls
normally use `reasoning_format: "auto"` for a separate
readable channel. A GBNF-bearing call uses `"none"` so the exact constrained
sentence survives response projection; the adapter separates its leading
reasoning enclosure only after preserving grammar evidence. Process-wide
llama-server flags are fallback server configuration, not part of the PLURNK
contract and need not be synchronized with an alias.

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
- cache affinity identity or cache-write policy.

Generic AI SDK calls accept only settings represented by the SDK's portable
surface. Compatible endpoints may carry additional sampling keys after reserved
keys are removed.

First-party attribution, client, strike, workspace, loop, turn, and worker
headers are sent only by the `plurnk` provider. They never leak to another
backend.

§openrouter-app-attribution **The cataloged OpenRouter route identifies the
calling application through OpenRouter's current app-attribution headers.**
`HTTP-Referer` is the absolute HTTP(S) application URL and
`X-OpenRouter-Title` is its optional display title. The shipped floor identifies
the public Plurnk repository and may be replaced by operator configuration; an
explicitly empty `OPENROUTER_HTTP_REFERER` suppresses both headers. Attribution
applies only to the cataloged `openrouter` route and never leaks to another
provider merely because it uses the same SDK package.

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

§provider-capacity-failure A proven exact preflight overflow and an upstream
context rejection normalize to `ProviderError(kind="capacity_exceeded")` and
an RFC 9457 status 413. `capacityStage` is `preflight` or `upstream`; a
non-413 upstream status remains `providerStatus`, while physical request
accounting retains the status actually received. Preflight rejection occurs
before provider I/O and therefore opens no request identity and creates no
request-accounting row. Capacity failures are not connectivity failures and are
never retried by the provider scheduler; bounded packet recovery belongs to the
consumer.

§provider-connectivity The provider adapter owns one attempt scheduler around
the complete generation exchange; SDK-internal retries are disabled.
`PLURNK_PROVIDERS_RETRY_ATTEMPTS=N` permits at most `N + 1` physical requests.
The layers are independent and a configured value of zero disables only that
deadline:

| Layer | Operator knob | Boundary | Expiry |
| --- | --- | --- | --- |
| Operation | `PLURNK_PROVIDERS_OPERATION_TIMEOUT` | Complete logical call, including every attempt and retry delay. | Final `deadline_exceeded` Problem at 504 with `timeoutPhase=operation`; never retried. |
| Attempt | `PLURNK_PROVIDERS_FETCH_TIMEOUT` | One physical generation request, including response consumption. | Retryable `network_failure` with `timeoutPhase=attempt`. |
| First content | `PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT` | Response-stream start through first semantic model content; metadata, empty deltas, and transport activity do not satisfy it. | Retryable `network_failure` with `timeoutPhase=first_content`. |
| Stream idle | `PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT` | Silence between semantic content chunks after content begins. | Retryable `network_failure` with `timeoutPhase=stream_idle`. |

Caller cancellation spans the operation and preserves the caller's reason.
Inner deadline failures consume the ordinary retry budget; retry exhaustion
adds `attempts` and `retryExhausted`, retains the inner `timeoutPhase` and
`timeoutMs`, and is final. Every scheduler iteration opens and settles exactly
one ordered {§provider-request-accounting} record, including response-less
network failures and timed-out attempts.

Each streamed physical request assembles its own response. Failed partial answer
bytes never enter a later request's completed `ProviderResponse`; recovery is a
complete re-emission, not continuation or salvage. When a retry succeeds after
a failed request emitted nonempty text or reasoning, the accepted response
carries one `provider_retry` warning identifying that fact. A retry before any
semantic model output remains silent while its physical failure stays cardinally
accounted. Transient reasoning follows {§provider-reasoning-observer}.

HTTP 408, 409, 429, and ordinary 5xx responses are retryable unless the endpoint
explicitly says otherwise through `X-Should-Retry`. That header is authoritative;
without an explicit directive, endpoint control responses 520–527 are final so
a router can prevent multiplicative retries behind its own policy.

### §provider-interrupted-attempt Provider-declared interruption

A successful transport response can still declare that inference did not
complete. That response is evidence for one failed provider attempt, never a
completed exchange.

| Concern                    | Contract                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Normalized finish reason   | Exact `insufficient_system_resource` becomes `resource_interrupted`; the raw value remains in `assistantRaw`.                |
| `generate` outcome         | Throw `ProviderError(kind="resource_interrupted")` at local status 503 with the normalized attempt on `error.attempt` and the same accounting on `error.accounting`. |
| Partial response           | Preserve content, reasoning, usage, model, metadata, optional raw body, and other evidence without admitting it as success.  |
| Automatic replay           | None; the Problem has `retryable: false`, and AI SDK retry scheduling has already completed at the successful transport.     |
| Capacity-pool overflow     | None under the existing routing policy; when other overflow-eligible failures do reach a sibling, the pool concatenates their request accounting. |
| Consumer admission         | Persist the evidence as an unaccepted attempt; never parse it into executable work, even when its frame looks complete.      |

## §10 Grammar

GBNF is a local llama-server capability, not a generic provider expectation.
The consumer chooses whether to supply a grammar. The provider never creates or
rewrites one.

GBNF defines the accepted sampled text; it runs before response reasoning is
separated from regular content. A generated rail may declare a response root
that composes a template-provided prefix for independent evidence grading. The shipped PLURNK sentence is owned by
`plurnk-contracts` {§gbnf-turn-shape} and {§gbnf-reasoning-boundary}; this package does
not restate or rewrite it.

When a grammar-capable adapter receives a grammar, `ProviderResponse` carries
`grammarEvidence: { input, contentStart, transported }`. `input` is the exact
pre-projection sentence represented by the response, `contentStart` is its
Unicode-code-point offset to `assistant.content`, and `transported` says whether
the grammar was actually sent. Active llama-server template reasoning requests
the unprojected sentence, records it, and then separates its leading enclosure;
an empty body therefore remains observable. An endpoint that projects despite
that request supplies no independent evidence. For an unsplit response, `input`
is `content` and `contentStart` is zero.

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

§provider-generation-envelope Every request has at most one total output
budget. It includes visible output and hidden reasoning. An optional reasoning
budget is a strict subset of that total, never an additive reserve. The
configured total is a percentage of effective context or an absolute count;
percentages resolve to the nearest whole token with a one-token minimum. It is
capped by known context and model-output limits; `generate.maxOutputTokens` may
only tighten it for one call. The effective reasoning subset tightens with that
total and remains strictly smaller.

The adapter owns native projection. A backend whose generic SDK maximum already
includes reasoning receives the total directly. When a native SDK instead adds
an explicit reasoning allowance to its generic visible-output maximum, the
adapter sends `total - reasoning` through the generic field and the reasoning
subset through the documented provider option. Core and other callers never
reconstruct this arithmetic. When such a backend has only a manual allowance
and no numeric subset is configured, the adapter derives that allowance from
the durable policy inside the total using the native SDK's effort proportions
and provider minimum; an envelope too small to represent the minimum fails
before provider I/O.

§provider-output-budget-conformance When a completed response reports
normalized output-token usage greater than its effective total output budget,
the exchange is an `invalid_response` at 502 rather than an admitted result or
a prompt-capacity 413. Its complete failed-attempt evidence and settled charged
request remain available. The violation is final and is never automatically
replayed. Missing output usage cannot prove a violation.

`PLURNK_PROVIDERS_OUTPUT_BUDGET` is required for standard providers and ships
as `35%`. `PLURNK_PROVIDERS_REASONING_BUDGET` is optional; leaving it unset
preserves provider-adaptive depth. A backend known to decode without a finite
limit advertises `requiresOutputBudget` and fails construction when no total can
be resolved. The retired additive reserve knobs fail hard rather than creating
a second envelope contract.

## §13 Capacity pool

§provider-capacity-pool `Pool` fronts interchangeable `Provider` instances. It
keeps workers sticky for
cache locality, selects a healthy sibling for overflow, and preserves the same
Provider contract. Whether endpoints are interchangeable is a consumer
decision, not inferred from provider names. Overflow is limited to transport
availability and rate-limit failures that carry no normalized response attempt;
{§provider-interrupted-attempt} propagates without overflow.

Prompt measurement covers every backend that could receive the request. The
pool takes the largest quantified result; differing exact counts or any proven
bound yield an `upper_bound`, any estimate makes the aggregate an estimate, and
any unavailable backend makes it unavailable. Physical limits and budgets are
independent safe minima across the pool. `inputCapacity` is the minimum of each
backend's complete derived input capacity, never a synthetic subtraction across
minima from different backends; request-specific output tightening repeats the
complete-envelope derivation per backend before taking the minimum.

## §14 Conformance

Coverage MUST prove:

- catalog, declaration, local, and plugin resolution;
- exact and unique-suffix model lookup;
- native SDK request mapping and normalized responses;
- compatible extension preservation;
- timeout, retry, cancellation, interrupted-attempt, and final-error behavior;
- local capability probes and pins;
- exact, bounded, estimated, and unavailable complete-request measurements;
- independent input/context/output limits, asymmetric admission, and normalized
  local/upstream capacity failures;
- one total output budget and native additive-reasoning projection;
- provider-reported output beyond that budget failing once with complete
  attempt and accounting evidence;
- local reasoning activation, response-wide allowance, and GBNF coexistence;
- explicit tagged-reasoning projection across streamed, buffered, capped, and
  literal-tag responses;
- usage, costs, evidence, metadata isolation, and grammar observation;
- alias scoping and fail-hard invalid configuration.

Mock-only green tests do not establish a vendor integration. Live drills and
integration tests complement this contract; they do not replace its unit-level
proof.
