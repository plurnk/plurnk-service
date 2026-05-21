# MIMETYPES.md

How plurnk-service consumes the `@plurnk/plurnk-mimetypes-*` family. The duck contract, handler implementation surface, and detection priority are owned by [@plurnk/plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes) — see its [SPEC.md](https://github.com/plurnk/plurnk-mimetypes/blob/main/SPEC.md). This document covers only the service-side integration: which handlers are required deps, the package.json discovery extensions service needs, and the render-time pipeline.

Companion contracts: SCHEMES.md (URI handlers), PROVIDERS.md (LLM transports). Engine surface: SPEC.md.

---

## §1 Role at the service layer

plurnk-service is mimetype-illiterate. The engine knows it has channel content with a mimetype label and a per-call token budget; it hands both to `Mimetypes.process({content, hint}, {budget})` and uses `result.preview` as the rendered output in `packet.system.index[].channels[name].content`. SPEC §4 {§4-handlers-fire-render-time}.

The framework owns: detection, discovery (`node_modules/@plurnk/` scan), handler instantiation, outline formatting, budget-truncated preview rendering, the duck contract.

The service owns: which handlers are hard deps (§2), tokenize injection from the active provider's `countTokens` (§3), and the per-call budget sourced from `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` (SPEC §12).

---

## §2 Required dependencies

Three handler packages are hard deps in plurnk-service's `package.json`. Each handles content the engine itself emits or consumes — service can't operate meaningfully without these.

| Package | Mimetype | Why required |
|---|---|---|
| `@plurnk/plurnk-mimetypes-text-markdown` | `text/markdown` | LLM emission default. Configured as `defaultMimetype` on the `Mimetypes` orchestrator — when detection finds no match, the framework returns `"text/markdown"` instead of `null`. The handler must be discoverable at runtime for that default to actually resolve. |
| `@plurnk/plurnk-mimetypes-text-plain` | `text/plain` | Universal text fallback. An explicit "no-structure text" identity beats relying on the framework's no-handler `fitContent` raw-content path. |
| `@plurnk/plurnk-mimetypes-application-json` | `application/json`, `application/jsonc` | Service emits json for `log_entries` rx/tx, telemetry payloads, and packet serialization. Not just user content — load-bearing for the platform's own internal data. |

Everything else is **opt-in**: operators `npm install @plurnk/plurnk-mimetypes-<name>` for whatever content types they care about. The framework's `discover()` picks them up automatically at `Mimetypes.ready()`. No service-side declaration needed.

---

## §3 Tokenize injection

`Mimetypes` is constructed at Daemon boot with a `tokenize` lambda capturing the active provider's `countTokens`:

```ts
new Mimetypes({
    tokenize: async (text) => this.#provider?.countTokens(text) ?? Math.ceil(text.length / 4),
    defaultMimetype: "text/markdown",
});
```

The fallback heuristic only fires when no provider is configured (rare path; standalone or boot-before-provider-resolved). In production every preview is sized against the active model family's real tokenizer.

The framework's `TokenizeFn` is async-shaped (`(text) => Promise<number>`); the lambda wraps the synchronous `provider.countTokens` cleanly. See [plurnk-mimetypes#1](https://github.com/plurnk/plurnk-mimetypes/issues/1) for the eventual relaxation to `number | Promise<number>`.

---

## §4 Discovery manifest — package.json `plurnk` block

The framework's [SPEC §2](https://github.com/plurnk/plurnk-mimetypes/blob/main/SPEC.md#2-packagejson-plurnk-discovery-block) owns the canonical shape. Plurnk-service consumes the framework's `discover()` as-is — no extensions, no service-side overrides.

### §4.1 Manifest shape

```json
{
    "plurnk": {
        "kind": "mimetype",
        "handlers": [
            { "name": "application/json",  "glyph": "📋", "extensions": [".json"] },
            { "name": "application/jsonc", "glyph": "📋", "extensions": [".jsonc"] }
        ]
    }
}
```

Single-handler packages declare one entry in `handlers[]`; packages that ship a single implementation under multiple closely-related names (jsonc as a json superset; x-yaml aliasing yaml; text/xml aliasing application/xml) declare each name as its own entry. The handler class exported as `default` is shared across all entries; the framework constructs it once with the entry's metadata when that name is first resolved.

Per-entry fields:
- `name` (required) — the mimetype string this entry registers
- `extensions` (optional) — extensions and special filenames this entry matches during detection (entries beginning with `.` are file extensions, lowercased on match; other entries are verbatim filenames like `Dockerfile`)
- `glyph` (optional) — display glyph for this name; the framework's own default applies if omitted

### §4.2 Detection resolution

`detect()` matches against every `handlers[]` entry at the same tier (extension, filename, hint, content). The first match wins per the framework's priority (hint > filename > extension > content).

`ProcessResult.mimetype` returns the matched name. Service's `entry_channels.mimetype` column reflects what the operator stored — a `.jsonc` file detects as `"application/jsonc"`, not collapsed to `"application/json"`. The variant identity matters when handler logic branches on which name is being served (jsonc allows comments; json does not).

```
package handlers: [
    { name: "application/json",  extensions: [".json"] },
    { name: "application/jsonc", extensions: [".jsonc"] },
]

.jsonc file → mimetype: "application/jsonc"
.json file  → mimetype: "application/json"
hint: "application/jsonc" → mimetype: "application/jsonc"
```

### §4.3 Collision policy

Collision on `name` across two installed packages: framework's discovery is last-loaded-wins. Service does not intervene.

---

## §5 Render pipeline

Engine's index render (`#buildIndex`, SPEC §5.2 {§5.2-render-filters-by-indexed}):

```ts
const result = await this.#mimetypes.process(
    { content: row.content, hint: row.mimetype },
    { budget: this.#previewBudget },
);
entry.channels[row.channel] = {
    content: result.preview,
    mimetype: row.mimetype,
    tokens: row.tokens,
};
```

`hint: row.mimetype` short-circuits detection — service already knows what each channel is. `result.preview` is whatever the framework decides (handler-extracted symbols, or `fitContent` raw-content fallback). The engine doesn't branch on `result.ok` or `result.symbols` — the preview is opaque budgeted text.

---

## §6 Conformance and testing

The framework's conformance surface ([plurnk-mimetypes SPEC §6, §7](https://github.com/plurnk/plurnk-mimetypes/blob/main/SPEC.md)) covers the duck contract. plurnk-service's intg suite covers the integration:

- Engine routes content through `Mimetypes.process` with the right hint and budget.
- `result.preview` lands in the right slot of `packet.system.index`.
- Empty-discovery construction (test default) flows through `fitContent` raw-content fallback.
- Custom-handler test injects a stub `BaseHandler` subclass via `Mimetypes`' `loader + discovery` options.

Mimetype-specific behavioral tests (markdown heading extraction correctness, JSON tree depth, etc.) live in each handler's own test surface, not here.
