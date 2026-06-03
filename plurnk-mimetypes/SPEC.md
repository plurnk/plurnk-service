# @plurnk/plurnk-mimetypes — Specification

This document defines the duck contract, pipeline, data shapes, and policies that the framework owns. Per-mimetype handler repos consume this spec; plurnk-service consumes the pipeline.

The eventual home for the formal version of this contract is JSON Schema in [`@plurnk/plurnk-grammar`](https://github.com/plurnk/plurnk-grammar). Until then, this plain-text spec is authoritative.

---

## 1. Duck contract

A handler is any class instance whose shape matches:

```ts
type HandlerContent = string | Uint8Array;

interface Handler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    validate(content: HandlerContent): void | Promise<void>;
    preview(content: HandlerContent): Preview | Promise<Preview>;
    // Optional escape hatches (used by callers that want to bypass framework
    // fitting — notably plurnk-service's passive radar index path). Default
    // implementations exist on BaseHandler.
    extractRaw(content: HandlerContent): MimeSymbol[];
    symbolsRaw(content: HandlerContent): string;
}
```

**Authority split (v0.7.0).** The handler owns *what* the preview is made of; the framework owns *how* it is fit to a budget. Handlers never see the token budget or the tokenize function — they return preview *material* and the framework fits it.

```ts
type Preview = SymbolPreview | TextPreview | null;

interface SymbolPreview {
    readonly kind: "symbols";
    readonly symbols: readonly MimeSymbol[];
}

interface TextPreview {
    readonly kind: "text";
    readonly text: string;
    readonly orientation: "head" | "tail";
}
```

- `SymbolPreview` — structural outline. Framework fits via the symbol algorithm (drop-deepest-first, then drop-trailing-roots). An empty `symbols` array is fitted to an empty string.
- `TextPreview` — oriented body slice. Framework fits via head/tail truncation and inserts a `[[TRUNCATED]]` marker when the slice doesn't cover the whole content. Used for inherently flat content (`text/plain`, `text/stream`) and as a hybrid fallback in handlers whose structural extraction came up empty (markdown without headings, HTML without h-tags or title, PDF without bookmark TOC).
- `null` — handler explicitly declines. No preview signal of any kind.

**Truncation contract.** A `TextPreview` whose content exceeds budget is sliced, then marked:

- `orientation: "head"` → keep the start, append `...[[TRUNCATED]]`
- `orientation: "tail"` → keep the end, prepend `[[TRUNCATED]]...`

The marker's token cost is reserved up front so the final output stays within budget. A `TextPreview` whose content fits the budget as-is gets no marker. If the budget is so small that even the marker can't fit, the framework returns an empty string rather than a misleading silent truncation.

**The radar is a structural-or-truncated signal.** The preview channel intentionally cannot serve as a substitute for fetching the full content. Structural previews are bounded by what the handler can extract; text previews carry an explicit incompleteness marker. Either way, the consumer knows the preview is partial and must fetch for substance.

**Content shape.** Text mimetypes receive `string` (utf-8 decoded). Binary mimetypes (PDF, images, archives) receive `Uint8Array`. Handlers signal which they expect via `plurnk.binary: true` at the top of the package's `plurnk` block — applies to all handler entries in the package. The framework reads files (or routes inline content) to the appropriate shape per handler.

**Escape hatches.** `extractRaw` and `symbolsRaw` exist for callers that want unfitted structural data — they bypass `preview` entirely and are not part of the budgeted-render path. The `Raw` suffix signals "not Plan A": the framework's pipeline drives `preview` exclusively. Subclasses extending `BaseHandler` get `symbolsRaw` derived automatically from `extractRaw → format`.

In practice handlers extend `BaseHandler` (or `AntlrExtractor`):

- **Structured handlers** (JSON, YAML, TOML, CSV, source code) implement `extractRaw`; the default `preview` wraps the result as a `SymbolPreview` automatically.
- **Hybrid handlers** (markdown, HTML, PDF) override `preview` to return a `SymbolPreview` when structure is found and a head-oriented `TextPreview` over the raw content (or extracted text for PDF) when it isn't.
- **Inherently flat handlers** (`text/plain`, `text/stream`) override `preview` to always return a `TextPreview` — head-oriented for prose, tail-oriented for streams.
- **Async-source handlers** (PDF, anything requiring I/O during extraction) override `preview` directly to return `Promise<Preview>`.

Identity (`mimetype`, `glyph`, `extensions`) is injected at construction time from the handler's `package.json` `plurnk` block.

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
| `binary` | boolean | no | `true` if all handlers in the package consume `Uint8Array` content. Default `false` (utf-8 string). |
| `handlers` | HandlerDecl[] | yes | One or more handler entries (canonical shape) |

`HandlerDecl`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | The mimetype this entry registers (`text/markdown`, `application/json`, …) |
| `glyph` | string | no | Single-character display marker; defaults to empty string |
| `extensions` | string[] | no | Mixed list: entries beginning with `.` are file extensions (lowercased on match); other entries are special filenames matched verbatim (`Dockerfile`, `Makefile`) |

`discover()` scans `node_modules/@plurnk/` for packages with `plurnk.kind === "mimetype"`. Last-loaded wins on mimetype or extension conflicts.

### 2.1 Mimetype naming convention

The family follows a single resolution order. Authors of new handlers MUST consult these sources in order:

1. **IANA Media Types Registry** ([iana.org/assignments/media-types](https://www.iana.org/assignments/media-types/media-types.xhtml)) — if a mimetype is IANA-registered for the format, use it. This always wins. Pre-registration `application/x-foo` and `application/vnd.*` variants are abandoned in favor of the registered name (e.g. `application/protobuf`, not `application/x-protobuf`; `application/vnd.datalog`, not `text/x-datalog`).
2. **GitHub Linguist** (`codemirror_mime_type` and aliases in `languages.yml`) — the de facto convention used by tooling-side ecosystems (Linguist, mime-db, VS Code, freedesktop). Adopt when IANA is silent. Examples: `text/x-pgsql` for PostgreSQL, `text/x-mysql` for MySQL/MariaDB, `text/x-csrc` for C source.
3. **House style: `text/x-{lang}`** — the IETF experimental tree, used uniformly for source code in non-registered languages (Rust, Go, Kotlin, Swift, Elixir, Zig, etc.).

**Multiple legitimate conventions:** when two or more equally-supported names exist (e.g. `text/x-cpp` is house-style coherent, `text/x-c++src` is the Linguist convention), register all of them. Each becomes its own handler entry pointing to the same class. Consumers using any of them get correct routing. Example:

```json
{
    "plurnk": {
        "kind": "mimetype",
        "handlers": [
            { "name": "text/x-cpp",     "glyph": "🟦", "extensions": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"] },
            { "name": "text/x-c++src",  "glyph": "🟦", "extensions": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"] },
            { "name": "text/x-c++",     "glyph": "🟦", "extensions": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"] }
        ]
    }
}
```

**Do not:**
- Use `text/{lang}` without the `x-` prefix unless the format is IANA-registered (`text/markdown`, `text/csv`, `text/javascript` are fine — they're registered; `text/python` is not registered, so use `text/x-python`).
- Append `-sql`, `-cli`, `-script`, etc. to differentiate dialects. The bare dialect name is the convention: `text/x-sqlite`, `text/x-pgsql`, `text/x-redis` — not `text/x-sqlite-sql`, `text/x-redis-cli`.
- Keep pre-IANA-registration legacy names as aliases. When IANA registers a name, drop the legacy `x-` form on the next minor bump.

**SQL dialect summary:** `text/x-sqlite`, `text/x-pgsql`, `text/x-mysql` (covers MariaDB-compat too), `text/x-tsql`, `text/x-plsql`. Generic / dialect-agnostic SQL is IANA's `application/sql` (RFC 6922) — reserved for cases where the dialect truly isn't known.

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

## 4. Outline format (`symbolsRaw` / `format`)

The framework owns outline rendering. Handlers produce structured `MimeSymbol[]`; `format(symbols)` turns it into a string. `BaseHandler.symbolsRaw` is the default `format(extractRaw(content))` composition.

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

## 5. `preview` — token-budgeted fitting

`Mimetypes.process` accepts `{ budget?: number }`. When unspecified, budget is `Number.POSITIVE_INFINITY` (no fitting — the handler's full material renders as-is). The helper does NOT invent a magic default; plurnk-service supplies the real budget per call.

**Budget unit is tokens, never characters.** The tokenize function is injected at `Mimetypes` construction time. `TokenizeFn` accepts both sync and async signatures — `(text: string) => number | Promise<number>` — so providers with WASM-backed sync tokenizers (tiktoken-js, cl100k, llama-tokenizer-js, etc.) don't pay an unnecessary microtask hop, while genuinely-async tokenizers (Gemini's REST `countTokens`) work without ceremony. The default fallback (`defaultTokenize`) is `Math.ceil(text.length / 2)` — conservative; biased toward overestimation, not the industry-standard `/4` heuristic.

**Authority.** Handlers are the sole authority on preview material — symbols, oriented text, or nothing. The framework is the sole authority on fitting that material to the budget. The framework never substitutes shapes (won't convert symbols to text or vice versa) and never invents content beyond the truncation marker on a TextPreview.

**Dispatcher (`fitPreview`):**
- `null` → `""`.
- `SymbolPreview` → `fitSymbols(symbols, budget, tokenize)`.
- `TextPreview` → `fitContent(text, budget, tokenize, orientation)`.

**Symbol fitting (`fitSymbols`):**
1. Render full outline. If it fits, return it.
2. Drop deepest tree level. Render. Repeat until fits or only roots remain.
3. If even all-roots overflows, drop trailing root symbols one at a time until fits.
4. If even a single root overflows, return empty string.

**Text fitting (`fitContent`):**
1. If the whole content fits in budget, return it as-is (no marker).
2. Otherwise reserve marker tokens (`...[[TRUNCATED]]` for head, `[[TRUNCATED]]...` for tail) from the budget.
3. Iteratively shrink the content slice toward the head- or tail-end until it fits the effective budget.
4. Append or prepend the marker by orientation.
5. If even the marker won't fit alone, return empty string rather than mislead with a silent partial.

**Why the truncation marker.** The marker is what lets us responsibly offer text-body previews at all. Without it, a body slice in the preview channel teaches consumers (especially LLM consumers) to treat the preview as a substitute for fetching the content. The marker makes incompleteness *visible*: the model can read the slice for navigation but the sentinel says "fetch for substance." This unlocks previewing inherently flat content (`text/plain`, `text/stream`) and providing useful fallbacks for hybrid handlers (markdown without headings, HTML without h-tags, PDF without bookmark TOC) without giving up the radar-vs-fetch distinction.

## 6. `validate`

Default: no-op. Override only for mimetypes with a real syntax check that can fail (e.g., `application/json` throws on malformed JSON).

When `validate` throws inside `Mimetypes.process`, the error propagates to the caller per the error policy (§7).

## 7. Error policy

`ProcessResult = { mimetype, preview, previewTokens, totalLines, ok }` — no `symbols` field. Handlers that want unfitted structural data call `getHandler(mimetype)` directly and invoke `symbolsRaw` / `extractRaw` themselves.

`previewTokens` is the token count of the returned `preview` string, measured with the same `tokenize` function the orchestrator was constructed with. Exposed so consumers (notably plurnk-service's tokenomics ledger) don't have to re-tokenize the preview to recover its render cost. Always present; `0` for empty previews (every error path, plus the `null` handler return). Empty previews short-circuit without paying a `tokenize` call.

`totalLines` is the editor-convention line count of the source content. Exposed so the model can reason about context management (e.g., "this preview shows lines 8–12 of a 200-line file"). Conventions:

- `wc -l`-style — `abc\ndef` → `2`, `abc\ndef\n` → `2` (trailing newline is line terminator, not new line), `"\n"` → `1`, `""` → `0`.
- **Binary content** (mimetypes flagged `binary: true` in their `plurnk` block — PDF, future images/archives): `totalLines: 0`. Lines aren't a meaningful unit for binary mimetypes; service reasons about size differently (e.g., pages for PDF). `0` is the explicit "not line-oriented" signal.
- `0` on every error path (detection null, content unreadable, handler missing).
- Independent of preview fitting — a budget-truncated preview still reports the full source's `totalLines`. The preview shows what fit; `totalLines` says how big the full thing is.

**Preview rendering (#8).** `Mimetypes.process` returns `preview` ready for verbatim rendering — consumers do no post-processing. Specifically:

- **`SymbolPreview`** → outline emitted as-is. The outline already carries source-line annotations inline (`class Parser [5-47]`, `  method parse [10-20]`), so no further line-numbering is applied.
- **`TextPreview` (head)** → each line prefixed with `${sourceLine}:\t` starting at 1, per plurnk-grammar's plurnk.md §"Paths" convention (also referenced by plurnk-service SPEC §16.6). The trailing `...[[TRUNCATED]]` marker rides on the final line.
- **`TextPreview` (tail)** → each line prefixed with `${sourceLine}:\t` starting at the source line of the first surviving character (computed by finding the slice's offset in `material.text` and counting newlines before it). The leading `[[TRUNCATED]]...` marker rides on the first line — its source-line label reflects the source line that line begins in.
- **`null` / empty** → emitted as `""`, no rendering applied.

The line-numbering format (`N:\t<line>`) is the family-wide convention; consumers render `preview` directly. `previewTokens` reflects the count of the *rendered* string, including prefix overhead.

| Failure | Behavior |
|---|---|
| Detection returns null | `{ mimetype: null, preview: "", ok: false }` |
| Content read fails (path missing/unreadable) | `{ mimetype, preview: "", ok: false }` |
| Handler package not loadable | `{ mimetype, preview: "", ok: false }` |
| `validate()` throws | **Propagates** to the caller — contract violation |
| `preview()` (handler) throws | Contained per handler discipline (`AntlrExtractor` catches inside `extractRaw`; HTML/PDF return `null` on parse failure). Framework does not catch. |
| `preview()` returns `null` | `{ mimetype, preview: "", ok: true }` — handler explicitly declines, by design |
| `SymbolPreview` whose first root won't fit | `{ mimetype, preview: "", ok: true }` — symbols asked for, symbols would not fit; no substitution to text |
| `TextPreview` whose content overflows budget | `{ mimetype, preview: "<slice><marker>" \| "<marker><slice>", ok: true }` — truncated and marked per orientation |
| `TextPreview` whose budget can't fit even the marker | `{ mimetype, preview: "", ok: true }` — too small to convey incompleteness honestly |

## 8. Detection priority

`detect({ path?, ext?, hint?, content? }, registry)` resolves in strict priority order, highest wins:

1. `hint` — caller asserts a mimetype directly.
2. `path` basename matches a registered filename (`Dockerfile`, `Makefile`).
3. `ext` (explicit) or `extname(path)` matches a registered extension (case-insensitive, leading-dot enforced on lookup).
4. `content` — magic-byte sniffing. **Future hook**; no implementation in v0.1.

Returns the resolved mimetype string or `null`.

`Mimetypes.detect()` (the orchestrator method) wraps the pure `detect()` and additionally applies an optional **default fallback** from `MimetypesOptions.defaultMimetype`. When all four lanes above miss but a default is configured, the orchestrator returns the default — never `null`. plurnk-service sets `defaultMimetype: "text/markdown"` because LLM output is overwhelmingly markdown; standalone consumers omit the option to preserve strict null-on-miss behavior. The default only affects the orchestrator's resolution; downstream handler discovery still applies normally (an unknown default mimetype falls into the raw-content fallback path per §7).

## 9. Parser backends

### 9.1 Backend selection hierarchy

Handler authors choose a parser backend in this order:

1. **`web-tree-sitter` (WASM)** — first preference. Lean on the most battle-tested parser ecosystem (GitHub Code Search, VS Code, Helix, Neovim, atom-ide). Tree-sitter grammars are widely maintained, error-recovery is designed-in, and the WASM distribution is fully portable (no native deps, no install-time build tools).
2. **`antlr4ng` + grammars-v4** — second preference. When tree-sitter doesn't have the language, has only an incomplete grammar, or when the grammar quality is meaningfully better in grammars-v4. Pure JS, no native deps.
3. **Hand-rolled scanner** — third preference. For syntactically simple formats (S-expressions, line-oriented configs, Dockerfile-style instruction streams) where a focused 100–300-line scanner beats depending on a generated parser. Zero deps.

**Forbidden backends:**
- Native `tree-sitter` (node-gyp-based). Requires Python + C compiler at install time — fails on Alpine, on bare Lambda, on Cloudflare Workers, on minimal containers. Not portable.
- Any package requiring native FFI bindings or platform-specific binaries at install.

The portability rule preserves the original premise of the ecosystem: every handler installs cleanly with `npm install` on any platform Node runs on.

### 9.2 Existing handlers

ANTLR-backed handlers shipped at 0.1.x stay on ANTLR. The hierarchy applies forward — new handlers default to tree-sitter unless they fall through. Existing handlers may migrate to tree-sitter only when a specific limitation justifies the work (e.g., known grammar bugs in graphql/zig/scala2/php where the tree-sitter version handles the case correctly). Wholesale rewrites are out of scope.

### 9.3 ANTLR extractor

For ANTLR-backed handlers (existing pattern, still supported):

1. Vendor `.g4` files in `grammar/` at the handler repo root.
2. Add the compiler and runtime to your own devDependencies (the framework declares both as optional peer deps; only ANTLR-backed handlers need them):
   ```
   npm install --save-dev antlr-ng@^1.0.10 antlr4ng@^3.0.0
   ```
3. Run `npx plurnk-mimetypes-compile` — invokes `antlr-ng -D language=TypeScript -o src/generated --generate-visitor true --generate-listener false grammar/*.g4` and post-processes the output to rewrite `.js` import extensions to `.ts` (so Node's native TS strip works without a separate build pass). Invoke via `npx` so node_modules/.bin/ is on PATH when the spawn happens.
4. Extend `AntlrExtractor` instead of `BaseHandler`.
5. Implement `parseTree(content)` (return a parser rule context) and `createVisitor()` (return an `ExtractionVisitor`).
6. Build the visitor by extending `withExtractor(GeneratedVisitor)` — the mixin adds `symbols`, `inBody`, `addSymbol(kind, name, ctx, params?, extra?)`, and `gateBody(ctx)` to the antlr4ng visitor.

Parse failures and visit-time exceptions are caught by `AntlrExtractor.extractRaw()` and converted to an empty `MimeSymbol[]`. The default `preview` then returns a `SymbolPreview` with an empty `symbols` array, which the framework fits to an empty string — there is no substitution to text content.

### 9.4 Tree-sitter extractor (planned)

Open design question: tree-sitter grammars require async WASM init, while `BaseHandler.extractRaw` is currently sync. Two viable paths:

1. **Lazy-init with primed cache.** First `extractRaw` call returns `[]` while the WASM grammar initializes in the background; subsequent calls return real symbols. Pros: keeps `extractRaw` sync. Cons: silent first-call miss is surprising. Could be mitigated by exposing `await handler.ready()` or having the framework pre-warm on construction.
2. **Promote `extractRaw` to `string | Promise<MimeSymbol[]>`.** Make the async-ness explicit in the contract. Pros: honest. Cons: ripples through every consumer.

To be decided when the first tree-sitter handler is built. Until then, defer tree-sitter for languages currently shippable via ANTLR or hand-roll.

### 9.5 Hand-rolled extractor

Extend `BaseHandler` directly and implement `extractRaw(content)`. No framework support beyond the symbol type. Used for: text-common-lisp (S-expression scanner) and future text-dockerfile, text-makefile.

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

Handlers never see the tokenize function or the budget — they return preview *material* (`SymbolPreview | null`) and the framework dispatches to the right fitter. This is what makes the authority split clean: handlers cannot accidentally double-count tokens, cannot pick the wrong tokenizer, and cannot leak budget logic into per-mimetype repos.

## 11. Body-matcher query

Plurnk-service dispatches `FIND`/`READ`/`SHOW`/`HIDE` body matchers through `Mimetypes.query(input, expression)`. The framework parses the matcher's leading prefix to a `QueryDialect` (per plurnk-grammar's plurnk.md table) and forwards to the resolved handler's `query(content, dialect, pattern, flags?)`.

### 11.1 Dialect dispatch

| Leading prefix | Dialect | Form |
|---|---|---|
| `//` | xpath | `//selector` |
| `/` | regex | `/pattern/[igmsuy]?` (escape `\/` inside pattern body) |
| `$` | jsonpath | `$.field` |
| otherwise | glob | `pattern` |

Implemented by the framework's `parseBodyMatcher(expr)`. Order matters — `//` is tested before `/` because both begin with `/`.

### 11.2 Per-match return shape (from plurnk-grammar #17)

```ts
interface QueryMatch {
    readonly line: number;             // 1-indexed source position
    readonly matched: unknown;         // polymorphic per dialect (see below)
    readonly matching?: string;        // resolved canonical locator when disambiguating
}
```

`matched` is polymorphic by extractor:

| Dialect | Extractor variant | `matched` shape |
|---|---|---|
| regex | bare (no captures) | string (the full match) |
| regex | anonymous captures | array `[c1, c2, ...]` |
| regex | named (and mixed) captures | object `{name: value, ..., "1": ..., "2": ...}` |
| glob | line-anchored | string (the matching line) |
| jsonpath | any | the JSON value at the resolved path (any shape) |
| xpath | text/attribute node | string |
| xpath | element node | serialized XML string |

`matching` is the resolved locator for multi-match dialects: jsonpath wildcards emit `$.users[0].name` etc.; xpath multi-match emits `(//user)[1]` etc.; regex omits it (captures + line carry discrimination).

### 11.3 Handler defaults

`BaseHandler.query` provides defaults:

- **regex / glob** — apply against `toText(content)`. Default `toText` returns string content as-is; for binary content it throws `UnsupportedDialectError`. Handlers with binary content (PDF) override `toText` to provide a text projection (e.g. extracted page text).
- **jsonpath** — apply against the **bare-leaves outline** built from `extractRaw`:

  ```json
  { "Parser": { "parse": 10, "load": 22 }, "topLevel": 50 }
  ```

  Nesting matches structural depth; leaves are bare line numbers; parents are objects. No `kind`, no `endLine`, no `params` — those live on `MimeSymbol` for callers using `extractRaw` directly but are absent from the queryable shape. This is the unified shape across markdown, HTML headings, PDF outline, and source-code symbol trees: one navigation idiom for the model.

  Handlers whose mimetype has a native JSON-shaped representation (`application/json`, `application/yaml`, `application/toml`, `text/csv`) override `query` to dispatch jsonpath against the parsed value instead of the outline. Line resolution is per-handler (jsonc-parser tree, yaml Document positions, etc.).
- **xpath** — throws `UnsupportedDialectError`. `text/html` overrides to apply xpath against the parsed DOM.

### 11.4 Error policy

| Condition | Behavior |
|---|---|
| Detection returns null | `Mimetypes.query` throws `ReferenceError` |
| Content unreadable | `Mimetypes.query` throws `ReferenceError` |
| Dialect unsupported for resolved mimetype | `UnsupportedDialectError` → consumer maps to 415 |
| Body-glob 415 case (not in v0.6.0) | per grammar #17, glob-on-body returns line matches; no 415 |
| Malformed expression | `InvalidExpressionError` → consumer maps to 400 |
| Content can't be parsed for the dialect | `QueryParseFailureError` → consumer maps to 422 |
| Zero matches | returns `[]` → consumer maps to 204 |

### 11.5 TelemetryEvent envelope

All three error classes expose `toTelemetryEvent(): TelemetryEvent` per plurnk-mimetypes#5 / plurnk-grammar 0.17.0. Consumers can route on `source` + `kind` instead of `instanceof` checks; `source` is `mimetype:<normalized-type>` (slashes/special chars → `_`); `kind` is one of `unsupported_dialect`, `invalid_expression`, `query_parse_failure`. The envelope is open-schema — error-specific fields (`dialect`, `expression`, `reason`, `mimetype`) surface as additional properties so consumers don't need to re-parse the message.

## 12. Public API stability

All exports from `@plurnk/plurnk-mimetypes/index` are stable from `v0.1.0` onward under semver. Internal modules (those not re-exported from `index.ts`) are not part of the stable API and may change between minor versions.
