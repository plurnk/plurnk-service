# PROVIDERS.md

Contract for `@plurnk/plurnk-providers-*` packages. Audience: implementer of an LLM transport. Companion contracts: SCHEMES.md (URI handlers), MIMETYPES.md (content interpreters). Engine surface: SPEC.md.

---

## §1 Role

A provider transports model interactions. The runtime surface:

- `generate({ messages, signal }) → Promise<ProviderResponse>` — produce one turn's raw response.
- `countTokens(text) → number` — provider-owned tokenizer (engine drives packet accounting through this).
- `costFor(usage) → number` — provider-owned cost calculation in pico-USD.
- `contextSize: number | null` — total context window for the configured model, or `null` if unknown.
- `model: string` — the configured model identifier.

The provider owns the wire protocol to a model (HTTP, WebSocket, local pipe), the tokenizer, the cost table, and AbortSignal-driven teardown. The provider does NOT parse model emission into plurnk statements (engine does, §3.3), and does NOT own state, persistence, dispatch, or the engine's view of a turn.

---

## §2 Manifest

`package.json`:

```json
{
    "name": "@plurnk/plurnk-providers-<name>",
    "plurnk": {
        "kind": "provider",
        "name": "<vendor or family identifier>"
    }
}
```

- `kind` MUST be `"provider"`.
- `name` is the vendor/family identifier (`openai`, `anthropic`, `gemini`, `ollama`, `llama-cpp`, `mock`). Single token per package; one package per provider.

Default export: a class implementing `PlurnkProvider` (§3). Constructor signature is provider-specific (config object); the runtime interface is uniform.

Collision on `(kind: "provider", name)` at discovery: fail-hard. SPEC §9.

---

## §3 Interface

```ts
type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

type ProviderUsage = {
    readonly prompt: number;
    readonly completion: number;
    readonly cached: number;
    readonly total: number;
};

type ProviderAssistant = {
    readonly content: string;          // raw DSL the model emitted; unparsed
    readonly reasoning: string | null; // wire-reported CoT only; null if absent
    readonly usage: ProviderUsage;
    readonly finishReason: string | null;  // stop | length | tool_calls | content_filter | null
    readonly model: string;                 // wire-reported (may differ from requested for relay providers)
};

type ProviderResponse = {
    readonly assistant: ProviderAssistant;
    readonly assistantRaw: unknown;
};

interface Provider {
    readonly contextSize: number | null;
    readonly model: string;
    generate(args: {
        messages: ChatMessage[];
        signal?: AbortSignal;
    }): Promise<ProviderResponse>;
    countTokens(text: string): number;
    costFor(usage: ProviderUsage): number;
}
```

Duck-typed contract. The interface declaration is in `src/core/ProviderRegistry.ts` for internal reference; external packages implement the shape without importing the type. Identity is enforced at boot via `package.json#plurnk.name` matching the alias the registry resolved.

Providers return RAW wire-level output: `content` is the exact string the model emitted, `reasoning` is wire-reported CoT only. The engine parses `content` into `PlurnkStatement[]` and applies the free-form-text-to-reasoning scraping policy (§3.3). The engine also splits the response: emission fields (`content`, `reasoning`) flow into `packet.assistant`; call-metadata (`usage`, `finishReason`, `model`) flows into Turn columns.

### §3.1 Identity getters + accounting methods

| Member | Constraint |
|---|---|
| `contextSize` | Total context window in tokens for the configured model, or `null` if the provider can't resolve it (endpoint doesn't report `n_ctx` and no `PLURNK_PROVIDER_CONTEXT_SIZE` override is set). Engine treats `null` as "no budget info available" — Percent column omitted rather than guessed. |
| `model` | Model identifier (`gpt-5`, `claude-opus-4-7`, `gemini-2.5-pro`, etc.). |
| `countTokens(text)` | Provider-owned tokenizer. Synchronous, returns `number`. Engine calls during packet assembly to populate per-section subtotals (`packet.system.tokens`, `packet.user.tokens`, `packet.tokens`) and to drive `packet.user.telemetry.budget`. Use the model family's actual tokenizer where available; fall back to a per-family heuristic. Empty input → `0`. |
| `costFor(usage)` | Provider-owned cost calculation. Returns pico-USD (1e-12 USD per unit) for the given usage breakdown. Engine calls once per turn after `generate()` to populate `turns.usage_cost_pico` (rollup triggers cascade to `runs.cost_pico` and `sessions.cost_pico`). Returns `0` for siblings/models with no known rates (local Ollama, generic OpenAI-compat shim, etc.). |

