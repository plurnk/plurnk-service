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
`contextWindow - outputFloor`, the input wall ({§provider-output-floor}). Its result is `admit`, `reject`, or `defer` and
retains the complete limit and measurement evidence. Exact fit admits; exact
overflow of the wall rejects; a prompt between the curation reservation and the wall is admitted with its grant flexed down. A proven upper bound admits only when it fits. Unknown limits,
an upper bound above a limit, estimates, and unavailable measurements defer to
the upstream provider as capacity oracle. The curation reservation's intersection, `maxInputTokens` and `contextWindow - outputBudget`, is
exposed as `inputCapacity`, the line Core packs the room against; the wall's, as `inputWall`; `null` means the available limits cannot establish
one. A known combined context and output budget must leave positive input
capacity. Consumers may display or use that fact as policy, but MUST NOT
substitute their own content heuristic for request-shaped admission. A consumer
may assess a request before sending it; `generate` repeats the assessment as its
own guard.

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

Router accounting uses the complete cost to the caller, not just the router's
fee. OpenRouter's response `usage` is authoritative; its SDK metadata projection
omits the BYOK discriminator. Apply the same rule to successful and failed
requests, independently of raw-body capture:

| OpenRouter evidence | Monetary result |
| --- | --- |
| `is_byok: false` and `cost` | `charged`: `cost`; upstream inference is already included. |
| `is_byok: true`, `cost`, and `cost_details.upstream_inference_cost` | `charged`: exact decimal sum of router fee and upstream charge. |
| A monetary field without a BYOK discriminator, or BYOK missing either component | `unknown`; neither zero nor catalog pricing completes the reported charge. |
| No reported charge and no BYOK indication | Ordinary Models.dev fallback above. |

