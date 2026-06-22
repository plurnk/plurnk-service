# plurnk-providers

Framework + contract for `@plurnk/plurnk-providers-*` sibling packages (LLM transports + tokenizer + cost accounting). Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract for sibling implementers.
- [`.env.example`](./.env.example) — the authoritative operator config reference: every env knob the provider layer reads (all required, fail-hard, no defaults).
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

`generate({ messages, runId, signal?, grammar?, maxTokens?, attributions?, client? }) → Promise<ProviderResponse>`. Return **raw** wire output: `content` unparsed (the consumer parses the plurnk DSL — never parse it yourself), `reasoning` is the wire-reported CoT only. Honor `signal`. The provider never mutates `messages` or injects turns. `grammar` (GBNF) is attached only by backends that support it; all others ignore it (SPEC §13). When a grammar *is* transported, the provider verifies the backend actually enforced it — non-conforming output rejects with a `grammar_unenforced` `ProviderError` (a conformance check via `@plurnk/gbnf`, never a plurnk-DSL parse). `attributions`/`client` are per-turn first-party metadata, forwarded as `Plurnk-*` headers **only** by a provider configured with `firstPartyMetadata` (the plurnk endpoint); every other provider drops them, so they can never reach a third-party backend (SPEC §11). The response carries `balancePico?` (account balance, pico-USD) **only** from the plurnk endpoint; absent everywhere else (#23).

## Discovery & trust

`discover(options?)` scans **every installed package** under `<cwd>/node_modules` — scope-agnostic — for `plurnk.kind === "provider"`, returning `{ registry, skipped, attributions }` (registry/skipped: name → package specifier; attributions: name → the package's raw `plurnk.attribution` for author credit, #21).

- **Name collisions are fail-hard.** Two packages claiming the same provider name throw at discovery, naming both.
- **The standard table wins.** A scanned package whose name duplicates a built-in standard provider (`openai`, `groq`, …) is shadowed — tier 1 resolves first.
- **Trust gate.** `discover()` honors **`PLURNK_PLUGINS_TRUSTED_ONLY`** (host posture, plurnk-service#229): unset/`""`/`0` → every package registers (default, no regression); any value → `@plurnk/*` always trusted plus a comma-separated allowlist (`1` = first-party only). An untrusted package is discovered but **not** registered (returned in `Discovery.skipped`), so requesting its name yields a precise *untrusted* error — never a crash.

First-party daughters install flat via [`@plurnk/plurnk-providers-all`](https://github.com/plurnk/plurnk-providers-all) so the scan finds them; a third party publishes under their own scope and installs alongside.

## Exports

- `Provider`, `ChatMessage`, `ProviderResponse`, `ProviderAssistant`, `ProviderUsage`, `FinishReason`, `ProviderFactory`, `ProviderAlias` (+ `Discovery`, `DiscoverOptions`) — types.
- `parseAliasesFromEnv`, `resolveActiveAlias`, `instantiateProvider`, `loadActiveProvider`, `discover`, `resetDiscoveryCache` — alias-cascade resolution + two-tier provider instantiation (`resetDiscoveryCache` clears the memoized tier-2 scan; for tests). Tier 1 is the standard table; tier 2 is a scope-agnostic `node_modules` scan for `plurnk.kind:"provider"` packages — first-party daughters (flat via `@plurnk/plurnk-providers-all`) and third-party providers under any scope, gated by the host `PLURNK_PLUGINS_TRUSTED_ONLY` allowlist. The framework is contract-only (SPEC §5).
- `OpenAICompatProvider` (+ `OpenAICompatConfig`, `ReasoningStyle`, `GrammarStyle`, `effortFromBudget`) — shared OpenAI-compatible transport spine; siblings extend it (SPEC §11). Transports a GBNF grammar via `grammarStyle` — `llamacpp` (top-level `grammar` field) or `response_format` (Fireworks); `none` drops it — and verifies the backend enforced it against `@plurnk/gbnf`, rejecting non-conforming output as `grammar_unenforced` (SPEC §13).
- `chatCompletionStream`, `chatCompletion`, `OpenAiHttpError`, `StreamResponse` — the shared SSE client (`chatCompletion` is the non-streaming variant).
- `parseRequiredInt`, `parseOptionalInt`, `requireEnv`, `reasoningBudgetFromEnv` — env helpers (SPEC §4; all required-with-named-errors, no in-code defaults).
- `normalizeUsage`, `computeCost` (+ `RawUsage`, `TokenRates`) — usage normalization to the §2 invariant and the single cost formula (SPEC §11).
- `ProviderError`, `classifyProviderError`, `toProviderError`, `providerSource` (+ `TelemetryEvent`, `ProviderTelemetryKind`) — the TelemetryEvent envelope for transport failures (SPEC §12).
- `tokenizerFor`, `tokenizerByPublisher`, `parseTokenizerFamily` (+ `TokenizerFamily`, `CountTokens`) — synchronous tokenizer strategies.
- `STANDARD_PROVIDERS`, `isStandardProvider`, `standardProviderFromEnv` — pure-config OpenAI-compatible providers (no sibling package needed).
- `Mock` (+ `mockDefaultUsage`) — reference implementation + test fixture (dual-purpose).

## Tests

`test:lint`, `test:unit`.
