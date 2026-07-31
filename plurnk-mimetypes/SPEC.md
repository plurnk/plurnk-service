# @plurnk/plurnk-mimetypes — Specification

This document defines the duck contract, pipeline, data shapes, and policies that the framework owns. Per-mimetype handler repos consume this spec; plurnk-service consumes the pipeline.

TypeScript exports define the executable API. This document defines the
behavioral contract for handler authors and consumers.

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
    // Structural channels (§12): extractRaw feeds the symbols channel
    // (definitions); deepJson/deepXml are the jsonpath/xpath query targets;
    // references carries classified symbol uses (§16). Default deepXml =
    // projectJsonToXml(deepJson) — handlers never write XML serialization.
    extractRaw(content: HandlerContent): MimeSymbol[] | Promise<MimeSymbol[]>;
    deepJson(content: HandlerContent): unknown | Promise<unknown>;
    deepXml(content: HandlerContent): Promise<string>;
    references(content: HandlerContent): MimeRef[] | Promise<MimeRef[]>;
    // Model-facing readable text (§18). Default undefined; only handlers that
    // transform an already-textual-but-noisy body override it (text/html →
    // markdown).
    content(content: HandlerContent): string | undefined | Promise<string | undefined>;
    // Body-matcher dispatch (§11). Default implementation on BaseHandler.
    query(content: HandlerContent, dialect: QueryDialect, pattern: string, flags?: string): Promise<QueryMatch[]>;
    // Rendered outline — format(extractRaw). Diagnostic / human surface.
    symbolsRaw(content: HandlerContent): Promise<string>;
}
```

**Authority split.** The handler is the sole authority on each channel's material; the framework owns channel selection (§5), routing, the default deep-xml projection, and the references query-file engine (§16). There is no token budget anywhere in the framework — budgeting, rendering, and tokenization are consumer concerns.

**Content shape.** Text mimetypes receive `string` (utf-8 decoded). Binary mimetypes (PDF, images, archives) receive `Uint8Array`. Handlers signal which they expect via `plurnk.binary: true` at the top of the package's `plurnk` block — applies to all handler entries in the package. The framework reads files (or routes inline content) to the appropriate shape per handler.

**Outline rendering.** `symbolsRaw` (= `format(await extractRaw(content))`) renders the structured symbols as an indented outline for humans and diagnostics. It is not budgeted and not part of the consumer pipeline — `Mimetypes.process` returns the structured `MimeSymbol[]` directly.

In practice handlers extend `BaseHandler` (or `TreeSitterExtractor` / `AntlrExtractor`) and override the channels their algebra supports:

- **Structured handlers** (JSON, YAML, TOML, CSV, source code) implement `extractRaw` and `deepJson`.
- **Markup handlers** (HTML, XML) additionally override `deepXml` and/or `query` to serve real source markup for xpath.
- **Flat handlers** (`text/plain`, `text/stream`) override nothing - empty symbols and null deepJson are the honest channels for unstructured content; such entries contribute `totalLines` metadata only.
- **Binary handlers** (PDF) override `toText` for regex/glob query support and `content` when they provide model-readable text.

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
| `attribution` | string \| string[] | no | Plugin attribution tags (issue #37). Surfaced raw on every discovered handler's `HandlerInfo.attribution`; the host unions active plugins' tags onto model `generate({ attributions })` calls. `discover()` passes it through verbatim — the host owns the reservation policy (`@plurnk/` tags allowed only from `@plurnk/`-scoped packages). Absent for framework tree-sitter built-ins. |
| `handlers` | HandlerDecl[] | yes | One or more handler entries (canonical shape) |

`HandlerDecl`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | The mimetype this entry registers (`text/markdown`, `application/json`, …) |
| `glyph` | string | no | Single-character display marker; defaults to empty string |
| `extensions` | string[] | no | Mixed list: entries beginning with `.` are file extensions (lowercased on match); other entries are special filenames matched verbatim (`Dockerfile`, `Makefile`) |

`discover()` scans **all of `node_modules`** — unscoped packages and every `@scope/*` — for `plurnk.kind === "mimetype"` (issue #28), so a third-party handler (`@acme/acme-mime-foo`) is discovered exactly like a first-party one, matching the executor discovery the ecosystem standardized on. `discover()` is a trust-agnostic scanner; the host (plurnk-service) applies any trust policy to its results. Last-loaded wins on mimetype/extension conflicts, and `@plurnk` is scanned last so a first-party (floor) handler wins a collision — a third party can add a new mimetype but cannot silently shadow the floor.

**Trust gate (issue #29 / plurnk-service#229).** `discover()` reads `PLURNK_PLUGINS_TRUSTED_ONLY` — the ecosystem-wide host plugin posture, the same env var all four discovery surfaces honor. unset / empty / `0` → off (every discovered handler registers; default, no regression). A value → on: `@plurnk/*` is always trusted, plus a comma-separated allowlist of additionally-trusted package names (`"@acme/acme-mime-foo, mime-bar"`); setting it to `1` (no real package) means "on with zero third-party." An untrusted package is discovered-but-not-registered — skipped, never a crash.

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
    column?: number;     // 1-indexed start column (issue #18); emitted by
    endColumn?: number;  //   tree-sitter and ANTLR extraction
    params?: string[];   // present on functions and methods when names are available
    level?: number;      // present on heading kinds; 1-6
    container?: string;  // qualified path of enclosing named symbols (issue #18)
}

type SymbolKind =
    | "class" | "function" | "method" | "field"
    | "interface" | "enum" | "type" | "module"
    | "variable" | "constant" | "heading";
```

### Container (issue #18)

`container` is the dot-joined path of the enclosing *emitted* named symbols: `parse` inside class `Parser` carries `container: "Parser"`; a method on a nested class carries `"Outer.Inner"`. Absent (not empty-string) for top-level symbols. Rules:

- Only symbols the handler actually emits participate in the path — anonymous scopes and unemitted wrappers contribute nothing.
- A segment whose own name is dotted (Elixir `defmodule Foo.Bar`, TOML `[database.options]`) is used verbatim as one segment; consumers must not assume segments are dot-free.
- `container` is extraction-time truth and the def-side identity the code graph links on: `(entry, container, name)`. `buildTree`'s line-range containment remains the render-time nesting mechanism; the two usually agree but `container` wins when they don't.

Columns follow the family convention: 1-indexed, `endColumn` is the position just past the last character on `endLine` (tree-sitter `endPosition.column + 1`).

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

## 5. Channel selection (issue #17)

`Mimetypes.process(input, { channels? })` materializes exactly the requested channels:

```ts
type Channel = "symbols" | "deepJson" | "deepXml" | "references" | "content" | "embedding";
```

- **Default set: `symbols`, `deepJson`, `deepXml`, `references`, `content`** (five). `content` (§18) is cheap pure-JS and ships by default; `embedding` (§17) is model inference and is **opt-in only** — never in the default set. `process()` remains the universal projection surface (#11); callers that want less say less.
- **Unrequested channels are not computed and their fields are absent** from `ProcessResult`. A channel an entry legitimately lacks (flat text has no deep tree) comes back *present but empty* (`[]` / `null` / `""`) — absence means "not asked," emptiness means "asked, nothing there."
- **`channels: []` is valid** - metadata only (`mimetype`, `ok`, `totalLines`), no parse paid. This is the cheap stat call (plurnk-service's manifest uses it for line counts).
- The default deep-xml projection consumes the deep-json value; when `deepXml` alone is requested the framework computes deep-json internally without exposing it.

Known consumer selections (plurnk-service): manifest → `[]`; body-matcher plugin → `["deepJson", "deepXml"]`; graph/semantic add-time pipeline → `["symbols", "references"]`.

There is no token budget, no tokenizer, and no rendered preview anywhere in the pipeline. The pre-0.15 fitting layer (`fitPreview`/`fitSymbols`/`fitContent`, `TokenizeFn`, truncation markers, head/tail orientation) was removed with its only consumer, plurnk-service's index. Rendering structured symbols for humans is `format()` (§4), unbudgeted.

## 6. `validate`

Default: no-op. Override only for mimetypes with a real syntax check that can fail (e.g., `application/json` throws on malformed JSON).

When `validate` throws inside `Mimetypes.process`, the error propagates to the caller per the error policy (§7).

## 7. Error policy

`ProcessResult`:

```ts
interface ProcessResult {
    // always-on metadata
    mimetype: string | null;
    ok: boolean;
    totalLines: number;
    grammarMissing?: string;   // §13.4
    searchExcluded?: string;          // §21 — matched SEARCH_EXCLUDE pattern
    notices?: readonly Notice[];   // non-fatal degradation observations — §11.5
    // channels — present iff requested (§5)
    symbols?: MimeSymbol[];    // structured definitions; render via format() if needed
    deepJson?: unknown;
    deepXml?: string;
    references?: MimeRef[];    // §16
    content?: string;          // §18 — model-facing readable projection (HTML → markdown)
    embedding?: Uint8Array;    // §17 — Float32 bytes; opt-in
    embeddingMissing?: string; // §17 — install hint when the embedder package is absent
    embeddingModel?: string;   // §17 — vector identity (staleness detector)
}
```

`totalLines` is the editor-convention line count of the source content. Conventions:

- `wc -l`-style — `abc\ndef` → `2`, `abc\ndef\n` → `2` (trailing newline is line terminator, not new line), `"\n"` → `1`, `""` → `0`.
- **Binary content** (mimetypes flagged `binary: true` in their `plurnk` block - PDF, future images/archives): `totalLines: 0`. Lines are not a meaningful unit for the source bytes. A handler's readable `content` projection is independently line-addressable; `totalLines` does not describe that derived text.
- `0` on every error path (detection null, content unreadable, handler missing).

| Failure | Behavior |
|---|---|
| Detection returns null | `{ mimetype: null, ok: false, totalLines: 0 }` - no channel fields |
| Content read fails (path missing/unreadable) | `{ mimetype, ok: false, totalLines: 0 }` - no channel fields |
| Handler package not loadable | `{ mimetype, ok: false, totalLines: 0 }` - no channel fields |
| Grammar package not installed (#14) | Degrades: `ok: true`, real `totalLines`, requested channels present but empty, `grammarMissing` set to the package name. `{ strict: true }` throws `GrammarNotInstalledError` instead. |
| `validate()` throws | **Propagates** to the caller — contract violation |
| Channel method throws inside handler | Contained per handler discipline (`AntlrExtractor`/`TreeSitterExtractor` catch parse failures inside `extractRaw`/`deepJson` and return empty/null). Framework does not catch. |

## 8. Detection priority

`detect({ path?, ext?, hint? }, registry)` resolves in strict priority order,
highest wins:

1. `hint` — caller asserts a mimetype directly.
2. `path` basename matches a registered filename (`Dockerfile`, `Makefile`).
3. `ext` (explicit) or `extname(path)` matches a registered extension (case-insensitive, leading-dot enforced on lookup).

Returns the resolved mimetype string or `null`.

`Mimetypes.detect()` wraps the pure function and applies an optional fallback
from `MimetypesOptions.defaultMimetype`. When all lanes miss but a default is
configured, it returns that default. The fallback does not alter handler
discovery; an unknown default still produces the §7 handler-missing result.

## 9. Parser backends

### 9.1 Backend selection hierarchy

Handler authors choose a parser backend in this strict order. **The hierarchy is mechanical — if a higher-tier option exists and meets the quality bar, use it.**

1. **Tree-sitter registry.** Languages with a complete, faithful upstream grammar live in `TREE_SITTER_REGISTRY`; the corresponding `@plurnk/plurnk-mimetypes-grammar-{slug}` leaf supplies its reproducibly built WASM.
2. **Dedicated handler.** Languages without a faithful Tree-sitter grammar use a separate handler package only when another parser can satisfy the same quality bar.
3. **Tier 3 — `antlr4ng` + grammars-v4 in `@plurnk/plurnk-mimetypes-{lang}` package.** When no tree-sitter grammar exists at all (Tier 1 and Tier 2 both unavailable). Pure JS, no native deps. Follows the existing AntlrExtractor pattern.
4. **Tier 4 — hand-rolled scanner in `@plurnk/plurnk-mimetypes-{lang}` package.** True last resort, only when none of the above has the language and the syntax is simple enough that a focused scanner is honestly cleaner than vendoring an alternative grammar. Handler README must justify why Tiers 1–3 weren't viable. Zero deps.

**Forbidden backends (apply across all tiers):**
- Native `tree-sitter` (node-gyp-based). Requires Python + C compiler at install time — fails on Alpine, on bare Lambda, on Cloudflare Workers, on minimal containers. Not portable.
- Any package requiring native FFI bindings or platform-specific binaries at install.
- Pushing emscripten/toolchain requirements onto the consumer at install time. Tier 2's emscripten dependency lives in the handler package's CI / publish pipeline; what ships to npm is pre-built `.wasm`.

**Coverage breadth is not a goal that overrides extraction quality.** If the best available backend for a language can't produce a complete, faithful extraction (correct symbol kinds across the language's full surface, no silent corruption on common idioms, no whole-class gaps like "we don't handle classes with type parameters"), the language **defers** — it stays out of the registry and out of `@plurnk` packages until a proper solution is available. We do not ship marquee-language handlers that document known limitations as caveats; if the implementation isn't enterprise-grade, the absence is more honest than the half-measure.

Examples of legitimate deferrals: a language whose tree-sitter grammar (whether clean-WASM or build-from-source) lacks an idiomatic construct that real-world code uses heavily; a language where the grammar exists but parses 70% of typical files. These wait for the right backend rather than getting a partial handler with a README disclaimer. **The decision rule for promoting a deferred language *to* Tier 2 is "would we be embarrassed not to ship this language."** Marquee languages (Swift, Dockerfile) qualify; obscure DSLs typically don't.

**Dispatch precedence at runtime:** `@plurnk/plurnk-mimetypes-{lang}` packages (Tiers 2/3/4) win conflicts against the Tier 1 registry. This lets a Tier 1 entry get promoted to Tier 2 (e.g., to override a buggy upstream grammar with a forked build) without ceremony — the package's presence in node_modules takes precedence.

The portability rule preserves the original premise of the ecosystem: every handler installs cleanly with `npm install` on any platform Node runs on. The quality rule preserves the credibility of the registry as a coverage claim. The four-tier model means coverage can grow without sacrificing either.

### 9.2 ANTLR extractor

For ANTLR-backed handlers (existing pattern, still supported):

1. Vendor `.g4` files in `grammar/` at the handler repo root.
2. Add the compiler to your own devDependencies (the `antlr4ng` runtime ships with the framework as a direct dependency; the `antlr-ng` compiler is the framework's only optional peer):
   ```
   npm install --save-dev antlr-ng@^1.0.10
   ```
3. Run `npx plurnk-mimetypes-compile` — invokes `antlr-ng -D language=TypeScript -o src/generated --generate-visitor true --generate-listener false grammar/*.g4` and post-processes the output to rewrite `.js` import extensions to `.ts` (so Node's native TS strip works without a separate build pass). Invoke via `npx` so node_modules/.bin/ is on PATH when the spawn happens.
4. Extend `AntlrExtractor` instead of `BaseHandler`.
5. Implement `parseTree(content)` (return a parser rule context) and `createVisitor()` (return an `ExtractionVisitor`).
6. Build the visitor by extending `withExtractor(GeneratedVisitor)` — the mixin adds `symbols`, `inBody`, `addSymbol(kind, name, ctx, params?, extra?)`, and `gateBody(ctx)` to the antlr4ng visitor.

Parse failures and visit-time exceptions are caught by `AntlrExtractor.extractRaw()` and converted to an empty `MimeSymbol[]` — the symbols channel comes back empty rather than erroring; there is no substitution to text content.

### 9.3 Async `extractRaw` contract

`BaseHandler.extractRaw(content)` returns `MimeSymbol[] | Promise<MimeSymbol[]>` — synchronous handlers (AntlrExtractor, hand-rolled) return the array directly; tree-sitter handlers return a promise to honor WASM grammar init. Every consumer (`Mimetypes.process`, `symbolsRaw`, query routes) **`await`s the result unconditionally** — the union is awaitable either way.

### 9.4 Tree-sitter extractor

For tree-sitter-backed handlers:

1. The `web-tree-sitter` runtime ships with the framework as a direct dependency; no handler-side install needed.
2. Own the language's WASM: a pre-built `.wasm` committed in the handler package from a pinned upstream commit (§13.5).
3. Extend `TreeSitterExtractor` instead of `BaseHandler`.
4. Implement `loadParser()` (async; init web-tree-sitter, load the language WASM, return a ready parser) and `extractFromTree(tree, content)` (return `MimeSymbol[]` from the parsed tree). The base class handles parser lifecycle and async coordination via a primed-promise cache.

Parse failures are caught by `TreeSitterExtractor.extractRaw()` and converted to an empty `MimeSymbol[]`, mirroring AntlrExtractor's error policy.

### 9.5 Hand-rolled extractor

For the rare format where neither tree-sitter nor grammars-v4 has coverage and the syntax is simple enough to scan directly: extend `BaseHandler` and implement `extractRaw(content)` returning `MimeSymbol[]` (or `Promise<MimeSymbol[]>` if the scanner needs async I/O, which it shouldn't). The handler README must justify why neither §9.4 nor §9.2 was viable — the bar is intentionally high to keep the family converged on community-maintained grammars.

## 10. Tokenization — a consumer concern

The framework neither tokenizes nor budgets content for its own pipeline. Token counting is wholly a consumer concern — the service tokenizes content with its live provider at render time and never trusts write-time counts. The opt-in `Tokenizers` seam (§19) exposes exact model-vocab counting *for consumers that want it*; the framework never calls it for its own budgeting.

## 11. Body-matcher query

Plurnk-service dispatches FIND and READ body matchers through
`Mimetypes.query(input, expression)`. Standalone consumers may pass raw matcher
syntax for framework classification; PLURNK passes the grammar's already-parsed
dialect to the resolved handler's `query(content, dialect, pattern, flags?)`.

### 11.1 Dialect dispatch

| Leading prefix | Dialect | Form |
|---|---|---|
| `//` | xpath | `//selector` |
| `/` | regex | `/pattern/flags` (ECMAScript flags; escape `\/` inside the pattern) |
| `$` | jsonpath | `$.field` |
| otherwise | glob | `pattern` |

Implemented by the framework's `parseBodyMatcher(expr)`. Order matters — `//` is tested before `/` because both begin with `/`.

**Parsed-form entry (#42).** `Mimetypes.query(input, matcher)` accepts `matcher` as **either** a raw string (classified by the table above) **or** an already-parsed `ParsedBodyMatcher { dialect, pattern, flags? }` - the same shape `@plurnk/plurnk-grammar` produces when it parses the model-facing matcher syntax. A caller that already holds the parsed body (plurnk-service receives it from the grammar) passes the object and the framework dispatches it **verbatim** - `parseBodyMatcher` is skipped entirely. This is deliberate: the grammar owns the matcher syntax, so re-deriving the dialect inside mimetypes would be a second parser for one syntax and a silent drift surface. The parsed form's declared dialect is authoritative. Both forms converge on the same per-dialect dispatch and evidence contract.

### 11.2 Per-match return shape (from plurnk-grammar #17)

```ts
interface QueryMatch {
    readonly matched: unknown;
    readonly matching?: string;
    readonly regions?: ReadonlyArray<TextRegion>;
}
```

`matched` is the extractor's internal result value. It proves the predicate and
is available to consumers, but PLURNK's resource matcher does not substitute it
for the resource body.

`matching` is an optional canonical structural locator. `regions` contains
contiguous regions in the exact text the model can READ. Each `TextRegion` has
all four 1-based `startLine`, `startColumn`, `endLine`, and `endColumn`
coordinates; columns count Unicode code points and the end is exclusive.

Evidence is honest or absent:

- Regex and glob derive regions from offsets in the readable text. The region
  is exact when both offsets are addressable Unicode code-point boundaries. If
  a regex bisects an indivisible code point or CRLF separator, the smallest
  enclosing addressable region is reported instead.
- JSONPath and XPath preserve their canonical locator. A native source node may
  contribute its exact or nearest honest enclosing text region.
- A computed scalar, synthetic tree, or transformed projection whose parser
  coordinates do not address the readable text is locator-only and omits
  `regions`.
- A genuinely disjoint finding may report several regions. Separate findings
  remain separate `QueryMatch` values.

JSONPath and XPath apply the same evidence rule. Neither dialect fabricates
coordinates merely to satisfy a consumer. The conformance harness in §14
enforces this matrix.

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

`matching` is the resolved locator for multi-match dialects: jsonpath wildcards emit `$.users[0].name` etc.; xpath multi-match emits `(//user)[1]` etc.; regex and glob omit it.

### 11.3 Handler defaults

`BaseHandler.query` provides defaults:

- **regex / glob** — apply against `toText(content)`. Default `toText` returns string content as-is; for binary content it throws `UnsupportedDialectError`. Handlers with binary content (PDF) override `toText` to provide a text projection (e.g. extracted page text).
- **jsonpath** - apply against the **deep-json** channel (`handler.deepJson(content)`) per issue #10. Handlers whose mimetype has a native JSON-shaped representation (`application/json`, `application/yaml`, `application/toml`, `text/csv`) override `query` to dispatch jsonpath with handler-specific region resolution. When `deepJson()` is absent, the handler's symbol outline is its canonical structural projection.
- **xpath** — apply against the **deep-xml** channel (`handler.deepXml(content)`, default = `projectJsonToXml(await this.deepJson(content))`) per issue #10. Every handler that emits a structural tree automatically gets xpath dispatch — xpath-on-JSON, xpath-on-code, xpath-on-markdown all work via the projection. **Symbols-only handlers** (no `deepJson`) still answer xpath: when `deepJson()` is null, `deepXml` falls back to projecting the **same bare-number symbol outline** the jsonpath default uses (`buildJsonOutline(extractRaw)`), with an outline line-resolver so the projected elements carry the same real lines — so a handler that answers jsonpath answers xpath too, over the same entries, with the same spans (#41 symmetry). Handlers that want source-position accuracy (`text/html`, `application/xml`) override `query` to dispatch xpath against the real parsed DOM. `UnsupportedDialectError` is thrown only when there is **neither a deep tree nor any symbol** to project (`deepXml()` is empty).

This is the symmetric design promised in issue #10: jsonpath dispatches against deep-json on any entry; xpath dispatches against deep-xml on any entry. The cross cases (xpath-on-JSON, jsonpath-on-XML, both on code) all work.

### 11.4 Error policy

| Condition | Behavior |
|---|---|
| Detection returns null | `Mimetypes.query` throws `ReferenceError` |
| Content unreadable | `Mimetypes.query` throws `ReferenceError` |
| Resolved mimetype has no registered handler | `UnsupportedDialectError` -> consumer maps to 415 |
| Registered handler cannot be loaded | `Mimetypes.query` throws `ReferenceError` |
| Dialect unsupported for resolved mimetype | `UnsupportedDialectError` → consumer maps to 415 |
| Body-glob (grammar #17) | glob-on-body returns line matches; no 415 |
| Malformed expression | `InvalidExpressionError` → consumer maps to 400 |
| Content can't be parsed for the dialect | `QueryParseFailureError`; the standard scheme adapter returns a 203 raw-content fallback |
| Zero matches | returns `[]` → consumer maps to 204 |

### 11.5 Notices and failures

`Notice` is reserved for a successful operation's non-fatal degradation. When
the default (non-strict) path degrades, `process()` attaches one warning Notice
per degradation to `ProcessResult.notices[]`: `grammar_degraded` when
`grammarMissing` is set and `embedding_degraded` when `embeddingMissing` is
set. Each names the relevant `plurnkPackage`; the array is absent on the happy
path.

Hard failures are not Notices. `UnsupportedDialectError`,
`InvalidExpressionError`, and strict `GrammarNotInstalledError` remain typed
exceptions. `QueryParseFailureError` is also typed, but the standard scheme
adapter treats it as a successful 203 raw-content fallback rather than a
Problem. Each consumer owns that operation-boundary policy. This keeps one
authority for failure status, detail, and recovery.

Notice sources use `mimetype:<normalized-type>`, with invalid runs normalized to
`-`. `level` is required and producer-owned; these degradation Notices use
`warn`. Consumers may present or forward them, but cannot use them as durable
failure truth.

## 12. Channel architecture

Per plurnk-mimetypes#10 and #17, `ProcessResult` carries up to six channels, materialized per the caller's `channels` selection (§5): the four **structural** channels below, plus `content` (the readable projection — §18) and `embedding` (the vector — §17), which have their own sections.

### 12.1 The channels

| Channel | Field on `ProcessResult` | Purpose | Authored by |
|---|---|---|---|
| `symbols` | `symbols` (`MimeSymbol[]`) | Structured definitions — `symbol_defs` raw material for the graph (`@` dialect), chunk boundaries for semantic embedding, outline source (`format()`). | Handler via `extractRaw()`. |
| `deep-json` | `deepJson` (unknown) | Query target for the jsonpath body-matcher tool. Full structural tree, idiomatic per the entry's native algebra. | Handler via `deepJson()`. |
| `deep-xml` | `deepXml` (string) | Query target for the xpath body-matcher tool. Default: mechanical projection of `deep-json` via the framework's `projectJsonToXml()` — same conceptual tree, different syntax, drift-impossible by construction. When `deep-json` is null but the handler emits symbols, the projection target is instead the **bare-number symbol outline** (the same shape jsonpath falls back to), so symbols-only handlers stay xpath-queryable with real lines (#41). | Framework by default. Handlers whose algebra *is* XML (text-html, application-xml) may override `deepXml()` to serve real source markup; `process()` honors the override so the persisted channel and live `query()` xpath target always agree. |
| `references` | `references` (`MimeRef[]`) | Classified symbol uses — `symbol_refs` raw material for the graph. §16. | Handler via `references()`; tree-sitter handlers via the framework's query-file engine. |

Different masters, different fidelity. The deep channels serve query dispatch; symbols + references serve the service's graph and semantic machinery.

### 12.2 `deep-json` conventions

Native vocabulary per algebra — we lean on community conventions rather than inventing a normalized "code tree" schema. Each algebra's deep-json shape:

- **Tree-sitter-backed handlers** — full named-children walk of the AST, native tree-sitter node types (`function_definition`, `class_declaration`, etc.). Default walker provided by `TreeSitterExtractor.deepJson()`; per-language overrides only when a language needs custom shaping.
- **JSON / YAML / TOML / CSV** — the parsed value directly; deep-json IS the data tree.
- **HTML / XML / SVG** — the parsed DOM rendered as nested objects (DOM element name → node `type`; attributes and children preserved).
- **Markdown** — the markdown AST (heading, paragraph, link, code_block, etc.).
- **ANTLR / hand-rolled handlers** — handler authors as appropriate for the algebra.

Node-shape convention used by the tree-sitter walker (other handlers should follow analogously):

```ts
interface DeepTreeNode {
    type: string;          // native node type per algebra
    line: number;          // 1-indexed source line
    endLine: number;       // 1-indexed inclusive; endLine >= line always
    text?: string;         // present on leaves (no children); source slice
    children?: DeepTreeNode[];
}
```

`endLine >= line` is an invariant, never an inverted span. The ANTLR walker enforces it explicitly: an epsilon/empty-match rule context has its `stop` token set *before* its `start` (so `stop.line < start.line`), and the walker clamps `endLine` to `start.line` rather than emit `endLine < line`. The query line resolvers rely on this (`endLine` defaults to `line` whenever a stored `endLine` is missing or smaller).

### 12.3 `deep-xml` projection rule

The framework's `projectJsonToXml()` applies these rules (in priority order):

1. A JSON object whose `type` field is a non-empty string becomes an element named after that type. Otherwise, the element name comes from the parent key, falling back to `<root>` at the document root. **Every element name — whether from `type` or from a key — is sanitized to a valid XML Name** (first char `[A-Za-z_]`, rest `[A-Za-z0-9_.-]`; anything else → `_`, empty → `node`). Keys are arbitrary text (symbol names, outline labels), so this is load-bearing: a `"Given x"` outline key projects to `<Given_x>`, never the invalid `<Given x>`. Sanitization may make a name diverge from the jsonpath key for that node; the **line** stays identical across dialects regardless (the #41 contract is about lines, not name spelling).
2. Fields `line`, `endLine`, `column`, `endColumn`, `level` become XML **attributes** under the **reserved `pk:` namespace** (`xmlns:pk="https://plurnk.dev/deep-xml/1"`, declared on the root element only) when their value is a number or non-empty string. Per issue #12: namespacing is required because content's own attributes can carry the same names (e.g., HTML/XML source with `<foo line="5">`), and unprefixed bookkeeping would emit duplicate-attribute names → invalid XML. The `pk:` prefix makes framework bookkeeping always distinguishable from content attrs, keeps the document valid, and lets consumers strip the bookkeeping cleanly via `removeAttributeNS` or a regex on the prefix. **Optional `lineFor` resolver (#41):** `projectJsonToXml(json, rootName?, lineFor?)` takes an optional `ProjectLineFor = (pointer) => {line, endLine} | undefined`. For a node that carries no `line` of its own (raw parsed JSON/INI/CSV, or the symbol outline), the resolver supplies `pk:line`/`pk:endLine` by JSON pointer — so the xpath target gets the same real source lines jsonpath resolves through its own `lineFor`. A node's own `line` field always wins over the resolver.
3. A leaf's `text` field becomes the element's text content.
4. The optional `attrs` field on an object renders its entries as **content attributes in the default (no-prefix) namespace** — these are source-algebra attributes (HTML's `href`/`class`, XML's anything), and the model writes xpath against them naturally (`//a[@href]`, not `//a[@pk:href]`).
5. Other object fields become **child elements** named after their key. An array of primitives expands to repeated sibling elements (parent key supplies the element name). An array of objects expands to repeated sibling elements named per rule (1) — each object's `type` wins over the parent key.
6. `null` / `undefined` values are skipped.
7. Top-level arrays / primitives wrap in `<root>`.

Example: `{ type: "function_definition", line: 5, endLine: 10, name: "greet", params: ["x", "y"] }` →

```xml
<function_definition xmlns:pk="https://plurnk.dev/deep-xml/1" pk:line="5" pk:endLine="10">
  <name>greet</name>
  <params>x</params>
  <params>y</params>
</function_definition>
```

### 12.4 Materialization policy

Channels are built **per request** (§5): a requested channel is computed eagerly within the call; an unrequested channel costs nothing. The caller owns persistence and refresh policy — plurnk-service's body-matcher plugin re-projects per query (content can't go stale), while its graph/semantic pipeline materializes at manifest-add time and caches in sqlite.

The deep channels are **never model-visible**. They are consumed exclusively by the jsonpath and xpath body-matcher tool implementations.

## 13. Per-grammar package architecture

### 13.1 Runtime boundary

Each Tree-sitter grammar lives in a PLURNK package that ships only its pre-built WASM:

```
@plurnk/plurnk-mimetypes                          (framework: floor handlers + loaders)
@plurnk/plurnk-mimetypes-grammar-{slug}           (per-grammar, one each)
```

`TreeSitterLanguageHandler.loadParser()` resolves only `@plurnk/plurnk-mimetypes-grammar-{slug}/{slug}.wasm`. An absent leaf throws `GrammarNotInstalledError` with its package name.

Grammar leaves declare only `web-tree-sitter` as a peer. Upstream grammar packages are build inputs to those leaves, never dependencies of the framework.

### 13.2 Grammar leaf contract

A leaf contains `{slug}.wasm` at its package root. The framework owns mappings and registry metadata; the leaf owns its upstream pin and reproducible build.

### 13.3 Registry entry shape

```ts
interface TreeSitterLanguageEntry {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    readonly slug: string;                           // → @plurnk/.../grammar-{slug}/{slug}.wasm
    readonly importMapping: () => Promise<TreeSitterLanguageMapping>;
}
```

### 13.4 Install patterns

- **Floor:** `npm i @plurnk/plurnk-mimetypes` alone gives a working framework for the floor types (`text/plain`, `text/markdown`, `application/json`, `application/xml`, `text/html`, `text/csv`) — the floor handler packages and both parser loaders are direct dependencies (issue #14).
- **Slim:** add only the grammars you need (e.g. `npm i @plurnk/plurnk-mimetypes-grammar-python @plurnk/plurnk-mimetypes-grammar-rust`).
- **Kitchen sink:** the README carries a copy-paste `npm install` block listing every published grammar. (A `grammars-all` meta package was considered and rejected — a layer of indirection that does nothing.)
- **Degrade, not throw (issue #14):** `detect()` is install-state-blind — it returns the source mimetype regardless of whether the grammar package is installed. When `process()` then finds the grammar missing, it degrades to a text-plain fallback with `ok: true` and surfaces the missing package name on `ProcessResult.grammarMissing` so consumers can show an actionable install hint. `process(input, { strict: true })` opts into throwing `GrammarNotInstalledError` instead.

### 13.5 Reproducibility

Each leaf rebuilds from a pinned upstream commit and verifies that the committed WASM is byte-identical.

## 14. Query-evidence conformance

`@plurnk/plurnk-mimetypes/conformance` exports
`assertQueryEvidenceConformance(handler, cases)`. Every case declares its
expected verdict:

| Verdict | Required result |
|---|---|
| `exact` | one or more complete `TextRegion` values equal the declared exact coordinates |
| `enclosing` | one or more complete `TextRegion` values equal the declared nearest honest enclosing coordinates |
| `locator-only` | a nonempty canonical `matching` value and no fabricated region |
| `unsupported` | `UnsupportedDialectError` |

The expected verdict follows from the available mapping, not from the mimetype
name:

| Matcher result and readable representation | Verdict |
|---|---|
| Regex offset on readable text | `exact`, or `enclosing` when an offset bisects a Unicode code point or CRLF |
| Glob match on a readable line | `exact` |
| Structural node with complete coordinates in readable text | `exact` |
| Structural node with honest but coarser source coordinates | `enclosing` |
| Structural node over a synthetic or transformed representation with no source map | `locator-only` |
| Computed structural scalar | `locator-only` |
| Text matcher with no readable text projection | `unsupported` |
| Structural matcher with neither a deep channel nor symbols | `unsupported` |

Exact and enclosing cases must declare complete expected regions; a start line
alone is not positional proof. Locator-only cases fail if any coordinates
appear. Unsupported cases fail unless the handler rejects the dialect
explicitly. `defect` is not a passing verdict: an unclassified, missing, or
fabricated result remains a red test. Every supported dialect receives a case;
testing JSONPath does not prove XPath, and a text-backed regex does not prove a
transformed structural projection. Shared tree-sitter behavior is gated through
the framework handler across representative grammars. Binary-derived handlers
assert either exact coordinates in their readable projection or an honest
locator-only verdict. The harness validates every reported region through the
shared `TextRegion` contract before comparing it with the declared verdict.

## 15. Public API stability

All exports from `@plurnk/plurnk-mimetypes/index` are the stable API surface under semver; a breaking change to them is a platform MAJOR (announced, rare). Internal modules (those not re-exported from `index.ts`) are not part of the stable API and may change freely.

## 16. References channel (issues #16/#19)

The references channel carries **classified symbol uses** — never definitions (those are the symbols channel's job). It is the raw material for plurnk-service's content-addressed `symbol_refs` graph artifacts; linking, traversal, and cross-entry identity are entirely service-side SQL.

```ts
type RefKind = "import" | "call" | "instantiate" | "inherit" | "type" | "use";

interface MimeRef {
    name: string;
    kind: RefKind;
    line: number;        // 1-indexed
    column: number;      // 1-indexed
    endLine: number;
    endColumn: number;
    container?: string;  // enclosing definition's qualified path — the edge's source node
}
```

**The `RefKind` taxonomy is FROZEN** (2026-06-10, against plurnk-service's `symbol_defs`/`symbol_refs` schema and the worked `@<` / `@>` / `@` queries — plurnk-service#186): `import | call | instantiate | inherit | type | use`. Traversal is kind-agnostic (every ref is an edge); `kind` rides as edge metadata and the seam for future kind-filtered dialect forms.

**`ref.container` is the enclosing definition's FULL qualified path** — a call inside method `parse` of class `Parser` carries `container: "Parser.parse"`, exactly equal to the source def's composed `container + "." + name`. That equality is the join key for `@>` (edge source → def) — emitting only the immediate class would break it. Module-top-level references omit the key.

**Extraction mechanism (issue #19).** Tree-sitter-backed languages declare per-language queries in `src/treesitter/queries/{slug}.ts` — the `.scm` S-expression source embedded as an exported string (reviewable query content without a build-time copy step), re-exported as `refsQuery` from the mapping module. One framework engine (`refsEngine.ts`) executes them via web-tree-sitter's Query API and resolves each ref's `container` against the symbols channel by line containment (innermost emitted def; equal spans go to the later emission, i.e. the deeper scope). ANTLR and hand-rolled handlers implement `references()` visitor-side (`withExtractor.addRef` + `gateContainer`, or a direct `MimeRef[]` scan); `withExtractor.refs` returns document order to match the engine. Default everywhere: `[]`.

Coverage: every code language in the registry ships a conformance-gated query (23 in-registry suites), and the standalone handler packages (the DSLs — terraform/dockerfile/protobuf/graphql/cmake/SQL — plus the standalone languages — swift/r/nix/perl/erlang/prolog/datalog/clojure/common-lisp/sparql/csharp/vim) emits conformance-gated references too. Data formats (YAML, TOML, CSS, JSON, CSV, INI, dotenv, …) and Redis are refs-free by design — references are a code-graph concept. Languages whose syntax can't honestly support a kind omit it rather than guess (Haskell emits no `instantiate` — constructor application is syntactically identical to pattern deconstruction; Lua emits `call` only).

Query conventions:
- `import` refs capture **bound symbol names** (name-join-resolvable), never module-path strings; aliased imports capture the original exported name. Languages whose imports are paths only (Go) emit no import refs.
- `call` refs capture the callee **name node** (property/attribute name for member calls), not the expression root.
- Languages where instantiation is syntactically a call (Python) classify it as `call`.
- `use` is reserved: bare identifier reads are not emitted — precision over recall.

**Invariants (conformance-enforced per language, issue #20):**
- All positions 1-indexed; `endLine >= line`; columns always present.
- Every `container` names an enclosing definition emitted by the same entry's symbols channel.
- No ref whose position falls inside a string literal or comment.
- No definitions — every row is a use.
- Deterministic document order.

A language participates in the service's graph only when its conformance suite is green.

**Third-party conformance harness (issue #32).** The invariants above are not framework-internal — a third-party handler whose `references()` emits rows certifies it against the **same** harness the in-registry languages run, exposed at the `@plurnk/plurnk-mimetypes/conformance` subpath (kept off the main entry so `node:assert` stays out of the runtime bundle). There is one invariant implementation; the registry suites and an external author both call it.

```ts
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { it } from "node:test";

it("acme-mime-foo refs are conformant", async () => {
    await assertHandlerConformance(new AcmeFooHandler(metadata), {
        source: REAL_WORLD_FIXTURE,          // not a synthetic snippet
        decoyNames: ["secret", "TODO note"], // strings/comments that must NOT surface as refs
        expectJoins: [{ refName: "Helper", container: "Foo.run" }], // ≥1 join that resolves to a local def
        expectRefs: [{ name: "Helper", kind: "instantiate" }],
    });
});
```

`assertHandlerConformance(handler, fixture)` drives a minimal duck surface (`extractRaw` + `references`), so it works for any tier — tree-sitter, ANTLR, or hand-rolled — and throws an `AssertionError` on the first violation. **Checklist a refs-emitting handler must satisfy:** (1) at least one ref; (2) every position 1-indexed with `endColumn` present and `endLine >= line`; (3) every `container` equals an emitted def path; (4) no ref at a def's own name position; (5) deterministic document order; (6) no `decoyNames` (string/comment content) surfacing; (7) every `expectJoins` entry resolves (ref name is a local def AND container is its path); (8) every `expectRefs` spot-check present. **Refs-free handlers** (data formats, symbols-only hand-rolls) do not run this — an empty references channel is honest, not a failure.

**Tier 2 authoring (out-of-registry tree-sitter handlers, issue #26).** A handler package that brings its own WASM grammar implements `references()` through the same engine via two `TreeSitterExtractor` affordances, so it never reimplements the priming dance:
- `loadParser()` calls `this.setQueryContext(language, QueryCtor)` after `Language.load()` — it owns the WASM path, so it is the only place holding the `Language` and the web-tree-sitter `Query` constructor.
- `references()` is one call to `this.collectRefs(content, querySource, extractDefs, wrap?)`, which owns parse → compile-and-cache query → run `collectReferences` against `extractDefs`'s symbols → cleanup, plus the shared error policy (`GrammarNotInstalledError` propagates for the #14 degrade; parse/query failures → empty channel). The in-registry `TreeSitterLanguageHandler` uses the identical helper — one priming implementation.
- A language needing **match-level composition** the engine's flat `captures()` can't express (HCL names defs `TYPE.NAME`) passes `wrap` to adapt the raw compiled query, and composes the qualified name into a `RefsCaptureNode` (`{text, startPosition, endPosition}` — the exact, blessed surface the engine reads off a capture, so no cast through `TreeSitterNode`).

## 17. Embedding channel (issue #24)

The `embedding` channel supplies vectors for plurnk-service's `~semantic` dialect: **native-endian raw Float32 bytes** (`Uint8Array`, length = 4 × dimension). The service stores those bytes verbatim in content-addressed derivation artifacts and cosine-ranks over a `Float32Array` view — no JSON round-trip. The same channel embeds arbitrary text: derived body chunks and a `~query`'s query text ride the identical path.

- **Opt-in only.** `"embedding"` is never in the default channel set — it is a model inference, orders of magnitude costlier than parsing. Request it explicitly: `process(input, { channels: ["embedding"] })`.
- **The embedder is an opt-in artifact package**: `@plurnk/plurnk-mimetypes-embeddings` (per-grammar-package precedent — the framework ships no model weights). It exports `embed(text): Promise<Uint8Array>` and `dimension: number`. Model: MiniLM-class `all-MiniLM-L6-v2`, **dimension 384** (1536 bytes), quantized ONNX bundled in the package (hermetic; pinned revision; fetch + verify scripts). Vectors are mean-pooled and L2-normalized.
- **What gets embedded**: string content verbatim; binary content via the handler's `toText()` projection (PDF page text). No projection / empty text → empty bytes (length 0), no hint — the honest channel.
- **Missing package degrades per #14**: requested embedding with the package absent → `embedding: new Uint8Array(0)` + `embeddingMissing` install hint, `ok` stays true; `strict: true` throws.
- **Grammar-degrade still embeds**: a grammar-missing entry is still semantically searchable text; `grammarMissing` and a real vector coexist.
- The dimension is **fixed per deployment** — changing the model/dimension invalidates the service's stored vectors; that is a consumer-side migration, not a framework concern. The embedder declares its identity (`model`, e.g. `"Xenova/all-MiniLM-L6-v2@751bff37+q8"`), surfaced as `ProcessResult.embeddingModel` — store it alongside each BLOB; it is the staleness detector that makes the migration detectable. The identity encodes **both** the model revision and the quantization, since either changes the vectors; the embedder derives it from its pin, never a hand-synced literal.
- **Lossless chunking facts** (`embedderInfo()`): an embedder may export its input `contextWindow`, an untruncated `countTokens(text): Promise<number>` using the model's own tokenizer, and its `model` identity. The framework surfaces `{ dimension, contextWindow: number | null, countTokens: fn | null, model? }`; `null` from `embedderInfo()` means no embedder resolves, while null fields mean a present embedder does not know those optional facts. Remote deployments declare the input window with `PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW`. The host uses these facts to tile text into chunks whose token counts do not exceed the input window and folds the model identity into derivation state. The framework owns no chunking logic.

- **Bulk embedding** (`embedBatch()`, plurnk-service#272): `mimetypes.embedBatch(texts, { onProgress?, signal? }): Promise<Uint8Array[]>` — one vector per input text, **input order**, bit-identical to embedding each text through the channel (so nothing already stored re-embeds). The single framework seam for corpus ingest: resolution + model identity stay framework-owned (pair with `embedderInfo()` for chunk budgeting), so the host never reaches into the embeddings package directly. Delegates to the embedder's data-parallel `embedBatch` (a work-stealing worker pool, `PLURNK_MIMETYPES_EMBED_WORKERS`-tunable — benched ~7× across cores on a saturating batch); falls back to a sequential `embed()` loop for an embedder without the pool, still firing `onProgress({ completed, total })` and honoring `signal`. Throughput scales with batch size: a one-text batch uses one worker, so consumers saturate the pool by batching across entries, not per-entry (#420). Unlike the per-entry channel (which degrades to empty bytes when the package is absent), this is an explicit bulk call — a missing embedder **throws** rather than silently storing empties.

## 18. Content channel

The `content` channel is a consumer-ready readable projection - the markup-free text a host may materialize for model-facing information and the per-handler **embed-source** (the embedding channel embeds `content` over the raw bytes). `ProcessResult.content?: string`. Addressable hosts decide whether to store that projection or preserve source bytes; the handler does not silently redefine their coordinate space.

**Present iff the readable form differs from the raw body.** Sort every mimetype by one question — *is the readable text the same as the bytes?*

- **Directly-readable formats** (code, markdown, JSON, plain text): `content` is **absent**. The raw body already is the readable text; the model reads the bytes directly; a `content` channel would just duplicate the body.
- **Binary with a readable projection** (PDF, ...): `content` is the handler's extracted text. The same projection serves regex/glob matching, so any reported text region addresses exactly what the model can read.
- **text/html**: `content` = **Readability + turndown markdown** - main-content extraction (strips nav/ads/chrome) into clean markdown. Projected prose is wrapped at `PLURNK_MIMETYPES_HTML_WRAP_COLUMNS` (default `100`; `0` disables) so line scopes bound ordinary reading work instead of inheriting a page's arbitrary source density. Wrapping breaks only at whitespace and preserves Markdown structures: fenced/indented code, headings, tables, inline code, links, and retained raw tags are never split merely to satisfy the column target. The source HTML and structural channels remain untouched. HTML is the only case transforming an already-textual-but-noisy body into a cleaner read. (Email/EPUB are HTML-shaped and would reuse the pattern when they land - built then, not speculatively.)

**Always-on and source-agnostic.** `content` is in the default processing channel set (it's cheap - pure JS, no model). text/html computes it from whatever HTML bytes arrive: a local file can be projected to document markdown; bytes a browser scheme rendered and serialized can become a live page's readable content. The handler is a pure function of bytes and cannot tell which (see the HTML rendering split - rendering is the http scheme's job; `content` projects whatever it is handed).

**Relationship to `toText`.** A handler that overrides `content` routes `toText` (the regex/glob query surface) through the same projection, so there is one readable-text implementation per handler. The framework's embed-source resolves as `content() ?? toText()`: projected readable text, then the passthrough body.

## 19. Tokenizer seam (issue #44)

Exact LLM token counting for the host's window math, on the embeddings pattern (§17). The framework runs the universal engine question; per-model vocabularies are pure data in ONE opt-in artifact package — `@plurnk/plurnk-mimetypes-tokenizers` — under the pin/sha256/fetch-verify discipline. Kept separate from the embeddings package so a deployment wanting window math never carries MiniLM ONNX weights.

### 19.1 Surface

`mimetypes.tokenizer(modelRef, { strict? }): Promise<TokenizerResolution>`

```ts
interface TokenizerResolution {
    countTokens(text: string): Promise<number>;
    tokenizerId: string;   // vocab identity, NOT model id
    exact: boolean;
    notices?: readonly Notice[];  // present iff degraded
}
```

**Resolution chain (#44).** The full chain is host-composed: (1) the provider's own `tokenize()` capability when the backend serves one (providers 0.26.0; the model's OWN vocab, zero bundled data) — outside this seam; (2) a bundled `tokenizer.json` matched by model ref → `exact: true`, the artifact's counter; (3) the **chars/2 upper bound** → `exact: false`, `tokenizerId: "heuristic:chars2"`, one `tokenizer_unavailable` warn event (source `tokenizer`) naming the model — plus `plurnkPackage` when the artifact package itself is absent. `strict: true` throws at (3) instead. **Never a silent estimate**: a degraded resolution is visibly degraded on the shape.

chars/2 is the SAFE direction: measured agentic text runs 2.9–3.2 chars/token (#44), so /2 over-reserves; the old /4 under-counted 20–27% and blew window math silently.

### 19.2 `tokenizerId` is the vocab, not the model

For exact resolutions the id derives from the `tokenizer.json` bytes (sha256 prefix). Two model refs sharing a vocabulary (deepseek pro↔flash) share the id, so a model swap that keeps the vocab never invalidates counts derived and stored against it. The host keys derivations on `(content_hash, tokenizer_id)`.

### 19.3 Artifact duck contract

The tokenizers package default-exports (or exports) `resolve(modelRef) → Promise<{ countTokens, tokenizerId } | null>` — null meaning "no bundled tokenizer matches this ref" (a data gap, not an error; the seam degrades). Optional `dispose()` releases engine state, forwarded from `Mimetypes.dispose()`. Loader errors follow the §17 rule: `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND` → absent; anything else → a misconfigured-but-present artifact and rethrows.

## 20. Classification authority (issue #43)

This family is the single source of **binary-vs-text** truth, so consumers retire hand-maintained allowlists (the `application/jsonl` -> 415 drift, schemes#28, is the motivating bug). Navigation is not a mimetype property: every readable projection uses the universal text-region algebra, while jsonpath and xpath are matcher locators.

### 20.1 Surface

```ts
interface MimeClassification {
    binary: boolean;
    source: "handler" | "heuristic";        // which layer decided
}
classifyMimetype(mimetype): MimeClassification            // pure taxonomy heuristic, sync
mimetypes.classify(mimetype): Promise<MimeClassification> // registry-aware
```

### 20.2 Two layers

- **Taxonomy heuristic** (`classifyMimetype`, exported): answers for any mimetype string so consumers can classify stream labels with no installed handler. Rules: `text/*` -> text; a known text-application set (json/yaml/toml/xml/javascript/ecmascript/typescript/sql/jsonl/x-ndjson) -> text; RFC 6839 suffixes `+json/+xml/+yaml/+toml` -> text; everything else is binary; a slash-less value is binary; `""` is not binary.
- **Registry refinement** (`Mimetypes.classify`): an installed handler's declared `plurnk.binary` value is authoritative. `source: "handler"` marks registry-decided answers.

## 21. Embedding-eligibility suppression (issue #47)

Machine-generated project content (minified bundles, lockfiles, sourcemaps) is honest bytes but semantic-derivation waste — a minified vuepress bundle chunked to 2,162 embeddings wall-clocked a CPU run (service#337). The eligibility decision for the **file scheme** is **operator configuration, not code**: `PLURNK_MIMETYPES_SEARCH_EXCLUDE` is a comma-separated pattern list — an entry without `/` matches the **basename**, an entry with `/` matches the **full path** (directory drawers like `*/dist/*`; hashed bundle names defeat basename rules — the run18 offender was `dist/assets/js/12.5188bb.js`). URI paths in other schemes are resource identities rather than repository layout and do not consume this file policy: `https://host/dist/index.json` remains searchable. glob syntax is the body-matcher dialect's engine (§11.3 `globToRegex` — `*` crosses `/`, `?`, `[...]`; one glob engine per family, never a second variant); no wildcard = exact; first match wins. The sane default ships in this package's `.env.defaults` (the shipped operator floor, #52). The knob IS the file classification — tunable per deployment, extensible without a release, and the matched pattern is the observable reason.

- `ProcessResult.searchExcluded?: string` — the matched pattern, present iff matched (also on the grammar-degraded path); consumers keep the entry directly readable but exclude it from graph, lexical, and vector search.
- `matchSearchExclusion(path)` — the exported matcher, read at call time from the host env like the pdf caps. Unset/empty → nothing suppressed; **no code fallback carries a hidden default**.
- Name-based suppression remains this framework's reader-declared mechanism. A host may additionally impose an explicit, observable vector-workload size ceiling; that is host policy, not a mimetype content classification.
