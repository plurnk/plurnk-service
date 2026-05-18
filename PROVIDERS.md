# PROVIDERS.md

Contract for `@plurnk/plurnk-providers-*` packages. Audience: implementer of an LLM transport. Companion contracts: SCHEMES.md (URI handlers), MIMETYPES.md (content interpreters). Engine surface: SPEC.md.

---

## §1 Role

A provider transports model interactions. One required method:

- `generate({ messages, signal }) → Promise<ProviderResponse>` — produce one turn's response.

The provider owns the wire protocol to a model (HTTP, WebSocket, local pipe), the parsing of model emission into plurnk statements, and the AbortSignal-driven teardown. The provider does NOT own state, persistence, dispatch, or the engine's view of a turn.

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
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";

export type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

export type ProviderAssistant = {
    tokens: number;
    content: string;
    ops: PlurnkStatement[];
    reasoning: string | null;
};

export type ProviderResponse = {
    assistant: ProviderAssistant;
    assistantRaw: unknown;
};

export interface PlurnkProvider {
    readonly contextSize: number;
    readonly model: string;
    generate(args: {
        messages: ChatMessage[];
        signal?: AbortSignal;
    }): Promise<ProviderResponse>;
}
```

### §3.1 Identity getters

| Getter | Constraint |
|---|---|
| `contextSize` | Total context window in tokens for the configured model. |
| `model` | Model identifier (`gpt-5`, `claude-opus-4-7`, `gemini-2.5-pro`, etc.). |

Both are read-only. Engine reads them for accounting (`<turn>` token table) and for forensic logging. They do NOT change across the provider's lifetime; the provider is single-model.

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
| `assistant.tokens` | Completion token count for THIS turn. Authoritative — engine does not second-guess. |
| `assistant.content` | Raw text the model emitted. The exact string. Used for forensics + re-parsing. |
| `assistant.ops` | `PlurnkStatement[]` — parsed plurnk ops. Provider invokes `@plurnk/plurnk-grammar`'s parser against `content`. |
| `assistant.reasoning` | Provider-exposed CoT when present (`<think>...</think>`, OpenAI o-series reasoning, Anthropic extended_thinking). `null` when absent. |
| `assistantRaw` | The wire response verbatim. Schema-free. Engine treats as opaque; tools consume via forensic queries. |

**Promises:**

- Resolves with a `ProviderResponse` for any model response — including empty `ops` (model emitted no actions).
- Rejects on transport failure, parse failure, signal abort, or any error the provider can't represent as a valid response.
- Does NOT resolve with partial content on abort. Rejection is the only abort outcome.
- Single invocation per turn. No streaming partial-resolve.

### §3.3 Parser at the provider boundary

The provider invokes `PlurnkParser.parse(content)` from `@plurnk/plurnk-grammar` and emits `assistant.ops` as the result. Engine receives `ops` already parsed; engine does NOT re-parse `content`.

Parse failure handling:

- Malformed `content` that produces zero `ops` is NOT a provider error. Resolve with `ops: []` and let the engine's verdict chain handle the no-actionable-tags case.
- Parse exceptions from the grammar are provider errors. Reject the promise with the parse error as cause.

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

---

## §4 Engine → provider guarantees

- `messages` is a complete prompt. Engine has already assembled `system_definition`, `persona`, `index`, `log`, `prompt`, `turn`, `system_requirements` into the ordered array. Provider does not add or reorder.
- `signal` (when present) is wired to the run's AbortController. The engine guarantees `signal.aborted` becomes `true` exactly once and stays true.
- Engine calls `generate` once per turn. No parallel calls against the same provider instance for the same session.
- Engine never inspects `assistantRaw`. Tools (telemetry, digest, forensics) may. Provider is the sole author.
- Engine reads `contextSize` and `model` as immutable identity.

---

## §5 Provider → engine guarantees

- **`generate` is the only runtime method.** No side-channel writes, no callbacks, no event emission.
- **No DB access.** Provider never touches `node:sqlite`, `@possumtech/sqlrite`, or the engine's `Db` type.
- **No engine access.** Provider never imports from `@plurnk/plurnk-service`. The grammar package is the sole sanctioned import.
- **Parsed `ops`.** `assistant.ops` is the AST produced by `PlurnkParser.parse(content)`. Not a substring, not a regex match, not a JSON tool-call format translated to plurnk shape — the actual grammar output.
- **Atomic.** One `generate` call resolves with one complete `ProviderResponse`. No streaming partial resolves.
- **Honors `signal`.** Aborted calls reject; resources free; no orphaned connections.
- **Single model.** One provider instance speaks to one model. Multi-model fleets use one provider instance per model.

---

## §6 Forbidden

| ❌ |
|---|
| Database access (`node:sqlite`, `@possumtech/sqlrite`, raw connections) |
| Filesystem access beyond reading provider-internal config files (config goes through constructor) |
| Imports from `@plurnk/plurnk-service/*` |
| Resolving with partial content on abort |
| Mutating `messages` |
| Re-parsing `content` after constructing `ops` (provider parses once; engine consumes) |
| Streaming the resolve (atomic only; v0) |
| Holding state across `generate` calls beyond connection pooling and config |
| Reading model output via `console.*` |
| Ignoring `signal` |
| Spawning subprocesses for inference (use the wire protocol; if the model runs locally, talk to a server) |

---

## §7 Reference — `src/providers/Mock.ts` (bundled)

```ts
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type MockAssistant = {
    tokens: number;
    content: string;
    ops: PlurnkStatement[];
    reasoning: string | null;
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
};

export default class Mock {
    #contextSize: number;
    #queue: MockResponse[];

    constructor({ contextSize, responses }: { contextSize: number; responses: MockResponse[] }) {
        this.#contextSize = contextSize;
        this.#queue = [...responses];
    }

    get contextSize(): number { return this.#contextSize; }
    get model(): string { return "mock"; }

    async generate(_args: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<{ assistant: MockAssistant; assistantRaw: unknown }> {
        const next = this.#queue.shift();
        if (next === undefined) throw new Error("Mock provider exhausted: no more queued responses");
        return { assistant: next.assistant, assistantRaw: next.assistantRaw ?? null };
    }

    get remaining(): number { return this.#queue.length; }
}
```

Test-fixture provider. Queue of pre-built responses; `generate` shifts one off. The `ops` arrays in the queue are pre-parsed `PlurnkStatement[]`; tests construct them via the grammar parser or by hand for unit-level surfaces. Mock does not invoke the parser itself.

---

## §8 Reference — `@plurnk/plurnk-providers-openai` (external)

External package: `github:plurnk/plurnk-providers-openai`. Speaks the OpenAI chat-completions wire format. Adapts to llama-server, Ollama (OpenAI-compat mode), and any other endpoint speaking the same API.

Config:

```ts
type OpenAIConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
    contextSize: number;
    fetchTimeoutMs: number;
    think: boolean;
};
```

Surface (from its published `.d.ts`):

```ts
export default class OpenAI implements PlurnkProvider {
    constructor(config: OpenAIConfig);
    get contextSize(): number;
    get model(): string;
    get baseUrl(): string;
    generate({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse>;
}
```

Canonical example of: (a) wire-protocol-bound provider, (b) AbortSignal teardown via `fetch`'s native signal pass-through, (c) parser invocation at the boundary.

---

## §9 Conformance

`@plurnk/plurnk-provider-conformance` (TBD) verifies:

1. Default export is a class.
2. Instance exposes `contextSize: number > 0` and `model: string` (non-empty).
3. Identity getters return stable values across 100 reads.
4. `generate({messages: []})` either rejects with a documented error or resolves with valid shape (provider's choice).
5. `generate` resolves with a `ProviderResponse` matching the wire shape:
   - `assistant.tokens` is a non-negative integer.
   - `assistant.content` is a string.
   - `assistant.ops` is an array of grammar-valid `PlurnkStatement` (the conformance pack uses `PlurnkParser.parse(content)` and asserts deep-equality against `ops`).
   - `assistant.reasoning` is `string | null`.
6. `generate` invoked with a pre-aborted `signal` rejects without making a wire call.
7. `generate` invoked, then aborted mid-flight rejects within a bounded time (≤ 5s); the provider does not leak the connection.
8. `assistantRaw` is present (any value, including `null`).
9. No DB access during the pack (verified by absence of `node:sqlite` import resolution).
10. No imports from `@plurnk/plurnk-service`.

Provider-specific behavioral tests (wire-format compliance, model-family quirks, retry logic) live in the package's own test surface.

---

## §10 Bundled

Plurnk-service bundles one reference provider:

| Path | Provider |
|---|---|
| `src/providers/Mock.ts` | `mock` — test-fixture only, never deployed |

External packages, by maturity:

| Package | Status |
|---|---|
| `@plurnk/plurnk-providers-openai` | Existing; OpenAI-compat for OpenAI / llama-server / Ollama compat / any chat-completions endpoint |
| `@plurnk/plurnk-providers-anthropic` | Future; native Anthropic Messages API |
| `@plurnk/plurnk-providers-gemini` | Future; Google generative-language API |
| `@plurnk/plurnk-providers-openrouter` | Future; OpenRouter (likely subclasses or composes the openai package) |

The bundled Mock provider stays in-tree as a test fixture. Production deployments install at least one external provider package.

---

## §11 Open

- **`countTokens` method.** SPEC §2.3 currently lists `countTokens(text): Promise<number>` as required, with engine-side caching keyed by `(provider_id, content_hash)`. Neither the bundled Mock nor the published OpenAI provider implements it; the engine does not call it. Out of v0 contract. Future revision will land it with the budget-grinder work (related: task #46, budget unit decision).
- **Streaming.** Atomic for v0. Streaming providers would require an extension to `ProviderResponse` (async iterator? promise of stream + final?) and corresponding engine changes (incremental dispatch? show-stream-to-model before completion?). Out of scope until needed.
- **Cost / usage metadata.** Token counts (`prompt_tokens`, `completion_tokens`, `cached_tokens`) and computed cost can ride in `assistantRaw` today; consumers parse opportunistically. A future `assistant.usage` first-class field would standardize this.
- **Multi-model providers.** Each provider instance is single-model. A package wrapping multiple models from one vendor instantiates multiple providers; the engine's provider registry holds one per `name`. Whether a single provider should multiplex models is open.
- **Tool-call format adapters.** Native function-calling outputs from OpenAI / Anthropic / Gemini do NOT bypass the parser. Providers translate native tool-call formats back to plurnk DSL string before calling the parser. Rummy's `XmlParser.#normalizeToolCalls` is the precedent (SPEC §xml_parser); plurnk providers do the equivalent normalization at the boundary.
- **Reasoning chunking.** `reasoning: string | null` is a single string. Providers that receive reasoning in chunks concatenate into one string; structured reasoning (chain-of-thought trees) is out of scope for v0.