`contextSize` and `model` are read-only and immutable across the provider's lifetime; the provider is single-model. `countTokens` and `costFor` are pure functions of their inputs.

### §3.2 `generate({ messages, signal }): Promise<ProviderResponse>`

Send one turn to the model, return one structured response.

**Inputs:**

| Field | Constraint |
|---|---|
| `messages: ChatMessage[]` | Ordered. First element typically `role: "system"`. Engine assembles; provider does not reorder. |
| `signal?: AbortSignal` | Cancellation. Optional. Provider MUST honor when present. |

**Output:** `ProviderResponse`:

| Field | Constraint |
|---|---|
| `assistant.content` | Raw text the model emitted. The exact string. Engine parses this into ops via `@plurnk/plurnk-grammar` — provider does NOT parse. |
| `assistant.reasoning` | Provider-exposed CoT when present (`<think>...</think>`, OpenAI o-series reasoning, Anthropic extended_thinking). `null` when absent. Wire-reported only — engine handles free-form-text-to-reasoning scraping itself. |
| `assistant.usage` | `{ prompt, completion, cached, total }`. Non-negative integers. Authoritative — engine does not second-guess. Fill `0`s when the wire response omits a breakdown. |
| `assistant.finishReason` | `stop \| length \| tool_calls \| content_filter \| null`. Pass-through from the wire when reported; `null` otherwise. |
| `assistant.model` | Wire-reported model id. MAY differ from the requested model (relay providers, model routing). |
| `assistantRaw` | The wire response verbatim. Schema-free. Engine treats as opaque; tools consume via forensic queries. |

**Promises:**

- Resolves with a `ProviderResponse` for any model response — including empty `content` (model emitted nothing).
- Rejects on transport failure, signal abort, or any error the provider can't represent as a valid response.
- Does NOT resolve with partial content on abort. Rejection is the only abort outcome.
- Single invocation per turn. No streaming partial-resolve.

### §3.3 Parsing belongs to the engine

The provider does NOT parse `content`. It returns the raw model emission verbatim. The engine invokes `PlurnkParser.parse(content)` from `@plurnk/plurnk-grammar`, owns `PlurnkStatement[]` construction, and applies the free-form-text-to-reasoning scraping policy (free prose between ops gets appended to `assistant.reasoning` at engine assembly time).

Rationale: providers stay grammar-version-agnostic. A grammar version bump touches the engine only; provider packages need not republish. This is the inverse of an earlier draft where providers parsed at the boundary — that coupled six provider packages to the grammar's version and made coordinated upgrades painful.

`@plurnk/plurnk-grammar` is NOT a runtime dependency of provider packages. Providers MAY depend on the grammar only for type imports if their own internal logic needs the AST shape, but the parser invocation is engine-side.

**Test-fixture exception.** The bundled Mock provider accepts an optional pre-parsed `ops: PlurnkStatement[]` field on its queued responses. When present, `Engine.#assembleAssistant` consumes it directly and skips the parse roundtrip. This is a test-only escape hatch; production providers do not expose it.

### §3.4 AbortSignal lifecycle

When `signal.aborted` is `true` or `signal` fires `abort`:

- Tear down the outbound connection (HTTP request abort, WebSocket close, subprocess kill).
- Cancel any in-flight stream parsing or accumulation.
- Reject the promise. The rejection reason SHOULD include `signal.reason` if non-null.
- Do NOT resolve with what was buffered before abort.

