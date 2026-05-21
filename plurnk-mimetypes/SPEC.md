# @plurnk/plurnk-mimetypes — Specification

This document defines the duck contract, pipeline, data shapes, and policies that the framework owns. Per-mimetype handler repos consume this spec; plurnk-service consumes the pipeline.

The eventual home for the formal version of this contract is JSON Schema in [`@plurnk/plurnk-grammar`](https://github.com/plurnk/plurnk-grammar). Until then, this plain-text spec is authoritative.

---

## 1. Duck contract

A handler is any class instance whose shape matches:

```ts
interface Handler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    extract(content: string): MimeSymbol[];
    validate(content: string): void;
    symbols(content: string): string;
    preview(content: string, budget: number): Promise<string>;
}
```

In practice handlers extend `BaseHandler` (or `AntlrExtractor`), which provides every method derived from a single `extract(content) → MimeSymbol[]`. Subclasses normally implement `extract` only. Identity (`mimetype`, `glyph`, `extensions`) is injected at construction time from the handler's `package.json` `plurnk` block.

## 2. `package.json` `plurnk` discovery block

A package declares one or more mimetype handlers via a uniform `handlers` array. Single-handler and multi-handler packages use the same shape — no primary/alias asymmetry.

```json
{
    "plurnk": {
        "kind": "mimetype",
        "handlers": [
            { "name": "text/x-python", "glyph": "🐍", "extensions": [".py", ".pyw"] }
        ]
    }
}
```

Multi-handler example (one package serving variants of the same content type):

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

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | `"mimetype"` | yes | Distinguishes mimetype handlers from `"provider"` and `"scheme"` siblings in the plurnk family |
| `handlers` | HandlerDecl[] | yes | One or more handler entries (canonical shape) |

`HandlerDecl`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | The mimetype this entry registers (`text/markdown`, `application/json`, …) |
| `glyph` | string | no | Single-character display marker; defaults to empty string |
| `extensions` | string[] | no | Mixed list: entries beginning with `.` are file extensions (lowercased on match); other entries are special filenames matched verbatim (`Dockerfile`, `Makefile`) |

`discover()` scans `node_modules/@plurnk/` for packages with `plurnk.kind === "mimetype"`. Last-loaded wins on mimetype or extension conflicts.

**Resolution semantics for multi-handler packages.** Detection returns the matched name — never collapsed to another entry in the same package. A `.jsonc` file resolves to `application/jsonc`; a `.json` file resolves to `application/json`; an explicit `hint: "application/jsonc"` resolves to `application/jsonc`. `ProcessResult.mimetype` reflects the matched name so consumers (notably plurnk-service's `entry_channels.mimetype` column) preserve the variant identity.

**Handler instantiation for multi-handler packages.** Each registered name produces its own handler instance with its own metadata. Handlers may branch behavior on `this.mimetype` — e.g., `validate()` can be strict for `application/json` and permissive for `application/jsonc`. The handler class is the same across all entries; only the per-instance metadata differs.

## 3. `MimeSymbol` and `SymbolKind`

```ts
interface MimeSymbol {
    name: string;
    kind: SymbolKind;
    line: number;        // 1-indexed start
    endLine: number;     // 1-indexed end (== line for single-line symbols)
    params?: string[];   // present on functions and methods when names are available
    level?: number;      // present on heading kinds; 1-6
}

type SymbolKind =
    | "class" | "function" | "method" | "field"
    | "interface" | "enum" | "type" | "module"
    | "variable" | "constant" | "heading";
```

### Inclusion policy

Handlers include symbols that are **defined in the content and not confirmed invisible outside their declaring scope**.

- Include: classes, functions, methods, fields, interfaces, enums, types, modules, exported variables/constants, markdown headings.
- Exclude: imports, exports as standalone symbols, local variables inside function bodies, unexported module-scope variables (in languages with module privacy), function calls, control flow, comments, magic numbers, anonymous declarations.
- Class members (methods, fields) are always included — they're the API surface even though syntactically inside a class body.
- When in doubt, include. Only exclude when the language semantics *confirm* the symbol is inaccessible from outside the file.

### Parameters

Functions and methods include `params` when the grammar exposes them:

- Plain names: `["source", "options"]`
- Destructured: `["{host, port}"]` (raw text)
- Rest: `["...args"]`
- Defaults: `["entryRule=\"program\""]` (included in the assignable text)

Omit `params` entirely when the language doesn't expose named parameters.

## 4. Outline format (`symbols` / `format`)

The framework owns outline rendering. Handlers produce structured `MimeSymbol[]`; `format(symbols)` turns it into a string.

**Tree hierarchy:**
- Heading symbols: nested by `level` field (1–6).
- Other symbols: nested by line-range containment. A symbol whose `[line, endLine]` is fully inside another's is its child.

**Line rendering:**
- Heading: `<indent># Name [line]` (hash count = level, indent = tree depth).
- Other: `<indent>kind name(params)? [line-endLine]` (kind prefix, params if present, range collapses to `[N]` when single-line).
- Indent unit: two spaces per depth level.

Example:
```
class Parser [5-47]
  method parse(source) [10-20]
  method load(dir) [22-45]
function topLevel(a, b) [50-60]
```

## 5. `preview` — token-budgeted truncation

`Mimetypes.process` accepts `{ budget?: number }`. When unspecified, budget is `Number.POSITIVE_INFINITY` (no truncation — preview equals symbols). The helper does NOT invent a magic default; plurnk-service supplies the real budget per call.

**Budget unit is tokens, never characters.** The tokenize function is injected at `Mimetypes` construction time. `TokenizeFn` accepts both sync and async signatures — `(text: string) => number | Promise<number>` — so providers with WASM-backed sync tokenizers (tiktoken-js, cl100k, llama-tokenizer-js, etc.) don't pay an unnecessary microtask hop, while genuinely-async tokenizers (Gemini's REST `countTokens`) work without ceremony. The default fallback (`defaultTokenize`) is `Math.ceil(text.length / 2)` — conservative; biased toward overestimation, not the industry-standard `/4` heuristic.

**Truncation strategy (`fit`):**
1. Render full outline. If it fits, return it.
2. Drop deepest tree level. Render. Repeat until fits or only roots remain.
3. If even all-roots overflows, drop trailing root symbols one at a time until fits.
4. If even a single root overflows, return empty string (surrender — caller may invoke `fitContent` to substitute a raw-content fragment).

**Raw content fallback (`fitContent`):**
- Used when `extract()` returns `[]` (empty symbols) but the content is non-empty.
- Iteratively shrinks the content slice to fit `budget` tokens via the same tokenize function, with safety margin and max-iterations clamp.

## 6. `validate`

Default: no-op. Override only for mimetypes with a real syntax check that can fail (e.g., `application/json` throws on malformed JSON).

When `validate` throws inside `Mimetypes.process`, the error propagates to the caller per the error policy (§7).

## 7. Error policy

| Failure | Behavior |
|---|---|
| Detection returns null | `{ mimetype: null, symbols: "", preview: "", ok: false }` |
| Content read fails (path missing/unreadable) | `{ mimetype, symbols: "", preview: "", ok: false }` |
| Handler package not loadable | `{ mimetype, symbols: "", preview: <raw fallback>, ok: false }` |
| `validate()` throws | **Propagates** to the caller — contract violation |
| `extract()` throws | Contained inside `AntlrExtractor` → empty `MimeSymbol[]` → raw-content fallback |
| `extract()` returns `[]` with non-empty content | Symbols string empty; preview falls back to `fitContent(content, budget)` |

## 8. Detection priority

`detect({ path?, ext?, hint?, content? }, registry)` resolves in strict priority order, highest wins:

1. `hint` — caller asserts a mimetype directly.
2. `path` basename matches a registered filename (`Dockerfile`, `Makefile`).
3. `ext` (explicit) or `extname(path)` matches a registered extension (case-insensitive, leading-dot enforced on lookup).
4. `content` — magic-byte sniffing. **Future hook**; no implementation in v0.1.

Returns the resolved mimetype string or `null`.

`Mimetypes.detect()` (the orchestrator method) wraps the pure `detect()` and additionally applies an optional **default fallback** from `MimetypesOptions.defaultMimetype`. When all four lanes above miss but a default is configured, the orchestrator returns the default — never `null`. plurnk-service sets `defaultMimetype: "text/markdown"` because LLM output is overwhelmingly markdown; standalone consumers omit the option to preserve strict null-on-miss behavior. The default only affects the orchestrator's resolution; downstream handler discovery still applies normally (an unknown default mimetype falls into the raw-content fallback path per §7).

## 9. ANTLR extractor

For grammar-backed handlers:

1. Vendor `.g4` files in `grammar/` at the handler repo root.
2. Add the compiler and runtime to your own devDependencies (the framework declares both as optional peer deps; only ANTLR-backed handlers need them):
   ```
   npm install --save-dev antlr-ng@^1.0.10 antlr4ng@^3.0.0
   ```
3. Run `npx plurnk-mimetypes-compile` — invokes `antlr-ng -D language=TypeScript -o src/generated --generate-visitor true --generate-listener false grammar/*.g4` and post-processes the output to rewrite `.js` import extensions to `.ts` (so Node's native TS strip works without a separate build pass). Invoke via `npx` so node_modules/.bin/ is on PATH when the spawn happens.
4. Extend `AntlrExtractor` instead of `BaseHandler`.
5. Implement `parseTree(content)` (return a parser rule context) and `createVisitor()` (return an `ExtractionVisitor`).
6. Build the visitor by extending `withExtractor(GeneratedVisitor)` — the mixin adds `symbols`, `inBody`, `addSymbol(kind, name, ctx, params?, extra?)`, and `gateBody(ctx)` to the antlr4ng visitor.

Parse failures and visit-time exceptions are caught by `AntlrExtractor.extract()` and converted to an empty `MimeSymbol[]`, allowing the orchestrator's raw-content fallback to take over.

## 10. Tokenization architecture

The helper never reads any environment variable. Tokenization is a runtime injection from plurnk-service:

```
plurnk-providers-*           plurnk-service                @plurnk/plurnk-mimetypes
─────────────────            ──────────────                ────────────────────────
exports tokenize(text)  ─→   registers from active   ─→    receives at construction
                              provider                      via { tokenize }
                              caches by SHA256(text)
                              budget per call sourced
                              from PLURNK_ENTRY_SIZE_
                              DEFAULT_TOKENS env (256)
```

Handlers never see the tokenize function. The framework uses it internally for `preview` only.

## 11. Public API stability

All exports from `@plurnk/plurnk-mimetypes/index` are stable from `v0.1.0` onward under semver. Internal modules (those not re-exported from `index.ts`) are not part of the stable API and may change between minor versions.
