# plurnk-providers

Framework + contract for `@plurnk/plurnk-providers-*` sibling packages (LLM transports + tokenizer + cost accounting). Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract for sibling implementers.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) (HEREDOC + AST), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes), [plurnk-execs](https://github.com/plurnk/plurnk-execs).

## Exports

- `Provider`, `ChatMessage`, `ProviderResponse`, `ProviderAssistant`, `ProviderUsage`, `FinishReason`, `ProviderFactory` — types.
- `parseAliasesFromEnv`, `resolveActiveAlias`, `instantiateProvider`, `loadActiveProvider` — alias-cascade resolution + full two-tier provider instantiation. The bespoke daughters are this framework's own dependencies; consumers pin one package (SPEC §5).
- `OpenAICompatProvider` (+ `OpenAICompatConfig`, `ReasoningStyle`, `effortFromBudget`) — shared OpenAI-compatible transport spine; siblings extend it (SPEC §11). Transports GBNF grammar-constrained sampling for capable backends (SPEC §13).
- `chatCompletionStream`, `OpenAiHttpError`, `StreamResponse` — the shared SSE client.
- `parseRequiredInt`, `parseOptionalInt`, `parseRequiredFlag`, `requireEnv`, `reasoningKnobsFromEnv` — env helpers (SPEC §4; all required-with-named-errors, no in-code defaults).
- `normalizeUsage`, `computeCost` (+ `RawUsage`, `TokenRates`) — usage normalization to the §2 invariant and the single cost formula (SPEC §11).
- `ProviderError`, `classifyProviderError`, `toProviderError`, `providerSource` (+ `TelemetryEvent`, `ProviderTelemetryKind`) — the TelemetryEvent envelope for transport failures (SPEC §12).
- `tokenizerFor`, `tokenizerByPublisher`, `parseTokenizerFamily` (+ `TokenizerFamily`, `CountTokens`) — synchronous tokenizer strategies.
- `STANDARD_PROVIDERS`, `isStandardProvider`, `standardProviderFromEnv` — pure-config OpenAI-compatible providers (no sibling package needed).
- `Mock` — reference implementation + test fixture (dual-purpose).

## Tests

`test:lint`, `test:unit`.