The engine wires `signal` to the run's AbortController. Honoring it is mandatory for clean session teardown; ignoring it leaves zombie HTTP requests after rummy-cli's shutdown flush, costing real money on metered endpoints.

### §3.5 Construction

Constructor signature is provider-specific. Pattern:

```ts
constructor(config: ProviderConfig) {
    this.#config = config;
}
```

Where `ProviderConfig` is the provider's own type — `baseUrl`, `apiKey`, `model`, `contextSize`, timeout, model-specific knobs. The interface does NOT constrain the constructor.

The engine instantiates the provider once per session (or once per process for the bundled boot path) and reuses the instance across `generate` calls.

### §3.6 Model alias system

Operator-facing model selection uses an env-driven alias cascade implemented in `src/core/ProviderRegistry.ts`:

```
PLURNK_MODEL_<alias>=<provider>/<model-id>
PLURNK_MODEL=<alias>
```

The first path segment of the value names the provider plugin (`@plurnk/plurnk-providers-<provider>`); the rest is the provider's own model identifier (may contain `/` for tri-level providers like openrouter's `publisher/model`). `PLURNK_MODEL` selects which alias is active for the deployment.

Example `.env`:
```
PLURNK_MODEL_gemma=openai/macher.gguf
PLURNK_MODEL_opus=openrouter/anthropic/claude-opus-latest
PLURNK_MODEL=gemma
```

The registry exposes:
- `parseAliasesFromEnv(env)` — extract alias entries from env vars.
- `resolveActiveAlias(env)` — `{ alias, provider, model } | null`.
- `instantiateProvider(alias, env)` — dynamic-imports `@plurnk/plurnk-providers-<provider>` and calls its `fromEnv(env, model)` factory (§3.7).
- `loadActiveProvider(env)` — resolve + instantiate in one call.

Provider-specific env conventions live inside each provider package's `fromEnv` factory (§3.7). plurnk-service is agnostic to provider config; the registry just dispatches.

Rummy parallel: `RUMMY_MODEL_<alias>` cascade.

### §3.7 `fromEnv(env, model)` factory — required static method

Each provider package's default export MUST have a static `fromEnv(env, model)` factory that knows its own env-config conventions and returns a configured instance:

```ts
class OpenAI {
    static fromEnv(env: NodeJS.ProcessEnv, model: string): OpenAI {
        // Read provider-specific env (OPENAI_BASE_URL, OPENAI_API_KEY, ...)
        // plus the universal operator knobs PLURNK_REASON (§3.8),
        // PLURNK_FETCH_TIMEOUT (§3.9), and PLURNK_PROVIDER_CONTEXT_SIZE
        // (override for the model's reported context window).
        // Translate PLURNK_REASON to the provider-native reasoning config.
        return new OpenAI({ /* ... */ });
    }
    constructor(config: OpenAIConfig) { /* ... */ }
}
```

`plurnk-service`'s `ProviderRegistry.instantiateProvider` calls `mod.default.fromEnv(process.env, alias.model)` generically — no per-provider config branches in the registry. This isolates per-provider env conventions inside the provider's package.

Promises:
- `fromEnv` MAY be sync or async; return type is `Provider | Promise<Provider>`.
- `fromEnv` reads provider-specific env vars (`OPENAI_*` / `ANTHROPIC_*` / etc.) and the universal operator knobs `PLURNK_REASON` (§3.8) and `PLURNK_FETCH_TIMEOUT` (§3.9). `PLURNK_PROVIDER_CONTEXT_SIZE` is the optional service-wide override for the model's reported context window when set.
- `fromEnv` MUST fail fast with a clear error if required env is missing — name the env var the operator needs to set.
- `model` is the second positional arg because `PLURNK_MODEL_<alias>=<provider>/<model>` is parsed by service; service passes the resolved model id through.

### §3.8 `PLURNK_REASON` — universal reasoning-token budget

