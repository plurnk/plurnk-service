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
    readonly contextSize: number | null;  // total context tokens, null if unresolved
    readonly model: string;                // configured model id

    // Tokenomic primitives (synchronous, pure)
    countTokens(text: string): number;
    costFor(usage: ProviderUsage): number;  // pico-USD (1e-12 USD)

    // Transport
    generate(args: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse>;
}

interface ProviderResponse {
    assistant: {
        content: string;            // raw model emission; consumer parses
        reasoning: string | null;   // wire-reported CoT; null if absent
        usage: ProviderUsage;       // { prompt, completion, cached, total }
        finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
        model: string;              // wire-reported (may differ from requested for relay providers)
    };
    assistantRaw: unknown;          // verbatim wire response for forensics
}

interface ProviderUsage {
    prompt: number;
    completion: number;
    cached: number;
    total: number;
}
```

### Promises

- `assistant.content` is the **verbatim** model emission. Consumer parses via `@plurnk/plurnk-grammar` — providers MUST NOT parse. plurnk uses a **tools-in-body** design: tool invocations are expressed as plurnk DSL *inside the message content*, never via a provider's native tool-calling API, so `content` is always raw text and providers never request, parse, or translate native tool calls.[^tools]

[^tools]: A provider that wants to drive native tool-calling (OpenAI `tool_calls`, Anthropic `tool_use`) would have to normalize those emissions back into a plurnk DSL string at the boundary. No provider does this and it is out of scope for v0 — tools-in-body sidesteps the whole problem. The clause is recorded only so a future native-tools mode has a defined contract.
- `assistant.usage` is authoritative. Fill `0`s when the wire response omits a breakdown.
- `countTokens` is **synchronous**, returns a non-negative integer, deterministic for the same input.
- `costFor` is **pure**, returns pico-USD non-negative integer. Returns `0` for siblings with no known rates (local Ollama, generic OpenAI-compat shims).
- `contextSize` resolves to `null` when provider can't determine the model's context window. Consumer treats null as "no budget info available."
- `generate` rejects on signal abort — does NOT resolve with partial content.

## §3 `fromEnv(env, model)` factory

Default export MUST have a static `fromEnv(env, model)` factory:

```ts
class OpenAI {
    static fromEnv(env: NodeJS.ProcessEnv, model: string): OpenAI | Promise<OpenAI> {
        // Read provider-specific env (OPENAI_BASE_URL, OPENAI_API_KEY, ...)
        // plus universal operator knobs (PLURNK_REASON, PLURNK_FETCH_TIMEOUT,
        // PLURNK_PROVIDER_CONTEXT_SIZE).
        return new OpenAI({ /* ... */ });
    }
    constructor(config: OpenAIConfig) { /* ... */ }
}
```

The consumer's instantiation path calls `mod.default.fromEnv(env, alias.model)` generically (§5).

`fromEnv` MAY be sync or async; return type `Provider | Promise<Provider>`.

`fromEnv` MUST fail fast with a clear error if required env is missing — name the env var the operator needs to set.

## §4 Universal operator knobs

Each provider's `fromEnv` reads these:

- **`PLURNK_REASON`** — engine-level reasoning-token budget. Non-negative integer. Providers translate to wire format: OpenAI o-series → `reasoning_effort: low|medium|high|disabled`; llama-server / Ollama OpenAI-compat → `think: true|false`; Anthropic → `thinking: { type: "enabled", budget_tokens: n }`.
- **`PLURNK_FETCH_TIMEOUT`** — service-wide ms ceiling on any single outbound request. Each `fromEnv` reads and passes as `AbortSignal.timeout`. Per-provider override envs are NOT part of the contract.
- **`PLURNK_PROVIDER_CONTEXT_SIZE`** — optional positive-integer override for the model's reported context window. Resolution: this env var → provider probe/config/table → `null`.

## §5 Alias cascade resolution

`PLURNK_MODEL_<alias>=<provider>/<model-id>` declares an alias; `PLURNK_MODEL=<alias>` selects which is active.

```
PLURNK_MODEL_gemma=openai/macher.gguf
PLURNK_MODEL_opus=openrouter/anthropic/claude-opus-latest
PLURNK_MODEL=gemma
```

First path segment names the provider; rest is the model identifier (may contain `/` for tri-level providers like openrouter's `publisher/model`).

Framework helpers (`./ProviderRegistry.ts`) — pure env-parsing only:

- `parseAliasesFromEnv(env)` — extracts alias entries.
- `resolveActiveAlias(env)` — `{ alias, provider, model } | null`.

**Two-tier provider resolution.** A provider name resolves in this order:

1. **Standard provider** (`§11`) — if `isStandardProvider(name)`, the framework instantiates it directly via `standardProviderFromEnv(name, env, model)`. No sibling package exists or is imported. Covers every plain OpenAI-compatible endpoint (`openai`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `deepinfra`, …).
2. **Bespoke sibling** — otherwise, dynamic-import `@plurnk/plurnk-providers-<provider>` and call `fromEnv(env, model)`. Reserved for providers with real runtime surface: a catalog/pricing probe or a non-OpenAI wire shape (`openrouter`, `ollama`, `google`, `xai`, `cloudflare`, the planned `anthropic`/`bedrock`/`vertex`/`cohere`).

Tier 1 lives here because it needs no package resolution. Tier 2 is **consumer-side**: Node's `import()` resolves specifiers relative to the calling module, so the consumer — which has the sibling in its `node_modules` — owns the dynamic-import path:

- `instantiateProvider(alias, env)` — tries `standardProviderFromEnv` first, else dynamic-imports the sibling and calls `fromEnv(env, model)`.
- `loadActiveProvider(env)` — resolve + instantiate in one call.

## §6 Engine → provider guarantees (consumer side)

- `messages` is a complete prompt. Consumer has pre-assembled all sections. Provider does not add or reorder.
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
| Holding state across `generate` calls beyond connection pooling and config |
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

`MockResponse.assistant.ops?: PlurnkStatement[]` is a pre-parsed escape hatch consumed by plurnk-service intg tests (skips parse roundtrip). Production providers don't expose `ops`.

## §10 Conformance

A sibling package satisfies the contract when:

1. Default export is a class with `static fromEnv(env, model)` factory.
2. Instance exposes `contextSize: number | null` and `model: string` (non-empty).
3. Instance exposes `countTokens(text): number` and `costFor(usage): number`.
4. `countTokens("")` returns `0`; `countTokens("…")` returns a non-negative integer.
5. `costFor({prompt:0,completion:0,cached:0,total:0})` returns `0` (or non-negative pico-USD for non-free models).
6. Identity getters return stable values across reads.
7. `generate` resolves with a valid `ProviderResponse` shape.
8. `generate` invoked with a pre-aborted `signal` rejects without making a wire call.
9. `generate` invoked, then aborted mid-flight rejects within ≤5s; no connection leak.
10. `assistantRaw` is present (any value, including `null`).
11. No DB access, no imports from `@plurnk/plurnk-service`.
12. No runtime import of `@plurnk/plurnk-grammar` parser entry points.

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
      reasonBudget, reasoningStyle,   // "none" | "think" | "include_reasoning" | "effort"
      countTokens, costFor,  // strategies; default heuristic / free
  });
  ```

- **`chatCompletionStream` / `OpenAiHttpError` / `StreamResponse`** — the SSE client. One shared copy.
- **`parseRequiredInt` / `parseOptionalInt` / `requireEnv`** — env helpers; each takes a provider `label` for error prefixing.
- **`tokenizerFor(family)` / `tokenizerByPublisher(model, table, index)` / `parseTokenizerFamily(...)`** — synchronous tokenizer strategies (`heuristic` | `cl100k` | `llama`) and per-publisher dispatch for relay providers.
- **`effortFromBudget(budget)`** — the shared `PLURNK_REASON` → `low|medium|high` breakpoints.

A **bespoke sibling** therefore reduces to a thin class whose `fromEnv` probes whatever it needs (model catalog, pricing, context window), builds the config, and returns `new OpenAICompatProvider(config)`. A **standard provider** (§5 tier 1) needs no sibling at all — it's a frozen entry in `STANDARD_PROVIDERS` describing its key var, base URL, reasoning style, and tokenizer; `standardProviderFromEnv` does the rest.