Explicit zero components are valid. Malformed monetary values are contract
violations, never coerced. Raw routing and billing evidence remain available
under {§provider-evidence}; Core and clients consume the existing single cost.
See [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

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
shape. The signal never enters model-facing messages. Generic
provider callers MAY omit it; Core supplies it for every model call.

§provider-native-tools-disabled Generation requests declare no native tools and
select the SDK's portable `none` tool choice, for emissions and BARE alike.
The built-in transports preserve that intent after SDK serialization:

| Protocol | No-tool wire representation |
| --- | --- |
| OpenAI-compatible Chat Completions and Responses | `tools: []`, `tool_choice: "none"` |
| Anthropic Messages | `tools: []`, `tool_choice: {"type":"none"}` |
| Gemini GenerateContent | `tools: []`, `toolConfig: {"functionCallingConfig":{"mode":"NONE"}}` |
| Bedrock Converse | No tool configuration; the protocol has no `none` choice. |
| Installed SDK provider extensions | Portable `none` intent; the extension owns its wire projection. |

This is a text-generation contract, not provider/model tuning or prompt
teaching. Callers cannot supply tools or override the choice through request
extensions. Do not add deprecated function-call fields, dummy tools, or fields
from another protocol. The opt-out neither constrains arbitrary prose nor
proves that an endpoint honors it; unexpected native calls retain their full
evidence and follow {§provider-native-tool-calls}.

A successful return carries the model's raw content and reasoning, normalized
finish reason, model identity, its ordered {§provider-request-accounting}, the
request's `ProviderRequestCapacity`, opaque evidence, optional metadata, and
optional notices. A `ProviderError` carries the same available capacity and
accounting evidence. The provider transports and observes model
output; it never retries, discards, or repairs an otherwise completed exchange
because PLURNK grammar did not accept it.

§provider-generation-completion Stream consumption follows the provider's
completion boundary, subject to caller cancellation and configured deadlines.
Repeated content or reasoning does not interrupt a response or request another
generation. Preserve the complete response, its finish reason, and trailing
usage and charge evidence before returning it to the consumer.

§provider-request-observer When a consumer supplies the request observer, the
adapter opens one durable identity through it immediately before each physical
I/O and settles that identity with the resulting
`ProviderRequestAccounting`. This applies to generation retries and capacity
failover. The
observer is a durability sink, not an alternate evidence representation; the
same ordered records remain on the final generation result or
error.

The adapter also settles {§provider-request-evidence}. A successful request
retains its normalized transport response; a failed request retains received
SDK raw chunks (or the error response body), partial content and reasoning,
available response identity/headers, usage/charge evidence, and its error and
cancellation cause. Failure capture is independent of successful raw-body
capture. These are the SDK's received values, not a claim of byte-for-byte
HTTP capture. Settlement is durable before returning the failure; a process
crash before settlement leaves a pending request, not an invented response.

§provider-dispatched-request With `PLURNK_PROVIDERS_RAWBODY` enabled, installed
SDK transports also retain the exact serialized generation request body at
their injected fetch boundary, after all owned body transformations. Capture
is scoped to the physical request and settles with its existing forensic
evidence on success or failure; it does not reconstruct a body from settings.
Only the HTTP method, origin and body are recorded: no request headers,
userinfo, path, query or fragment. The body itself contains the supplied model
input and must be treated as sensitive evidence. An external SDK model whose
transport is not instrumented, disabled capture, or an unsettled request makes
no capture claim. Existing accounting, failure evidence, cancellation and
retention are unchanged.

Native SDK construction binds each physical request's injected fetch after
owned body transforms; compatible routes use the same request-scoped closure.
Capture adds no global interception, runtime-specific context storage or
cross-request mutable recorder. An externally supplied model instance remains
opaque; a model factory can accept the injected fetch to participate.

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
present. Streamed and buffered transports use the same leading-envelope parser.
An enabled tagged projection delivers readable deltas as content chunks arrive,
holding only incomplete delimiter prefixes; it does not wait for the closing
tag or response completion. An unfinished closing prefix is literal reasoning
at EOF. Constrained template calls that retain the grammar sentence use the
same path for `<think>\n…</think>` and `<|channel>thought\n…<channel|>`.
Observation resets for each physical request and completed reasoning is not
replayed. Neither the internal working copy nor its curation supplies this stream.
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

| Usage input | Normalization |
| --- | --- |
| Native protocol | Preserve the SDK's inclusive totals and category counts; raw protocol counters are evidence, not interchangeable totals. |
| OpenAI-compatible wire | Retain extended counters and exact total identities the SDK may omit. |
| Compatible SDK input partition | Retain its uncached count when total input and an explicitly reported cache-read count agree with the wire; never promote SDK defaults over absent or contradictory wire counts. |
| Input total plus two partition counts | Derive the remaining count exactly; otherwise preserve absence. |

PLURNK maps its generic settings to AI SDK call settings:

- `temperature`, `top_p`, `top_k`;
- presence and frequency penalties;
- stop sequences and seed;
- output-token ceiling;
- the supported efforts and optional numeric control under
  {§provider-effort}.

Provider-specific options are permitted only where they preserve a documented
PLURNK product contract the generic SDK surface cannot express.

§operator-cost-override **Models.dev is the rate starting point; the operator may
overlay it.** `PLURNK_PROVIDERS_COST` declares exact per-1M-token USD rates as
comma-separated `key=value` over the catalog vocabulary (`input`, `output`,
`reasoning`, `cacheRead`, `cacheWrite`), alias-scoped like every provider knob.
Declared keys merge over the Models.dev cost block; undeclared keys keep the
catalog figure. Without catalog rates the override must declare `input` and
`output`. The estimate's `source` names the override, and a provider-reported
response cost still outranks any estimate. Unknown keys, repeats, and negative
or non-numeric rates refuse at construction.

§provider-effort The portable vocabulary comes from
{§effort-wire}. `adaptive` uses the first applicable projection:

| Condition | Projection |
| --- | --- |
| Explicit adaptive declaration: `REASONING_ADAPTIVE_BODY`, or a native model family's `ADAPTIVE_OPTIONS` ({§provider-model-options}) | Preserve that mechanism; an explicit `{}` retains the enabled endpoint's default. |
| The configured `PLURNK_PROVIDERS_EFFORT_FALLBACK` is supported by both model and transport | Send that exact effort. The shipped fallback is `high`, not the strongest available level. |
| No supported fallback, including an empty fallback setting | Retain reasoning activation and the provider's default effort; never invent a level or escalate to another one. |

Activation is distinct from effort: declared enable fields accompany active
reasoning, and a toggle-only route uses its documented enable mechanism.
Non-reasoning models receive no reasoning controls; `off` is the explicit opt-out.
A fixed policy retains its exact name and is rejected before provider I/O when
either the route or transport cannot represent it. Every provider exposes that
exact intersection. A numeric reasoning budget constrains
the generation envelope independently and never selects or changes policy. On
routes whose controls are exclusive, fixed effort plus a numeric budget is
rejected before I/O. Under `adaptive`, an explicit budget selects the numeric
control; `off` suppresses it.

`catalogEfforts` projects that same admission calculation from catalog
facts and provider-wide environment declarations over the installed defaults,
without constructing a model, requiring credentials, or performing provider I/O.
Admission respects the installed projection: native SDK fixed efforts exclude
`max`; declared transport vocabularies constrain per-call option projections.

Models.dev's route-specific `reasoning_options` is the capability authority for
what the daemon offers on its own; the daemon never adds vendor behaviour absent
from the catalog. The operator may declare efforts a provider's reasoning routes
accept (`PLURNK_PROVIDERS_PROVIDER_<PREFIX>_REASONING_EFFORTS`, comma-separated
portable names); declared efforts join the catalog's for policy admission and the
`adaptive` projection under the same transport rule, a declared `none` admits
`off` where the transport can express it, and a host that rejects a declared
effort answers on the first request rather than at boot. The declaration never
turns a non-reasoning route into a reasoning one. The installed AI SDK or
explicit compatible adapter owns the wire projection:

| Catalog fact | `adaptive` projection | Portable policies admitted in addition to `adaptive` |
| --- | --- | --- |
| `reasoning: false` | No reasoning request | `off` |
| `reasoning_options: []` | Provider default | None |
| `effort.values` | Native dynamic mechanism, otherwise the supported configured fallback or provider default | Transportable fixed members of {§effort-wire}; `off` only when `none` is transportable |
| `toggle` | Native or explicitly declared activation, otherwise provider default | `off` only when that transport owns the toggle wire |
| `budget_tokens` | Does not select policy | None; an adapter may use its bounds when projecting the independent budget |
| No catalog entry | Explicit adapter declaration | Only the declaration's exact subset |
| Operator-declared efforts | Join the catalog's `effort.values` for that provider's reasoning routes | Their exact members, under the transport rule above |

Models.dev identifies the route's controls but not a provider-specific toggle
or budget field name. The adapter supplies that last-mile mechanism; it never
invents a cataloged effort value.

§provider-readable-reasoning Route-owned options may request exposed reasoning
text. Normalization follows {§provider-open-reasoning}; Models.dev's reasoning
bit is capability metadata, not a statement about returned text's fidelity.
Billing without exposed text does not create a reasoning source.

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
The environment's `CACHE_AFFINITY_FIELD` declares that placement as
`{"target":"header"|"body","name":"…"}` or
`{"target":"provider-option","provider":"…","name":"…"}`. It follows
the provider/route/alias precedence of {§provider-wire-declaration}; `null`
clears the declaration. Placement is independent of the enable switch, cannot
replace transport-owned fields, and does not imply support from a provider's name.

§provider-model-options **A model family's native options are a provider declaration.** Models.dev
does not say which models on a native SDK take adaptive reasoning or explicit cache writes, and the SDKs
do not export their tables, so a provider declares them as data: `ADAPTIVE_OPTIONS` and
`SYSTEM_CACHE_OPTIONS` are JSON arrays of `{"models":["<glob>",…],"options":{…}}` rules. The first rule
with a glob matching the route's model id (`path.matchesGlob`) supplies its per-call provider options;
without a match none apply. They follow the provider/route/alias precedence of
{§provider-wire-declaration}, an empty value declares none, and a malformed value fails construction.
None ships: Plurnk's shipped defaults serve open models only, and an operator who routes a closed model
family declares its options in their own configuration.

§provider-cache-write-policy **Cache-write policy is separate from affinity.**
`PLURNK_PROVIDERS_CACHE_WRITE_POLICY` is `off` or `stable-system`. The latter
marks only the final leading system instruction as an explicit reusable cache
boundary, and only on routes whose provider declares the control in
`SYSTEM_CACHE_OPTIONS` ({§provider-model-options}). It does
not mark the changing user packet or enable an API-wide automatic cache mode.
Unsupported routes receive no invented option. The default five-minute
provider lifetime is used; a longer, differently priced lifetime is not an
implicit transport choice.

§deepseek-reasoning-request Direct DeepSeek uses the panel's request-field
declarations under {§provider-wire-declaration}. Models.dev supplies each
model's effort vocabulary; it is not a second fixed list in this adapter.

The compatible transport is deliberately retained for:

- `openai` local endpoints, including llama-server and vLLM;
- `ollama`, after its native `/api/show` probe;
- operator-declared `@ai-sdk/openai-compatible` providers.

It carries PLURNK-only fields and raw wire evidence without reimplementing the
SDK's ordinary transport.

### §provider-wire-declaration Request-field declarations

Models.dev owns model capabilities, effort vocabulary, and numeric budget bounds.
For endpoints whose field names it does not describe, the provider's
environment panel supplies a bounded projection, independent of provider identity:

| Declaration suffix | Meaning |
| --- | --- |
| `OPTIONS_NAMESPACE` | Native SDK's per-call `providerOptions` namespace. Without one, declared fields target the compatible request body. |
| `OUTPUT_PATH` | RFC 6901 object-member pointer for the **inclusive** output ceiling; absent uses the compatible SDK's `max_tokens` field. |
| `REASONING_EFFORT_PATH` / `REASONING_BUDGET_PATH` | Pointers for exact effort or numeric reasoning subset. No pointer means no such control. |
| `REASONING_EFFORTS` | Additional declared effort values, unioned with Models.dev. |
| `REASONING_TRANSPORT_EFFORTS` | Optional transport vocabulary, intersected with catalog/declaration efforts. It adds no model capability. |
| `REASONING_CONTROLS` | Required when both pointers exist: `exclusive` refuses fixed effort plus budget; `combined` sends both. |
| `REASONING_ON_BODY` | Static reasoning activation fields, merged with the selected control. |
| `REASONING_OFF_BODY` | Explicit disable fields; otherwise a declared `none` effort can disable. |
| `REASONING_ADAPTIVE_BODY` | Explicit adaptive fields, ahead of graded fallback; `{}` retains the enabled endpoint's default. |
| `REASONING_TOGGLE_BODY` | Reasoning enable fields when Models.dev declares a toggle and neither an explicit adaptive body nor a supported fallback effort applies. |

The existing provider declaration prefix is
`PLURNK_PROVIDERS_PROVIDER_<NAME>_`; `PLURNK_PROVIDERS_<suffix>` overrides
it for the route and accepts the ordinary alias suffix. These are data, not
executable transformations. Static bodies cannot replace transport, sampling,
or managed numeric controls; pointers cannot overlap. Configuration fails at
construction before inference when a requested policy or numeric control is
unrepresentable. A tighter per-call envelope reprojects the same declaration.
Discovery and generation share the resolved policy set. A cataloged
non-reasoning model receives no reasoning fields.
Native SDKs retain their own output field; `OUTPUT_PATH` is incompatible with an
options namespace. Request-local options are projected after the effective
envelope is known, never frozen into SDK model construction. Streaming and
non-streaming calls use the same projection.

A native SDK's portable reasoning setting has no `max`, so a native route without
a namespace cannot send an effort the catalog documents beyond it; construction
refuses it and names the declaration that would. Native SDKs built on
openai-compatible (DeepInfra, Together) write `reasoning_effort` from their own
`reasoningEffort` option after spreading the others, overwriting a raw
`reasoning_effort`; their shipped declarations therefore point at
`/reasoningEffort`, with `{"reasoningEffort":"none"}` as the off body.

## §4 Operator configuration

§provider-configuration Every operational value is an environment knob
documented in `.env.defaults`.
There are no hidden tuning constants. Every `PLURNK_PROVIDERS_*` knob may be
scoped to an alias by appending `_<alias>`; the scoped value wins.
Each projection reads one fresh environment snapshot without modifying its
source; later projections observe later configuration, never a cached view.

The public Node provider registry applies this package's committed
`.env.defaults` as a set-if-unset operational floor. Consumers pass their
operator environment, not a manually composed copy of the provider floor.
Explicit operator values always win and invalid explicit values fail at the
knob's owning contract.

The universal groups are:

- reasoning activation and optional explicit budget;
- explicit reasoning response-content style;
- decode tuning;
- whole-call generation, discovery/tokenizer HTTP, retry, and probe budgets;
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

§model-catalog-readiness **Catalog readiness and construction share one local
configuration predicate.** For each Models.dev provider, readiness evaluates
the same effective credential names, endpoint template coordinates, base-URL
precedence, and alternative Bedrock authentication sets used by construction.
It makes no request and validates no credential value. A ready result therefore
means only “configured enough to attempt”; missing causes contain environment
names without values. Construction rejects the same missing requirements at
the provider boundary instead of deferring a known configuration failure to a
model request.

### §provider-input-modalities Native input parts

A provider declares `inputModalities`, the set of native non-text inputs its model
accepts, from the catalog's input modalities (Models.dev `modalities.input` minus
`text`, kept to the vocabulary `image`, `pdf`, `audio`, `video`; empty when the
model is unknown). A user `ChatMessage` may then carry text beside the AI SDK's
current `{ type: "file", data: bytes, mediaType }` part; `mediaType` distinguishes
an image, PDF, audio, or future native input without a second internal part shape. The
AI SDK transport forwards those parts as the model's native file inputs; it
alone serializes the canonical model and messages before provider extension
fields are merged. System and assistant messages stay text, and prompt-token estimates count text
only, the provider's reported usage owning each part's cost. A pool declares a
modality only when every backend does; the Mock declares them by option and
records every request it receives. Which parts actually ride a request is the
service's decision per attachment ({§packet-attachment-parts} in the core specification).
An accepted modality does not imply every codec/container is supported: SDK or endpoint
format rejections remain provider errors, never silent omission or a text-only substitute.