`PLURNK_REASON` is the engine-level reasoning-token budget. Required; resolved through the standard env cascade (`.env.example` ships a sane default; `.env` / `.env.<profile>` / shell / CLI flag override in order). Numeric, non-negative integer — the budget in tokens.

Provider modules own translating to their wire format: OpenAI o-series picks a tier from `reasoning_effort: low|medium|high|disabled`; llama-server / Ollama OpenAI-compat translate to `think: true|false`; Anthropic uses `thinking: { type: "enabled", budget_tokens: n }`. Service stays out of per-model-family complexity.

Providers MAY publish documentation about how they translate `PLURNK_REASON` budgets to their model family's tier breakpoints. Service does not validate the value beyond "non-negative integer."

### §3.9 `PLURNK_FETCH_TIMEOUT` — universal fetch timeout

`PLURNK_FETCH_TIMEOUT` is the service-wide fetch timeout, in milliseconds, applied to any single outbound request — provider calls and any future http-like scheme. Each provider's `fromEnv` reads it and passes it through as the `AbortSignal.timeout` bound on `fetch`. A streaming completion that emits no bytes for longer than this window is aborted.

Rationale: every provider in the registry is a streaming HTTP client, so they share the same hang-tolerance question. Operators get one ceiling. Per-provider override envs (`OPENAI_FETCH_TIMEOUT_MS`, etc.) are not part of the contract — if a single provider's endpoint genuinely needs different timing, that's a code-default decision inside the provider, not an operator concern.

Providers MAY apply a lower in-code default when their endpoint is known-fast (a local Ollama box would reasonably default to 30s), but they MUST honor `PLURNK_FETCH_TIMEOUT` as the operator-set upper bound.

### §3.10 `PLURNK_PROVIDER_CONTEXT_SIZE` — optional context-window override

Optional; numeric, positive integer when set. When present, overrides whatever the provider would otherwise resolve as `contextSize` (model probe response, baked-in table, etc.). Useful when an endpoint reports the wrong window or when an operator runs a local model with a non-standard context configuration.

Resolution order inside `fromEnv`:
1. `PLURNK_PROVIDER_CONTEXT_SIZE` if set and parseable as positive integer → use as `contextSize`.
2. Provider's own probe / config / table → use that.
3. Neither resolves → `contextSize = null`. Engine treats null as "no budget info" (Percent column omitted).

---

## §4 Engine → provider guarantees

- `messages` is a complete prompt. Engine has already assembled `system_definition`, `persona`, `index`, `log`, `prompt`, `telemetry`, `system_requirements` into the ordered array (per `packet` shape, SPEC §15). Provider does not add or reorder.
- `signal` (when present) is wired to the run's AbortController. The engine guarantees `signal.aborted` becomes `true` exactly once and stays true.
- Engine calls `generate` once per turn. No parallel calls against the same provider instance for the same session.
- Engine never inspects `assistantRaw`. Tools (telemetry, digest, forensics) may. Provider is the sole author.
- Engine reads `contextSize` and `model` as immutable identity.
- Engine calls `countTokens` synchronously and frequently during packet assembly (per section, potentially per entry once `entry_channels.tokens` write-time accounting lands). Implementations should be cheap.
- Engine calls `costFor` once per completed turn against the provider-reported `usage`.

---

## §5 Provider → engine guarantees

- **No DB access.** Provider never touches `node:sqlite`, `@possumtech/sqlrite`, or the engine's `Db` type.
- **No engine access.** Provider never imports from `@plurnk/plurnk-service`.
- **No grammar runtime dep.** Provider does not parse `content`. Engine parses. Provider MAY type-import from `@plurnk/plurnk-grammar` for its own internal needs, but invoking `PlurnkParser.parse` is engine-side.
- **Raw `content`.** `assistant.content` is the verbatim model emission. Native tool-call outputs (OpenAI function calls, Anthropic tool_use blocks, etc.) MUST be translated back to plurnk DSL string before returning — providers normalize at the boundary, but the result is still raw content for the engine to parse.
- **Atomic.** One `generate` call resolves with one complete `ProviderResponse`. No streaming partial resolves (v0).
- **Honors `signal`.** Aborted calls reject; resources free; no orphaned connections.
- **Single model.** One provider instance speaks to one model. Multi-model fleets use one provider instance per model.
- **Synchronous `countTokens`, pure `costFor`.** No I/O, no async, no state across calls beyond cached tokenizer artifacts.

