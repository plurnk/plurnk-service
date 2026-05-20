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

The framework's [SPEC §2](https://github.com/plurnk/plurnk-mimetypes/blob/main/SPEC.md#2-packagejson-plurnk-discovery-block) owns the canonical shape. Plurnk-service consumes the framework's `discover()` and asks for this one extension to the manifest: an `also` block for packages that serve more than one closely-related mimetype.

### §4.1 Single-handler form (unchanged)

```json
{
    "plurnk": {
        "kind": "mimetype",
        "name": "text/markdown",
        "glyph": "📝",
        "extensions": [".md", ".markdown"]
    }
}
```

### §4.2 Multi-handler form (shape A — primary + `also`)

For packages that ship a single implementation under multiple closely-related names (jsonc as a json superset; x-yaml as the legacy alias of yaml; text/xml aliasing application/xml; etc.). The primary stays at the top level; additional names go in an `also` array.

```json
{
    "plurnk": {
        "kind": "mimetype",
        "name": "application/json",
        "glyph": "📋",
        "extensions": [".json"],
        "also": [
            { "name": "application/jsonc", "extensions": [".jsonc"] }
        ]
    }
}
```

`also` element shape: `{ name: string, extensions?: string[], glyph?: string }`. `glyph` defaults to the primary's glyph if omitted.

The asymmetry is intentional — every motivating case has a real primary plus variants. Flat `handlers: [...]` would discard "which name is canonical."

### §4.3 Detection resolution semantics

`detect()` matches against the primary and every `also[]` entry at the same tier (extension, filename, hint). The first match wins per the framework's priority (hint > filename > extension > content).

**`ProcessResult.mimetype` returns the matched name, not the canonical primary.** A `.jsonc` file detects as `"application/jsonc"`; service's `entry_channels.mimetype` column reflects what the operator actually stored. The handler instance is shared between primary and `also` entries — both flow through the same package's exported class. Only the metadata passed to the handler at construction time differs.

```
package: { name: "application/json", also: [{ name: "application/jsonc", extensions: [".jsonc"] }] }

.jsonc file  → mimetype: "application/jsonc"   (matched, not canonical)
.json file   → mimetype: "application/json"    (matched, equals canonical here)
hint: "application/jsonc" → mimetype: "application/jsonc"
```

The variant identity matters for handler logic that flips behavior on which name is being served (jsonc allows comments; json does not).

### §4.4 Collision policy

Collision on `(name)` or any `also[].name` across two installed packages: framework's discovery is last-loaded-wins. Service does not intervene.

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