### §model-fact-resolution Model fact precedence

Provider and model facts resolve independently:

| Fact | Natural source | Operator source | Effective value |
| --- | --- | --- | --- |
| Context window | Catalog metadata or local endpoint probe. | `PLURNK_PROVIDERS_CONTEXT_WINDOW`. | Minimum when both exist; sole value otherwise. Cataloged cloud miss fails construction; compatible probe miss remains `null` with one warning. |
| Maximum input | Catalog `limit.input`; no generic live probe. | None. | Catalog value or `null`; never reconstructed from context and output. |
| Maximum output | Catalog `limit.output`; no generic live probe. | None. | Minimum of catalog value and effective context, or `null`. |
| Total output budget | None. | `PLURNK_PROVIDERS_OUTPUT_BUDGET`. | Curation reservation: percentage of effective context or absolute count, capped by known context/output limits; a call may only tighten it. The response grant flexes under {§provider-flexed-allowance}. |
| Output floor | None. | `PLURNK_PROVIDERS_OUTPUT_FLOOR`, shipped as `10%`. | The least response room any request keeps: percentage of effective context or absolute count, capped by the output budget; `window − floor` is the input wall ({§provider-output-floor}). |
| Effort | Catalog `reasoning_options` intersected with the installed adapter; explicit adapter declaration for uncataloged routes. | `PLURNK_PROVIDERS_EFFORT`, initially; durable worker selection thereafter. | A supported member of {§effort-wire}, projected under {§provider-effort}. The shipped selection is `adaptive`. |
| Reasoning budget | None. | Optional `PLURNK_PROVIDERS_REASONING_BUDGET`. | Percentage of effective context or absolute count; valid only as a strict subset of total output and effective unless reasoning is `off`. |
| Cost override | None. | Optional `PLURNK_PROVIDERS_COST`. | {§operator-cost-override} — comma-separated `key=value` per-1M-token USD rates over `input, output, reasoning, cacheRead, cacheWrite`; merges over the Models.dev catalog block (the catalog is the starting point), alias-scoped like every knob. Without catalog rates the override must declare `input` and `output`. The cost estimate's `source` names the override; a provider-reported response cost still outranks any estimate. |
| Reasoning capability | Catalog `reasoning` and route-specific `reasoning_options`. | Adapter wire style only where the catalog cannot name the native field. | Catalog controls determine admissible policy; the adapter determines its wire projection. |
| Estimated USD rates | Models.dev input, output, optional reasoning, and optional cache rates. | None. | Missing differently-priced usage or rates produces unknown; exact all-zero rates produces estimated USD zero. |

