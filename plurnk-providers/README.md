# plurnk-providers

Framework + contract for `@plurnk/plurnk-providers-*` sibling packages (LLM transports + tokenizer + cost accounting). Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract for sibling implementers.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) (HEREDOC + AST), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes), [plurnk-execs](https://github.com/plurnk/plurnk-execs) (the reference family this one mirrors).

## Write a provider

Ship a provider by publishing a package — **under any scope** (`@acme/whatever`; discovery keys on `plurnk.kind`, not the `@plurnk` scope) — that declares its name and default-exports a `fromEnv` factory. (A plain OpenAI-compatible endpoint with no probe or wire quirk needs *no* package at all for first-party use — it's a frozen `STANDARD_PROVIDERS` entry; the package path is for bespoke providers and any third party.)

### 1. Declare the name in `package.json`

```json
{
  "plurnk": { "kind": "provider", "name": "acme" }
}
```

One package is **one** provider identity — the `<name>` segment of `PLURNK_MODEL_<alias>=<name>/<model>`. (Unlike execs' `runtimes[]` array; a provider is singular.)

### 2. Default-export a `fromEnv` factory

The framework calls `YourClass.fromEnv(env, model)` (sync or async) and expects a `Provider`. Two ways in:

- **OpenAI-compatible backends** (the common case): `fromEnv` reads its env (base URL, key), probes whatever it needs (catalog, context window, pricing), and returns **`new OpenAICompatProvider(config)`**. You write a `fromEnv` and a config object — the transport spine (SSE, usage normalization, `finishReason`, grammar transport, slot affinity) is inherited. See `OpenAICompatConfig` / SPEC §11.
- **Non-OpenAI backends**: `implements Provider` directly — `generate`, `contextSize`, `model`, `countTokens(text)`, `costFor(usage)`.

`fromEnv` **MUST fail fast with a named error** when required env is missing — name the var the operator must set. (Why a factory, not a base-class constructor like execs/mimes: a provider often async-probes at construction — SPEC §3.)

### 3. What `generate` receives — and returns

`generate({ messages, runId, signal?, grammar?, maxTokens? }) → Promise<ProviderResponse>`. Return **raw** wire output: `content` unparsed (the consumer parses the plurnk DSL — never parse it yourself), `reasoning` is the wire-reported CoT only. Honor `signal`. The provider never mutates `messages` or injects turns. `grammar` (GBNF) is attached only by backends that support it; all others ignore it (SPEC §13).

## Discovery & trust

`discover(options?)` scans **every installed package** under `<cwd>/node_modules` — scope-agnostic — for `plurnk.kind === "provider"`, returning `{ registry, skipped }` (name → package specifier).

- **Name collisions are fail-hard.** Two packages claiming the same provider name throw at discovery, naming both.
- **The standard table wins.** A scanned package whose name duplicates a built-in standard provider (`openai`, `groq`, …) is shadowed — tier 1 resolves first.
- **Trust gate.** `discover()` honors **`PLURNK_PLUGINS_TRUSTED_ONLY`** (host posture, plurnk-service#229): unset/`""`/`0` → every package registers (default, no regression); any value → `@plurnk/*` always trusted plus a comma-separated allowlist (`1` = first-party only). An untrusted package is discovered but **not** registered (returned in `Discovery.skipped`), so requesting its name yields a precise *untrusted* error — never a crash.

First-party daughters install flat via [`@plurnk/plurnk-providers-all`](https://github.com/plurnk/plurnk-providers-all) so the scan finds them; a third party publishes under their own scope and installs alongside.

## Exports

- `Provider`, `ChatMessage`, `ProviderResponse`, `ProviderAssistant`, `ProviderUsage`, `FinishReason`, `ProviderFactory` (+ `Discovery`, `DiscoverOptions`) — types.
- `parseAliasesFromEnv`, `resolveActiveAlias`, `instantiateProvider`, `loadActiveProvider`, `discover` — alias-cascade resolution + two-tier provider instantiation. Tier 1 is the standard table; tier 2 is a scope-agnostic `node_modules` scan for `plurnk.kind:"provider"` packages — first-party daughters (flat via `@plurnk/plurnk-providers-all`) and third-party providers under any scope, gated by the host `PLURNK_PLUGINS_TRUSTED_ONLY` allowlist. The framework is contract-only (SPEC §5).
- `OpenAICompatProvider` (+ `OpenAICompatConfig`, `ReasoningStyle`, `effortFromBudget`) — shared OpenAI-compatible transport spine; siblings extend it (SPEC §11). Transports GBNF grammar-constrained sampling for capable backends (SPEC §13).
- `chatCompletionStream`, `OpenAiHttpError`, `StreamResponse` — the shared SSE client.
- `parseRequiredInt`, `parseOptionalInt`, `requireEnv`, `reasoningBudgetFromEnv` — env helpers (SPEC §4; all required-with-named-errors, no in-code defaults).
- `normalizeUsage`, `computeCost` (+ `RawUsage`, `TokenRates`) — usage normalization to the §2 invariant and the single cost formula (SPEC §11).
- `ProviderError`, `classifyProviderError`, `toProviderError`, `providerSource` (+ `TelemetryEvent`, `ProviderTelemetryKind`) — the TelemetryEvent envelope for transport failures (SPEC §12).
- `tokenizerFor`, `tokenizerByPublisher`, `parseTokenizerFamily` (+ `TokenizerFamily`, `CountTokens`) — synchronous tokenizer strategies.
- `STANDARD_PROVIDERS`, `isStandardProvider`, `standardProviderFromEnv` — pure-config OpenAI-compatible providers (no sibling package needed).
- `Mock` — reference implementation + test fixture (dual-purpose).

## Tests

`test:lint`, `test:unit`.