---

## §6 Forbidden

| ❌ |
|---|
| Database access (`node:sqlite`, `@possumtech/sqlrite`, raw connections) |
| Filesystem access beyond reading provider-internal config files (config goes through constructor) |
| Imports from `@plurnk/plurnk-service/*` |
| Resolving with partial content on abort |
| Mutating `messages` |
| Parsing `content` into `PlurnkStatement[]` — parsing is engine-side (§3.3) |
| Streaming the resolve (atomic only; v0) |
| Holding state across `generate` calls beyond connection pooling and config |
| Reading model output via `console.*` |
| Ignoring `signal` |
| Spawning subprocesses for inference (use the wire protocol; if the model runs locally, talk to a server) |

---

## §7 Reference — `src/providers/Mock.ts` (bundled)

Test-fixture provider. Queue of pre-built responses; `generate` shifts one off. Fixtures MAY include a pre-parsed `ops: PlurnkStatement[]` on each queued response — when present, `Engine.#assembleAssistant` consumes it directly and skips the parse roundtrip. This is the v0 test-only escape hatch (§3.3); production providers don't expose it.

```ts
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Provider, ProviderAssistant, ProviderUsage } from "../core/ProviderRegistry.ts";

export type MockAssistant = {
    content: string;
    reasoning: string | null;
    usage?: ProviderUsage;       // defaults to all-zero
    finishReason?: string | null; // defaults to "stop"
    model?: string;               // defaults to "mock"
    ops?: PlurnkStatement[];     // test-only escape hatch (see §3.3)
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
};

export default class Mock implements Provider {
    constructor({ contextSize, responses }: { contextSize: number | null; responses: MockResponse[] });
    get contextSize(): number | null;
    get model(): string;                       // "mock"
    countTokens(text: string): number;         // chars/4 ceil heuristic
    costFor(usage: ProviderUsage): number;     // 0 (mock is free)
    generate(args: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse & { assistant: ProviderAssistant & { ops?: PlurnkStatement[] } }>;
    get remaining(): number;
}
```

---

## §8 Reference — `@plurnk/plurnk-providers-openai` (sibling repo)