Models.dev cache-read and cache-write rates default to the input rate, and the
reasoning rate defaults to the output rate, when omitted. A differently priced
category requires its corresponding usage detail or the request estimate is
unknown.

The provider segment of a model route IS the Models.dev id (#459) —
configurations align with the catalog end to end (`fireworks-ai/…`,
`cloudflare-workers-ai/@cf/…`, `togetherai/…`), and the
`PLURNK_PROVIDERS_PROVIDER_<PREFIX>_*` prefix is that id uppercased with
non-alphanumerics as underscores (`FIREWORKS_AI`). Custom declared providers
keep their operator-chosen names; the built-in local `ollama` rail keeps its
name (the catalog's `ollama-cloud` is a different provider).

`instantiateProvider` resolves in this order:

1. A Models.dev provider and model, using its declared AI SDK package.
2. An operator provider declaration:
   `PLURNK_PROVIDERS_PROVIDER_<NAME>_{NPM,BASE_URL,API_KEY_ENV}`.
3. The local `openai` or `ollama` adapter.
4. A discovered AI SDK provider extension.
5. A precise unknown-provider error.

Earlier sources are authoritative. Installed extensions cannot shadow a cataloged
or explicitly declared name. This remains true when a named model is absent
from the Models.dev snapshot: construction requires an explicit
`PLURNK_PROVIDERS_CONTEXT_WINDOW` and never falls through to a same-name
extension.

Model IDs resolve exactly first. A unique catalog suffix is accepted to avoid
forcing a vendor-owned resource prefix into PLURNK aliases. Ambiguous suffixes
fail to resolve.

The catalog package identifies the protocol family, not a mandatory client
implementation. OpenRouter charges and DeepInfra estimates use cost normalizers
over documented response fields, retaining their distinct monetary character
under {§provider-monetary-evidence}.

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

## §6 Provider extensions

Provider extensions are the escape hatch for a protocol binding not represented by
Models.dev, installed SDK providers, or a declaration. Most extensibility
belongs in MCP, schemes, executors, or mimetypes instead.

A provider extension:

1. declares the exact string `plurnk: { kind: "provider", name }` in `package.json` ({§extension-kind});
2. may declare always-on package-level `plurnk.attribution` and/or implement the
   synchronous runtime `attributions(context)` hook under {§extension-attribution};
3. may use any npm scope;
4. default-exports an AI SDK provider with `languageModel(modelId)`;
5. peers on compatible `ai` and `@plurnk/plurnk-providers` majors.

§provider-grammar-transport An extension whose backend accepts a llama.cpp-style
GBNF grammar may declare `plurnk.grammarStyle: "llamacpp"` beside its kind and
name; the discovery records it and the adapted Provider carries the capability,
so an operator's grammar file ({§operator-grammar}) rides the wire exactly as
on a probed llama-server. Absence or `"none"` keeps the grammar off the wire;
any other value fails discovery loudly. The declaration is the extension author's
fact about their backend; the transport evidence on each response
({§provider-grammar-evidence}) is where a wrong declaration shows, never by
degrading admission.

PLURNK adapts the returned language model. The extension does not implement the
PLURNK `Provider`, read PLURNK tuning knobs, or reproduce transport policy.

Discovery is scope-agnostic and memoized per process. Duplicate names fail hard.
The common extension trust gate applies before import ({§extension-trust-boundary}). An extension absent from
Models.dev requires an explicit context-window pin because PLURNK will not guess
model physics. `Discovery.packageAttributions` carries the canonical package map.

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

§provider-request-controls **A configured service tier or logprobs count reaches a
native route only through the per-call option its SDK documents.** On a compatible
route, `PLURNK_PROVIDERS_SERVICE_TIER` and `PLURNK_PROVIDERS_TOP_LOGPROBS` are the
body fields `service_tier`, `logprobs` and `top_logprobs`. A native route sends them
in its SDK's `providerOptions` namespace, serialized by that SDK. A control the SDK
does not document is not sent, and one process warning,
`PLURNK_REQUEST_CONTROL_UNSUPPORTED`, names it, so a configured choice never
disappears in silence. The tier passes verbatim: the SDK owns its vocabulary, and a
value it drops surfaces as its call warning ({§provider-sdk-warning}). A logprobs
count of 0 asks for the chosen token only.

| Native SDK | Namespace | Service tier | Logprobs |
| --- | --- | --- | --- |
| OpenAI | `openai` | sent | sent |
| Groq | `groq` | sent | not sent |
| Cerebras | `cerebras` | sent | not sent |
| xAI | `xai` | sent | not sent |
| Google | `google` | sent | not sent |
| Anthropic | `anthropic` | sent | not sent |
| Amazon Bedrock | `bedrock` | sent | not sent |
| Mistral, Together, DeepInfra, OpenRouter | none | not sent | not sent |

§openrouter-app-attribution **A route on the OpenRouter SDK identifies the calling
application only as its provider declares.** `APP_URL`, an absolute HTTP(S) URL, and
the optional `APP_NAME` are provider declarations (`PLURNK_PROVIDERS_PROVIDER_<NAME>_`,
overridable per route or alias); the SDK sends them as `HTTP-Referer` and
`X-OpenRouter-Title`. The shipped floor declares them for `openrouter` only, so
another provider on the same SDK package sends none; an empty `APP_URL` suppresses
both.

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
`retryExhausted`; it does not change the Problem's `retryable`.

§provider-retryable-truth **`retryable` states what happens next.** A Problem's
`retryable` is exactly membership of its kind in the exported
`RETRYABLE_PROVIDER_KINDS` — `rate_limit`, `network_failure`, `deadline_exceeded`,
`resource_interrupted`, `output_dropped` — and Core's provider recovery re-issues
exactly those kinds by reading the same set. It never copies the transport's own
retry policy: a 502 or 524 that the transport will not replay is still re-issued by
the consumer, so it reports `retryable: true`. Every other kind reports `false`.

§provider-failure-cause **The wrapper's cause is evidence, bounded.** The SDK
reports every processing failure of a 2xx body with one message ("Failed to
process successful response") and keeps what happened as `cause`. A normalized
Problem carries that cause as a bounded classification — `cause.causeKind` is
`transport_terminated` (the body ended under a successful status),
`invalid_json`, `schema_invalid`, `invalid_response_data`, or `internal`, with
the cause's error name and one bounded line of its message — so forensics can
tell an interrupted stream from a malformed body without the kind changing:
classification of the Problem (`providerKind`, retryability, accounting) is
untouched by this evidence. The SDK's parse and validation messages embed the
payload, so those two report shape (character count, the validator's issue
line), never response text; no headers, credentials, stack frames, or body
dumps enter any Problem. Covered by `errors.test.ts` (#593).

§provider-capacity-failure A proven exact preflight overflow and an upstream
context rejection normalize to `ProviderError(kind="capacity_exceeded")` and
an RFC 9457 status 413. `capacityStage` is `preflight` or `upstream`; a
non-413 upstream status remains `providerStatus`, while physical request
accounting retains the status actually received. Preflight rejection occurs
before provider I/O and therefore opens no request identity and creates no
request-accounting row. Capacity failures are not connectivity failures and are
never retried by the provider scheduler; bounded packet recovery belongs to the
consumer.

§provider-flexed-allowance **The grant is the window's remainder, between the floor and the model's limit.** The
configured output budget is the reservation curation packs the input against
(`window − outputBudget`), and it is the only allowance the model is ever
shown — the packet's disclosed `tokensResponseMax` stays the configured reservation
so the response discipline it teaches never varies. The wire grants the remainder: with an exact prompt count
(llama-server's input-token endpoint) `window − promptTokens − 256`, clamped to no less than the
output floor and no more than the model's own output limit, so a response overflowing the disclosed reservation
completes whenever the window's unclaimed room can hold it, and a prompt that ate into the reservation still leaves the floor. Every other
measurement kind — and any pool — grants the reservation, clamped by the same remainder taken from the prompt's estimate so the wire never asks the window for more than it has; an estimate proves
nothing about the true remainder, so it never rejects.

§provider-output-floor **The floor is the wall's other side.** `PLURNK_PROVIDERS_OUTPUT_FLOOR`, shipped as `10%`, is the least response room any request keeps, capped by the output budget; `window − floor`, intersected with `maxInputTokens`, is the physical input wall exposed as `inputWall`. A request under the curation reservation is the ordinary case; a request between the reservation and the wall is admitted with its grant flexed down to the remainder; an exact prompt over the wall is rejected before I/O; an estimate over the wall defers to the upstream provider as capacity oracle with its grant at the floor. Core consults the wall, never the reservation, to end a loop ({§context-wall} in the core contract). A response exceeding even the grant is cut,
and the notice names the true per-call grant (`capacity.responseMax` on the
response) — the tolerance's honest edge, never worse than the fixed allowance
it forgives.

§provider-sampling-passthrough **Unconfigured sampling retains endpoint defaults.**
The provider panel owns tuning; Models.dev capabilities are not recommended
sampling values. Every knob accepts the ordinary alias override
({§provider-configuration}). Both cataloged and local providers apply the same
validation and precedence: configured values, then caller `sampling`, then
transport-owned fields ({§provider-request-authority}).

| `PLURNK_PROVIDERS_` suffix | Compatible wire / native SDK | Accepted configuration |
| --- | --- | --- |
| `TEMPERATURE` | `temperature` / `temperature` | Finite non-negative number; empty/unset omits. |
| `TOP_P` | `top_p` / `topP` | Finite number in `[0,1]`; empty/unset omits. |
| `TOP_K` | `top_k` / `topK` | Non-negative safe integer; empty/unset omits. Zero semantics are endpoint-owned. |
| `PRESENCE_PENALTY` | `presence_penalty` / `presencePenalty` | Finite number in `[-2,2]`; empty/unset omits. |
| `FREQUENCY_PENALTY` | `frequency_penalty` / `frequencyPenalty` | Required finite number in `[-2,2]`; the panel's zero selects no configured override. Negative values survive unchanged. |
| `SEED` | `seed` / `seed` | Safe integer; empty/unset omits. No guarantee of reproducibility. |

Configured zero is preserved except for the frequency knob's explicit
no-override sentinel; a caller-supplied zero always overrides a configured value.
Invalid configuration fails by knob name before inference. The SDK/endpoint
owns narrower model restrictions and unsupported-setting diagnostics; Plurnk
does not clamp values or invent model-specific sampling profiles.
`REPEAT_PENALTY` and DRY remain explicit llama-server extensions, omitted when
unconfigured. Their grammar protection remains at {§provider-grammar-transport}.

§provider-connectivity The provider adapter owns one attempt scheduler around
the complete generation exchange; SDK-internal retries are disabled.
`PLURNK_PROVIDERS_RETRY_ATTEMPTS=N` permits at most `N + 1` physical requests.
Generation has one configurable deadline; `0` disables it. Caller cancellation
and the caller's task allowance remain authoritative. Initial silence, a pause
between chunks, and buffered output do not acquire separate deadlines.

| Layer | Operator knob | Boundary | Expiry |
| --- | --- | --- | --- |
| Operation | `PLURNK_PROVIDERS_OPERATION_TIMEOUT` | Complete logical call, including admission queueing, every attempt and retry delay. | Final `deadline_exceeded` Problem at 504 with `timeoutPhase=operation`; not retried inside this operation. Consumer recovery is separate. Enforced as a race, not only the advisory signal, so a wedged transport that never observes the abort cannot hang the loop past the deadline (#505); a well-behaved transport unwinds within a short grace and settles its own attempt evidence first. |
| Discovery/tokenizer HTTP | `PLURNK_PROVIDERS_FETCH_TIMEOUT` | Non-generation endpoint discovery and tokenizer requests only. | Ordinary HTTP failure at the owning discovery or measurement boundary. Never interrupts generation. |

Settled calls remove their deadline timers and cancellation subscriptions.

Caller cancellation spans the operation and preserves the caller's reason.

§provider-cancellation-evidence Received usage/charge evidence and available
response identity survive cancellation and deadline normalization through
physical-request settlement, independently of optional raw-body capture.
This includes SDK abort events and non-Error cancellation reasons. Concurrent
requests keep independent evidence even when cancelled by the same scope.
Absent evidence remains absent; stopping a request neither invents usage nor
retries generation to obtain it. Partial output is never a completed response.

A 2xx exchange whose body cannot be processed (a provider invalid-response)
classifies as the non-retryable 502 on the first failure unless an explicit
`x-should-retry` directive says otherwise (#479). When a
directive-driven retry sequence exhausts, `attempts` and `retryExhausted`
are added and the classification is final. Every admitted physical attempt opens
and settles exactly one ordered {§provider-request-accounting} record, including
response-less network failures and timed-out attempts. A cancelled or expired
admission wait opens no physical request.

Each streamed physical request assembles its own response. Failed partial answer
bytes never enter a later request's completed `ProviderResponse`; recovery is a
complete re-emission, not continuation or salvage. When a retry succeeds after
a failed request emitted nonempty text or reasoning, the accepted response
carries one `provider_retry` warning identifying that fact. A retry before any
semantic model output remains silent while its physical failure stays cardinally
accounted. Transient reasoning follows {§provider-reasoning-observer}.

Only a provider-directed wait earns a transport retry (#479): HTTP 429, any
response carrying `Retry-After` (RFC 9110 defines it on 503 exactly as a
directed wait) — header-level facts the consumer's recovery layer never sees —
and an explicit `X-Should-Retry: true`. That header stays authoritative both
ways, and endpoint control responses 520–527 stay final. HTTP 408, 409, and
ordinary 5xx surface on the first failure as consumer-recoverable kinds; one
retry authority — the consumer's own provider-recovery machinery — owns
re-issue, backoff, and park above the transport.

§provider-native-tool-calls A response with native tool-call data, or a
`tool_calls` finish, preserves its text, reasoning, structured wire evidence,
finish reason and accounting and emits one provider warning. It is not a
transport failure and does not trigger provider recovery. The adapter executes
no call and invents no textual operation; the consumer owns admission and
no-operation handling. The normalized assistant exposes `nativeToolCalls: true`
when either wire calls or a `tool_calls` finish is present, independently of the
preserved finish reason; consumers need not mine wire evidence. Text-only missing-output checks do not apply because
the billed output includes structured calls.

§provider-output-dropped **A completed exchange whose own evidence proves its
text never arrived is `output_dropped`**, a 502 carrying the complete response as
`error.attempt` and `stage: "provider-response"`; it is never admitted as an empty or
truncated turn, and the consumer re-issues it ({§provider-retryable-truth}):

| Evidence | Detail | Facts |
| --- | --- | --- |
| Billed output tokens exceed the code points streamed across every channel — text and reasoning, before projection — by at least `PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS` (`0` disables; an output token decodes to at least one character) | `The provider billed T output tokens but streamed C characters of text and reasoning; at least T−C tokens of output never arrived.` | `billedOutputTokens`, `streamedCharacters`, `droppedOutputTokens` |

The token rule needs a billed output count, and it does not apply when the response bills
reasoning tokens but streamed no reasoning in any channel: that is hidden or summarized
reasoning, which the characters cannot account for. Text-only comparisons are not made —
a route may bill reasoning inside its text count.

§provider-request-rejection An HTTP 4xx rejection not classified as authorization,
quota, capacity, grammar, rate limit, or transient transport failure is
`request_rejected`: preserve the upstream status and detail, with `retryable: false`.
It is not an `invalid_response`; that kind describes a malformed successful
response. Consumers terminate a rejected request with its exact Problem rather
than retrying unchanged input or assigning response-contract strikes.

### §provider-interrupted-attempt Provider-declared interruption

A successful transport response can still declare that inference did not
complete. That response is evidence for one failed provider attempt, never a
completed exchange.

| Concern                    | Contract                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Normalized finish reason   | Exact `insufficient_system_resource` becomes `resource_interrupted`; the raw value remains in `assistantRaw`.                |
| `generate` outcome         | Throw `ProviderError(kind="resource_interrupted")` at local status 503 with the normalized attempt on `error.attempt` and the same accounting on `error.accounting`. |
| Partial response           | Preserve content, reasoning, usage, model, metadata, optional raw body, and other evidence without admitting it as success.  |
| Automatic replay           | None inside the provider; AI SDK retry scheduling has already completed. The Problem has `retryable: true`: the consumer re-issues it ({§provider-retryable-truth}). |
| Capacity-pool overflow     | None under the existing routing policy; when other overflow-eligible failures do reach a sibling, the pool concatenates their request accounting. |
| Consumer admission         | Persist the evidence as an unaccepted attempt; never parse it into executable work, even when its frame looks complete.      |

## §10 Grammar

GBNF is a local llama-server capability, not a generic provider expectation.
The consumer chooses whether to supply a grammar and reads it from the
operator's own file; the provider never creates, ships, rewrites, validates, or
grades one (#588). Transport is `{§provider-grammar-transport}`.

§provider-grammar-evidence When a grammar-capable adapter receives a grammar,
`ProviderResponse` carries `grammarEvidence: { input, contentStart, transported }`.
`input` is the exact pre-projection sentence represented by the response,
`contentStart` is its Unicode-code-point offset to `assistant.content`, and
`transported` says whether the grammar was actually sent. Active llama-server
template reasoning requests the unprojected sentence, records it, and then
separates its leading enclosure; an empty body therefore remains observable. An
endpoint that projects despite that request supplies no independent evidence.
For an unsplit response, `input` is `content` and `contentStart` is zero. This
is transport evidence so a digest can prove a run was constrained; nothing in
the service issues a verdict on it.

## §11 Evidence and metadata

§provider-evidence `assistantRaw` is an opaque normalized transport record.
Provider top-level
metadata is forwarded as an open bag without reinterpreting currencies or
vendor fields.

Logprobs and raw capture are opt-in, alias-scoped diagnostic features.
The former requests per-token logprobs and preserves returned alternatives.
The latter retains SDK response bodies/chunks and the dispatched request body
under {§provider-dispatched-request}, without requesting extra model output.
Neither changes unconditional accounting or failed-response evidence.

§provider-wire-emission **The emission is retained as the wire carried it, on every
response.** Beside the normalized `content` and `reasoning`, the transport record keeps
`wire`: the number of raw chunks, the chunks that carried no field at all, every delta or
message field the stream carried with the number of chunks carrying it, tool calls merged
by index with their arguments as streamed, the finish reasons seen, and the verbatim text
of every string field the record does not already hold. Nothing is opt-in and nothing is
reinterpreted: a blank emission reads as thirteen chunks that carried nothing, or as a
tool-call section the model emitted into a channel the protocol does not read, instead of
being guessed at from token counts. Frames outside the recognized OpenAI-compatible
envelope remain verbatim in `wire.unmappedChunks`; the recorder never discards an
unrecognized/native payload or invents another provider parser. This required
evidence is independent of the optional complete `rawBody` dataset capture.
Covered by `aiSdkTransport.test.ts` and core's `Digest.wire-evidence.test.ts`.

§provider-usage-refusal **The provider's bookkeeping is not the exchange.** Usage
normalization is exact; a refusal never fails or retries the response. The same
rules apply to usage inside failure evidence:

| Contradiction | Normalized evidence |
| --- | --- |
| Invalid aggregate or total inconsistent with its parts | No `usage`. |
| Invalid optional counter | Omit that counter; retain independently valid quantities. |
| Cache or reasoning breakdown inconsistent with its aggregate | Omit that breakdown; retain valid aggregates and the other breakdown. |

Every refusal retains `usageRefusal`: the reason and the original wire counters.
No value is clamped, zeroed, or estimated. Cost uses authoritative charges when
available; catalog estimation requires all quantities its rates need, otherwise
cost is `unknown`. Covered by `usage.test.ts`, `aiSdkTransport.test.ts`, and
`AiSdkProvider.test.ts`.

§provider-open-reasoning **Plurnk requires endpoints with open, verbatim reasoning.**
The adapter retains the reasoning text its transport exposes; fidelity is not
inferred from a model name or catalog flag. Hidden or summarized reasoning is not
a supported substitute, and encrypted or redacted payloads are never reconstructed
into text. A single response without reasoning does not establish endpoint
incapability: its `reasoning://` reads empty, while billed reasoning tokens remain
visible in accounting. Exposed operations follow {§reasoning-operations}; no
compatibility teaching or alternate admission mode is selected for a route.
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
only tighten this reservation for one call. The effective reasoning subset tightens
with that total and remains strictly smaller. Exact prompt measurements may expand
the response grant beyond the reservation under {§provider-flexed-allowance}.

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
normalized output-token usage greater than its response grant ({§provider-flexed-allowance}),
the exchange is an `invalid_response` at 502 rather than an admitted result or
a prompt-capacity 413. Its complete failed-attempt evidence and settled charged
request remain available. The violation is final and is never automatically
replayed. Missing output usage cannot prove a violation.

`PLURNK_PROVIDERS_OUTPUT_BUDGET` is required for standard providers and ships
as `35%`. `PLURNK_PROVIDERS_REASONING_BUDGET` is optional; leaving it unset
preserves provider-adaptive depth. A backend known to decode without a finite
limit advertises `requiresOutputBudget` and fails construction when no total can
be resolved.

## §13 Inference capacity

### Admission

§provider-inference-admission `PLURNK_PROVIDERS_MAX_CONCURRENCY` controls physical
generation attempts per resolved endpoint within one process: `-1` is unrestricted;
a positive safe integer admits that many concurrent attempts. It follows ordinary
alias scoping. Zero, other negative values and non-integers are invalid.

| Boundary | Contract |
| --- | --- |
| Identity | Provider instances and aliases sharing the resolved API base URL share one allowance. SDK- or extension-owned endpoints without a resolved URL share their provider identity. Conflicting limits for one identity fail construction, naming the identity and both values; they never create independent queues. The daemon reads its environment once at boot, so an identity's limit cannot change within a process: reconstructing a provider from that environment reuses its allowance, and in-flight leases keep counting. |
| Admission | FIFO among live waiters. The lease begins before the physical request observer and ends after the complete response or transport failure settles, including streamed bodies. |
| Cancellation | A queued abort removes that waiter and preserves the caller's reason. It opens no physical request or accounting row. In-flight cancellation signals the transport; capacity is released when that attempt unwinds. A transport still running despite abort does not authorize exceeding the limit. |
| Retries | Backoff holds no lease. Each retry rejoins admission as a new physical attempt. |
| Deadline | The whole-call operation deadline includes queueing, every physical attempt and retry wait. Transport adds no generation deadline. |
| Scope | Workers, tools, messages, waits, token measurement and endpoint discovery are not serialized by inference admission. Independent endpoints progress independently. No cross-process or machine-wide capacity guarantee is implied. |

Admission neither changes worker lifecycle nor selects another model or endpoint.
Core consumes the same asynchronous Provider contract. A waiting worker holds no
inference lease; BARE and ordinary generation use the same physical boundary.

### Pool

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

- catalog, declaration, local, and extension resolution;
- exact and unique-suffix model lookup;
- native SDK request mapping and normalized responses;
- compatible extension preservation;
- timeout, retry, cancellation, interrupted-attempt, and final-error behavior;
- shared endpoint inference admission, FIFO queueing, queued/in-flight cancellation,
  full-stream lease lifetime, retry release, and independent endpoint progress;
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