Lives at [github.com/plurnk/plurnk-providers-openai](https://github.com/plurnk/plurnk-providers-openai); published on npm. Speaks the OpenAI chat-completions wire format. Adapts to llama-server, Ollama (OpenAI-compat mode), and any other endpoint speaking the same API.

Config:

```ts
type OpenAIConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
    contextSize: number | null;
    fetchTimeoutMs: number;
    reasonBudget: number;       // PLURNK_REASON translated for o-series reasoning_effort
    tokenizer: "heuristic" | "cl100k_base";
};
```

Surface (from its published `.d.ts`):

```ts
export default class OpenAI {
    constructor(config: OpenAIConfig);
    static fromEnv(env: NodeJS.ProcessEnv, model: string): OpenAI;
    get contextSize(): number | null;
    get model(): string;
    get baseUrl(): string;
    countTokens(text: string): number;
    costFor(usage: ProviderUsage): number;
    generate({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse>;
}
```

Canonical example of: (a) wire-protocol-bound provider, (b) AbortSignal teardown via `fetch`'s native signal pass-through, (c) `fromEnv` factory translating `PLURNK_REASON` to o-series `reasoning_effort` tiers, (d) optional `cl100k_base` tokenizer driven by config.

---

## §9 Conformance

`@plurnk/plurnk-provider-conformance` (TBD) verifies:

1. Default export is a class with a `static fromEnv(env, model)` factory.
2. Instance exposes `contextSize: number | null` and `model: string` (non-empty).
3. Instance exposes `countTokens(text): number` and `costFor(usage): number`.
4. `countTokens("")` returns `0`; `countTokens("...")` returns a non-negative integer.
5. `costFor({prompt:0,completion:0,cached:0,total:0})` returns `0` (or pico-USD non-negative integer for non-free models).
6. Identity getters return stable values across 100 reads.
7. `generate({messages: []})` either rejects with a documented error or resolves with valid shape.
8. `generate` resolves with a `ProviderResponse` matching the wire shape:
   - `assistant.content` is a string.
   - `assistant.reasoning` is `string | null`.
   - `assistant.usage` is `{prompt, completion, cached, total}`, all non-negative integers.
   - `assistant.finishReason` is `string | null`.
   - `assistant.model` is a non-empty string.
9. `generate` invoked with a pre-aborted `signal` rejects without making a wire call.
10. `generate` invoked, then aborted mid-flight rejects within a bounded time (≤ 5s); the provider does not leak the connection.
11. `assistantRaw` is present (any value, including `null`).
12. No DB access during the pack (verified by absence of `node:sqlite` import resolution).
13. No imports from `@plurnk/plurnk-service`.
14. No runtime import of `@plurnk/plurnk-grammar` parser entry points (type-only imports are fine).

Provider-specific behavioral tests (wire-format compliance, model-family quirks, retry logic) live in the package's own test surface.

---

## §10 Bundled

Plurnk-service bundles one reference provider:

| Path | Provider |
|---|---|
| `src/providers/Mock.ts` | `mock` — test-fixture only, never deployed |

External packages currently consumed (declared in `package.json`):

| Package | Surface |
|---|---|
| `@plurnk/plurnk-providers-openai` | OpenAI chat-completions; also serves llama-server, Ollama (OpenAI-compat), and any compatible endpoint |
| `@plurnk/plurnk-providers-openrouter` | OpenRouter — multi-model relay |
| `@plurnk/plurnk-providers-ollama` | Native Ollama API |
| `@plurnk/plurnk-providers-google` | Google Generative Language API (Gemini) |
| `@plurnk/plurnk-providers-xai` | xAI Grok |
| `@plurnk/plurnk-providers-cloudflare` | Cloudflare Workers AI |

The bundled Mock provider stays in-tree as a test fixture. Production deployments install at least one external provider package and configure the model alias cascade (§3.6) accordingly.

---

## §11 Open

- **Tokenize caching.** `Engine.#buildRequestPacket` calls `provider.countTokens` on monolithic per-section text every turn. Naive content-hash caching fails because section text grows monotonically each turn. Real fix is component-level subtotals: tokenize each entry/log row once at write time (populate `entry_channels.tokens`), sum at render. Touches the same plumbing as per-scheme budget breakdown in the user telemetry section.
- **Streaming.** Atomic for v0. Streaming providers would require an extension to `ProviderResponse` (async iterator? promise of stream + final?) and corresponding engine changes (incremental dispatch? show-stream-to-model before completion?). Out of scope until needed.
- **Multi-model providers.** Each provider instance is single-model. A package wrapping multiple models from one vendor instantiates multiple providers; the engine's provider registry holds one per `name`. Whether a single provider should multiplex models is open.
- **Tool-call format normalization.** Native function-calling outputs from OpenAI / Anthropic / Gemini get normalized back to plurnk DSL string by the provider before returning. Rummy's `XmlParser.#normalizeToolCalls` is the precedent; plurnk providers do the equivalent translation at the boundary. The engine then parses the normalized string. (Empirically the heredoc/URI grammar outperforms native JSON tool calls even with capable models — rummy validated this at benchmark.)
- **Reasoning chunking.** `reasoning: string | null` is a single string. Providers that receive reasoning in chunks concatenate into one string; structured reasoning (chain-of-thought trees) is out of scope for v0.
- **Conformance pack.** §9 lists the checks; `@plurnk/plurnk-provider-conformance` package itself is TBD.
