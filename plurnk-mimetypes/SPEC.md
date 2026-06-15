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
    // Navigation bound (§12.5) — line count for text, item count for structured.
    extent(content: HandlerContent): number | Promise<number>;
    // Body-matcher dispatch (§11). Default implementation on BaseHandler.
    query(content: HandlerContent, dialect: QueryDialect, pattern: string, flags?: string): Promise<QueryMatch[]>;
    // Rendered outline — format(extractRaw). Diagnostic / human surface.
    symbolsRaw(content: HandlerContent): Promise<string>;
}
```

**Authority split (v0.15.0).** The handler is the sole authority on each channel's material; the framework owns channel selection (§5), routing, the default deep-xml projection, and the references query-file engine (§16). There is no token budget anywhere in the framework — budgeting, rendering, and tokenization are consumer concerns. (The pre-0.15 preview/fitting layer was removed when its only consumer, plurnk-service's index, was torn down.)

**Content shape.** Text mimetypes receive `string` (utf-8 decoded). Binary mimetypes (PDF, images, archives) receive `Uint8Array`. Handlers signal which they expect via `plurnk.binary: true` at the top of the package's `plurnk` block — applies to all handler entries in the package. The framework reads files (or routes inline content) to the appropriate shape per handler.

**Outline rendering.** `symbolsRaw` (= `format(await extractRaw(content))`) renders the structured symbols as an indented outline for humans and diagnostics. It is not budgeted and not part of the consumer pipeline — `Mimetypes.process` returns the structured `MimeSymbol[]` directly.

In practice handlers extend `BaseHandler` (or `TreeSitterExtractor` / `AntlrExtractor`) and override the channels their algebra supports:

- **Structured handlers** (JSON, YAML, TOML, CSV, source code) implement `extractRaw` and `deepJson`.
- **Markup handlers** (HTML, XML) additionally override `deepXml` and/or `query` to serve real source markup for xpath.
- **Flat handlers** (`text/plain`, `text/stream`) override nothing — empty symbols and null deepJson are the honest channels for unstructured content; such entries contribute metadata (`totalLines`, `extent`) only.
- **Binary handlers** (PDF) override `extent` with a meaningful unit and `toText` for regex/glob query support.

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

### Container (issue #18, framework v0.15)

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

## 5. Channel selection (framework v0.15.0, issue #17)

`Mimetypes.process(input, { channels? })` materializes exactly the requested structural channels:

```ts
type Channel = "symbols" | "deepJson" | "deepXml" | "references";
```

- **Default: all four.** `process()` remains the universal projection surface (#11); callers that want less say less.
- **Unrequested channels are not computed and their fields are absent** from `ProcessResult`. A channel an entry legitimately lacks (flat text has no deep tree) comes back *present but empty* (`[]` / `null` / `""`) — absence means "not asked," emptiness means "asked, nothing there."
- **`channels: []` is valid** — metadata only (`mimetype`, `ok`, `totalLines`, `extent`), no parse paid. This is the cheap stat call (plurnk-service's manifest uses it for line counts).
- The default deep-xml projection consumes the deep-json value; when `deepXml` alone is requested the framework computes deep-json internally without exposing it.

Known consumer selections (plurnk-service): manifest → `[]`; body-matcher daughter → `["deepJson", "deepXml"]`; graph/semantic add-time pipeline → `["symbols", "references"]`.

There is no token budget, no tokenizer, and no rendered preview anywhere in the pipeline. The pre-0.15 fitting layer (`fitPreview`/`fitSymbols`/`fitContent`, `TokenizeFn`, truncation markers, head/tail orientation) was removed with its only consumer, plurnk-service's index. Rendering structured symbols for humans is `format()` (§4), unbudgeted.

## 6. `validate`

Default: no-op. Override only for mimetypes with a real syntax check that can fail (e.g., `application/json` throws on malformed JSON).

When `validate` throws inside `Mimetypes.process`, the error propagates to the caller per the error policy (§7).

## 7. Error policy

`ProcessResult` (v0.15.0):

```ts
interface ProcessResult {
    // always-on metadata
    mimetype: string | null;
    ok: boolean;
    totalLines: number;
    extent: number;            // §12.5
    grammarMissing?: string;   // §13.5
    // channels — present iff requested (§5)
    symbols?: MimeSymbol[];    // structured definitions; render via format() if needed
    deepJson?: unknown;
    deepXml?: string;
    references?: MimeRef[];    // §16
}
```

`totalLines` is the editor-convention line count of the source content. Conventions:

- `wc -l`-style — `abc\ndef` → `2`, `abc\ndef\n` → `2` (trailing newline is line terminator, not new line), `"\n"` → `1`, `""` → `0`.
- **Binary content** (mimetypes flagged `binary: true` in their `plurnk` block — PDF, future images/archives): `totalLines: 0`. Lines aren't a meaningful unit for binary mimetypes; service reasons about size differently (e.g., pages for PDF). `0` is the explicit "not line-oriented" signal.
- `0` on every error path (detection null, content unreadable, handler missing).

| Failure | Behavior |
|---|---|
| Detection returns null | `{ mimetype: null, ok: false, totalLines: 0, extent: 0 }` — no channel fields |
| Content read fails (path missing/unreadable) | `{ mimetype, ok: false, totalLines: 0, extent: 0 }` — no channel fields |
| Handler package not loadable | `{ mimetype, ok: false, totalLines: 0, extent: 0 }` — no channel fields |
| Grammar package not installed (#14) | Degrades: `ok: true`, real `totalLines`/`extent`, requested channels present but empty, `grammarMissing` set to the package name. `{ strict: true }` throws `GrammarNotInstalledError` instead. |
| `validate()` throws | **Propagates** to the caller — contract violation |
| Channel method throws inside handler | Contained per handler discipline (`AntlrExtractor`/`TreeSitterExtractor` catch parse failures inside `extractRaw`/`deepJson` and return empty/null). Framework does not catch. |

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

Handler authors choose a parser backend in this strict order. **The hierarchy is mechanical — if a higher-tier option exists and meets the quality bar, use it.**

1. **Tier 1 — clean WASM in framework registry.** Languages whose upstream `tree-sitter-{lang}` package on npm ships a pre-built `.wasm` at the package root. These live in `TREE_SITTER_REGISTRY` inside `@plurnk/plurnk-mimetypes` itself (`src/treesitter/{lang}.ts`). Zero per-language package needed. Mechanical qualifying check: after `npm install tree-sitter-{lang}`, `find node_modules/tree-sitter-{lang} -name "*.wasm"` returns the file at package root.
2. **Tier 2 — dirty WASM in `@plurnk/plurnk-mimetypes-{lang}` package.** Languages where a complete, faithful tree-sitter grammar exists upstream but the npm distribution does not ship `.wasm`. The handler package owns a reproducible build step (pinned source-grammar commit + `tree-sitter build --wasm` in CI via emscripten) and commits the resulting `.wasm` into its own source tree. Consumer-side install remains pure WASM, no toolchain. Quality bar matches Tier 1: we only promote a language to Tier 2 when the upstream grammar is itself faithful — building a half-grammar to WASM does not earn registry inclusion.
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

### 9.2 Existing handlers

ANTLR-backed handlers shipped at 0.1.x stay on ANTLR. The hierarchy applies forward — new handlers default to tree-sitter unless they fall through. Existing handlers may migrate to tree-sitter only when a specific limitation justifies the work (e.g., known grammar bugs in graphql/zig/scala2/php where the tree-sitter version handles the case correctly). Wholesale rewrites are out of scope.

### 9.3 ANTLR extractor

For ANTLR-backed handlers (existing pattern, still supported):

1. Vendor `.g4` files in `grammar/` at the handler repo root.
2. Add the compiler to your own devDependencies (the `antlr4ng` runtime ships with the framework as a direct dependency since v0.14.0; the `antlr-ng` compiler is the framework's only optional peer):
   ```
   npm install --save-dev antlr-ng@^1.0.10
   ```
3. Run `npx plurnk-mimetypes-compile` — invokes `antlr-ng -D language=TypeScript -o src/generated --generate-visitor true --generate-listener false grammar/*.g4` and post-processes the output to rewrite `.js` import extensions to `.ts` (so Node's native TS strip works without a separate build pass). Invoke via `npx` so node_modules/.bin/ is on PATH when the spawn happens.
4. Extend `AntlrExtractor` instead of `BaseHandler`.
5. Implement `parseTree(content)` (return a parser rule context) and `createVisitor()` (return an `ExtractionVisitor`).
6. Build the visitor by extending `withExtractor(GeneratedVisitor)` — the mixin adds `symbols`, `inBody`, `addSymbol(kind, name, ctx, params?, extra?)`, and `gateBody(ctx)` to the antlr4ng visitor.

Parse failures and visit-time exceptions are caught by `AntlrExtractor.extractRaw()` and converted to an empty `MimeSymbol[]` — the symbols channel comes back empty rather than erroring; there is no substitution to text content.

### 9.4 Async `extractRaw` contract (framework v0.8.0)

`BaseHandler.extractRaw(content)` returns `MimeSymbol[] | Promise<MimeSymbol[]>`. Existing synchronous handlers (all AntlrExtractor- and hand-roll-based handlers shipped at v0.1.x–v0.2.x) continue to return `MimeSymbol[]` directly — that's assignable to the union and no handler-side change is needed. New tree-sitter-based handlers return `Promise<MimeSymbol[]>` to honor WASM grammar init.

**Consumer-side breaking change:** all consumers of `extractRaw` (including `Mimetypes.process`, `symbolsRaw`, query routes) must `await` the result. The framework's internal call sites are updated in v0.8.0; external consumers of the diagnostic `extractRaw` / `symbolsRaw` surfaces need their call sites updated when they move to ≥0.8.0.

### 9.5 Tree-sitter extractor (framework v0.8.0)

For tree-sitter-backed handlers:

1. The `web-tree-sitter` runtime ships with the framework as a direct dependency (since v0.14.0); no handler-side install needed.
2. Own the language's WASM: a pre-built `.wasm` committed in the handler package from a pinned upstream commit (Tier 2 pattern, §13.6-style reproducible build).
3. Extend `TreeSitterExtractor` instead of `BaseHandler`.
4. Implement `loadParser()` (async; init web-tree-sitter, load the language WASM, return a ready parser) and `extractFromTree(tree, content)` (return `MimeSymbol[]` from the parsed tree). The base class handles parser lifecycle and async coordination via a primed-promise cache.

Parse failures are caught by `TreeSitterExtractor.extractRaw()` and converted to an empty `MimeSymbol[]`, mirroring AntlrExtractor's error policy.

### 9.6 Hand-rolled extractor

For the rare format where neither tree-sitter nor grammars-v4 has coverage and the syntax is simple enough to scan directly: extend `BaseHandler` and implement `extractRaw(content)` returning `MimeSymbol[]` (or `Promise<MimeSymbol[]>` if the scanner needs async I/O, which it shouldn't). The handler README must justify why neither §9.5 nor §9.3 was viable — the bar is intentionally high to keep the family converged on community-maintained grammars.

## 10. Tokenization (removed in v0.15.0)

The framework neither tokenizes nor budgets. The pre-0.15 tokenize-injection architecture served the preview fitting layer (§5, also removed); both died with their only consumer, plurnk-service's index. Token counting is wholly a consumer concern — the service tokenizes content with its live provider at render time and never trusts write-time counts.

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
- **jsonpath** — apply against the **deep-json** channel (`handler.deepJson(content)`) per issue #10. Handlers whose mimetype has a native JSON-shaped representation (`application/json`, `application/yaml`, `application/toml`, `text/csv`) override `query` to dispatch jsonpath with handler-specific line resolution (jsonc-parser tree, yaml Document positions, etc.). The legacy bare-leaves outline path remains as a fallback when `deepJson()` returns null.
- **xpath** — apply against the **deep-xml** channel (`handler.deepXml(content)`, default = `projectJsonToXml(await this.deepJson(content))`) per issue #10. Every handler that emits a structural tree automatically gets xpath dispatch — xpath-on-JSON, xpath-on-code, xpath-on-markdown all work via the projection. Handlers that want source-position accuracy (`text/html`, `application/xml`) override `query` to dispatch xpath against the real parsed DOM. When `deepXml()` is empty (handler has no structural tree at all), `UnsupportedDialectError` is thrown.

This is the symmetric design promised in issue #10: jsonpath dispatches against deep-json on any entry; xpath dispatches against deep-xml on any entry. The cross cases (xpath-on-JSON, jsonpath-on-XML, both on code) all work.

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

## 12. Channel architecture (v0.9.0; channels selectable since v0.15.0)

Per plurnk-mimetypes#10 and #17, `ProcessResult` carries up to four channels of structural information about the entry, materialized per the caller's `channels` selection (§5).

### 12.1 The channels

| Channel | Field on `ProcessResult` | Purpose | Authored by |
|---|---|---|---|
| `symbols` | `symbols` (`MimeSymbol[]`) | Structured definitions — `symbol_defs` raw material for the graph (`@` dialect), chunk boundaries for semantic embedding, outline source (`format()`). | Handler via `extractRaw()`. |
| `deep-json` | `deepJson` (unknown) | Query target for the jsonpath body-matcher tool. Full structural tree, idiomatic per the entry's native algebra. | Handler via `deepJson()`. |
| `deep-xml` | `deepXml` (string) | Query target for the xpath body-matcher tool. Default: mechanical projection of `deep-json` via the framework's `projectJsonToXml()` — same conceptual tree, different syntax, drift-impossible by construction. | Framework by default. Handlers whose algebra *is* XML (text-html, application-xml) may override `deepXml()` to serve real source markup; `process()` honors the override so the persisted channel and live `query()` xpath target always agree. |
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
    endLine: number;       // 1-indexed inclusive
    text?: string;         // present on leaves (no children); source slice
    children?: DeepTreeNode[];
}
```

### 12.3 `deep-xml` projection rule

The framework's `projectJsonToXml()` applies these rules (in priority order):

1. A JSON object whose `type` field is a non-empty string becomes an element named after that type. Otherwise, the element name comes from the parent key, falling back to `<root>` at the document root.
2. Fields `line`, `endLine`, `column`, `endColumn`, `level` become XML **attributes** under the **reserved `pk:` namespace** (`xmlns:pk="https://plurnk.dev/deep-xml/1"`, declared on the root element only) when their value is a number or non-empty string. Per issue #12: namespacing is required because content's own attributes can carry the same names (e.g., HTML/XML source with `<foo line="5">`), and unprefixed bookkeeping would emit duplicate-attribute names → invalid XML. The `pk:` prefix makes framework bookkeeping always distinguishable from content attrs, keeps the document valid, and lets consumers strip the bookkeeping cleanly via `removeAttributeNS` or a regex on the prefix.
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

Channels are built **per request** (§5): a requested channel is computed eagerly within the call; an unrequested channel costs nothing. The caller owns persistence and refresh policy — plurnk-service's body-matcher daughter re-projects per query (content can't go stale), while its graph/semantic pipeline materializes at manifest-add time and caches in sqlite.

The deep channels are **never model-visible**. They are consumed exclusively by the jsonpath and xpath body-matcher tool implementations.

### 12.5 Addressable extent (`extent` on `ProcessResult`)

Per plurnk-mimetypes#9. The full content's addressable extent in the unit `<L>` addresses for that content — line count for text, item count for structured. Exposed on `ProcessResult` so consumers can hand the model navigation bounds (`READ<100,150>` needs to know whether 150 is in range). Defaults: `extent = totalLines` for text content, `0` for binary; handlers with non-line units (structured archives, paginated documents) override `BaseHandler.extent()`.

## 13. Per-grammar package architecture (framework v0.11.0)

### 13.1 The split

Tree-sitter grammars (Tier 1 in §9.1) are no longer pulled from upstream `tree-sitter-{lang}` packages. Each grammar lives in its own plurnk package shipping only the pre-built WASM:

```
@plurnk/plurnk-mimetypes                          (framework: floor handlers + loaders)
@plurnk/plurnk-mimetypes-grammar-{slug}           (per-grammar, one each)
```

The framework's `TreeSitterLanguageHandler.loadParser()` resolves WASMs by trying `@plurnk/plurnk-mimetypes-grammar-{slug}/{slug}.wasm` first, falling back to the legacy upstream `{wasmPackage}/{wasmFile}` for compatibility with consumers mid-transition. Neither resolved → throws `GrammarNotInstalledError` (exported from `index.ts`) with the plurnk package name as the install hint.

### 13.2 Why

The previous architecture depended on upstream `tree-sitter-{lang}` packages, each of which declared `peerOptional tree-sitter@^X.Y` for the native node-gyp binding. Two consequences:

1. **Peer-dep conflicts** when multiple grammars with mismatched peer ranges were installed together (forced `--legacy-peer-deps` everywhere).
2. **Implicit invitation to install native tree-sitter**, dragging node-gyp + Python + a C compiler into the build chain — breaks Alpine, Lambda, Cloudflare Workers, the original portability premise.

Our grammar packages declare only `web-tree-sitter` as a peer. No conflicts. No node-gyp. Ever.

### 13.3 What each grammar package contains

Just data:

```
@plurnk/plurnk-mimetypes-grammar-{slug}/
├── package.json              # peerDeps: { web-tree-sitter, @plurnk/plurnk-mimetypes }
├── index.js                  # exports wasmPath (absolute path to the WASM)
├── {slug}.wasm               # pre-built from a pinned upstream commit
├── .grammar-pin              # the commit SHA
└── scripts/
    ├── build-wasm.mjs        # reproducible rebuild from pinned source
    └── verify-wasm.mjs       # CI byte-identical check
```

No handler code, no mapping. The framework's `TREE_SITTER_REGISTRY` owns those. The grammar package is interchangeable plumbing.

### 13.4 Registry entry shape

```ts
interface TreeSitterLanguageEntry {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    readonly slug: string;                           // → @plurnk/.../grammar-{slug}/{slug}.wasm
    readonly wasmPackage: string | null;             // legacy upstream fallback
    readonly wasmFile: string | null;                // legacy upstream fallback path
    readonly importMapping: () => Promise<TreeSitterLanguageMapping>;
}
```

The legacy `wasmPackage`/`wasmFile` fields are deprecated but kept populated for the transition. New languages can set both to null — the framework will resolve exclusively via the plurnk grammar package.

### 13.5 Install patterns

- **Floor:** `npm i @plurnk/plurnk-mimetypes` alone gives a working framework for the floor types (`text/plain`, `text/markdown`, `application/json`, `application/xml`, `text/html`, `text/csv`) — the floor handler packages and both parser loaders are direct dependencies (v0.14.0, issue #14).
- **Slim:** add only the grammars you need (e.g. `npm i @plurnk/plurnk-mimetypes-grammar-python @plurnk/plurnk-mimetypes-grammar-rust`).
- **Kitchen sink:** the README carries a copy-paste `npm install` block listing every published grammar. (A `grammars-all` meta package was considered and rejected — a layer of indirection that does nothing.)
- **Degrade, not throw (issue #14):** `detect()` is install-state-blind — it returns the source mimetype regardless of whether the grammar package is installed. When `process()` then finds the grammar missing, it degrades to a text-plain fallback with `ok: true` and surfaces the missing package name on `ProcessResult.grammarMissing` so consumers can show an actionable install hint. `process(input, { strict: true })` opts into throwing `GrammarNotInstalledError` instead.

### 13.6 Reproducibility

Each grammar package's `scripts/build-wasm.mjs` rebuilds the WASM from the pinned upstream commit using `tree-sitter-cli`'s bundled wasi-sdk. CI runs `scripts/verify-wasm.mjs` to confirm the committed WASM is byte-identical to a fresh rebuild — this catches tampering and forces grammar updates through pin bumps rather than ad-hoc rebuilds.

## 14. Testing discipline (issue-driven test files)

Recurring problem: tests prove that what was written does what was intended, not whether what was written matches the design promise the issue claimed to deliver. When an issue says "X works universally" and the implementation only delivers half of X, the per-feature tests still pass — because no one wrote the test that asserts "X is universal."

The fix: every closed issue gets a test file in `src/issues/issue-{N}.test.ts` whose `describe` block names enumerate the issue's load-bearing claims (C1, C2, ...). The PR closing the issue must include this file. The tests assert the claim — *not the implementation* — so a future refactor that breaks the contract fails here, even if the per-feature tests still pass.

Example (`src/issues/issue-10.test.ts`):

```ts
describe("Issue #10 — C3: cross-dispatch matrix", () => {
    it("xpath on a JSON-shaped entry returns matches via the projected deep-xml", ...);
    it("jsonpath on a tree-shaped entry returns matches via deep-json", ...);
    // ...
});
```

If C3 had been written when issue #10 first landed, the xpath-on-non-XML gap (issue #10's symmetric half, undelivered until framework v0.12.0) would have failed the test immediately rather than shipping silently for several framework versions.

## 15. Public API stability

All exports from `@plurnk/plurnk-mimetypes/index` are stable from `v0.1.0` onward under semver. Internal modules (those not re-exported from `index.ts`) are not part of the stable API and may change between minor versions. v0.15.0 is a deliberate clean break (issue #16/#17): the preview/fitting/tokenize surface was removed outright.

## 16. References channel (framework v0.15.0, engine pending — issues #16/#19)

The references channel carries **classified symbol uses** — never definitions (those are the symbols channel's job). It is the per-entry raw material for plurnk-service's `symbol_refs` graph rows; linking, traversal, and cross-entry identity are entirely service-side SQL.

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

**Extraction mechanism (issue #19, engine landed v0.15.x).** Tree-sitter-backed languages declare per-language queries in `src/treesitter/queries/{slug}.ts` — the `.scm` S-expression source embedded as an exported string (reviewable query content without a build-time copy step), re-exported as `refsQuery` from the mapping module. One framework engine (`refsEngine.ts`) executes them via web-tree-sitter's Query API and resolves each ref's `container` against the symbols channel by line containment (innermost emitted def; equal spans go to the later emission, i.e. the deeper scope). ANTLR/hand-rolled handlers implement `references()` visitor-side when their language's turn comes. Default everywhere: `[]`.

Coverage: every code language in the registry ships a conformance-gated query (21 suites). Data formats (YAML, TOML, CSS) are refs-free by design — references are a code-graph concept. Languages whose syntax can't honestly support a kind omit it rather than guess (Haskell emits no `instantiate` — constructor application is syntactically identical to pattern deconstruction; Lua emits `call` only).

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

**Tier 2 authoring (out-of-registry tree-sitter handlers, issue #26).** A handler package that brings its own WASM grammar implements `references()` through the same engine via two `TreeSitterExtractor` affordances, so it never reimplements the priming dance:
- `loadParser()` calls `this.setQueryContext(language, QueryCtor)` after `Language.load()` — it owns the WASM path, so it is the only place holding the `Language` and the web-tree-sitter `Query` constructor.
- `references()` is one call to `this.collectRefs(content, querySource, extractDefs, wrap?)`, which owns parse → compile-and-cache query → run `collectReferences` against `extractDefs`'s symbols → cleanup, plus the shared error policy (`GrammarNotInstalledError` propagates for the #14 degrade; parse/query failures → empty channel). The in-registry `TreeSitterLanguageHandler` uses the identical helper — one priming implementation.
- A language needing **match-level composition** the engine's flat `captures()` can't express (HCL names defs `TYPE.NAME`) passes `wrap` to adapt the raw compiled query, and composes the qualified name into a `RefsCaptureNode` (`{text, startPosition, endPosition}` — the exact, blessed surface the engine reads off a capture, so no cast through `TreeSitterNode`).

## 17. Embedding channel (framework v0.15.x, issue #24)

The `embedding` channel is the per-entry vector supply for plurnk-service's `~semantic` dialect: **native-endian raw Float32 bytes** (`Uint8Array`, length = 4 × dimension), **scalar per entry**. The service stores the bytes verbatim as a sqlite BLOB and cosine-ranks over a `Float32Array` view — no JSON round-trip. The same channel embeds arbitrary text: an entry's body and a `~query`'s query text ride the identical path.

- **Opt-in only.** `"embedding"` is never in the default channel set — it is a model inference, orders of magnitude costlier than parsing. Request it explicitly: `process(input, { channels: ["embedding"] })`.
- **The embedder is an opt-in artifact package**: `@plurnk/plurnk-mimetypes-embeddings` (per-grammar-package precedent — the framework ships no model weights). It exports `embed(text): Promise<Uint8Array>` and `dimension: number`. Model: MiniLM-class `all-MiniLM-L6-v2`, **dimension 384** (1536 bytes), quantized ONNX bundled in the package (hermetic; pinned revision; fetch + verify scripts). Vectors are mean-pooled and L2-normalized.
- **What gets embedded**: string content verbatim; binary content via the handler's `toText()` projection (PDF page text). No projection / empty text → empty bytes (length 0), no hint — the honest channel.
- **Missing package degrades per #14**: requested embedding with the package absent → `embedding: new Uint8Array(0)` + `embeddingMissing` install hint, `ok` stays true; `strict: true` throws.
- **Grammar-degrade still embeds**: a grammar-missing entry is still semantically searchable text; `grammarMissing` and a real vector coexist.
- The dimension is **fixed per deployment** — changing the model/dimension invalidates the service's stored vectors; that is a consumer-side migration, not a framework concern. The embedder declares its identity (`model`, e.g. `"Xenova/all-MiniLM-L6-v2@751bff37+q8"`), surfaced as `ProcessResult.embeddingModel` — store it alongside each BLOB; it is the staleness detector that makes the migration detectable. The identity encodes **both** the model revision and the quantization, since either changes the vectors; the embedder derives it from its pin, never a hand-synced literal.
- **Lossless chunking facts** (`embedderInfo()`, embeddings#1, #31): the embedder optionally exports two pure model facts — `maxTokens` (the token window past which `embed()` truncates) and `countTokens(text): Promise<number>` (a count in the model's **own** tokenizer, special tokens included, untruncated) — plus its `model` identity. The framework surfaces them via `mimetypes.embedderInfo(): Promise<{ maxTokens, countTokens, model? } | null>`. `model` (the same string as `ProcessResult.embeddingModel`) lets the host fold the embedder id into each entry's derivation hash, so a model-id change (a re-quantization, or a swap keeping the same window) re-derives existing embeddings instead of silently excluding the stale-id vectors from `~query`. Omitted if the embedder predates exporting it. The host calls it once per derivation: `null` (no embedder, or one predating this surface) → one whole-entry chunk (today's behavior, zero regression); non-null → tile a body that exceeds the window into `≤ maxTokens` chunks measured by `countTokens`, so an over-window entry stays fully searchable instead of truncated. The framework owns no chunking logic — these are facts the host's chunker consumes.

## 18. Content channel (framework v0.15.x)

The `content` channel is the **model-facing readable text** of an entry — the markup-free projection a model reads for information (what plurnk-service's READ returns) and the **embed-source** (the embedding channel embeds `content` over the raw bytes). `ProcessResult.content?: string`.

**Present iff the readable form differs from the raw body.** Sort every mimetype by one question — *is the readable text the same as the bytes?*

- **Directly-readable formats** (code, markdown, JSON, plain text): `content` is **absent**. The raw body already is the readable text; the model reads the bytes directly; a `content` channel would just duplicate the body.
- **Binary** (PDF, …): the readable text is the handler's `toText` (page text) — its *only* readable form and its de-facto body. It is surfaced as the body, **not** via this channel. `content` stays absent for binary.
- **text/html**: `content` = **Readability + turndown markdown** — main-content extraction (strips nav/ads/chrome) into clean markdown. This is the *only* case transforming an already-textual-but-noisy body into a cleaner read, and **HTML is the only mimetype that populates `content`, for now**. (Email/EPUB are HTML-shaped and would reuse the pattern when they land — built then, not speculatively.)

**Always-on and source-agnostic.** `content` is in the default channel set (it's cheap — pure JS, no model). text/html computes it from whatever HTML bytes arrive: a local file → the document as markdown; the bytes a browser scheme rendered and serialized → the live page's readable content. The handler is a pure function of bytes and cannot tell which (see the HTML rendering split — rendering is the http scheme's job; `content` projects whatever it's handed).

**Relationship to `toText`.** A handler that overrides `content` typically routes `toText` (the regex/glob query surface) through the same projection, so there is one readable-text implementation per handler. The framework's embed-source resolves as `content() ?? toText()`: HTML markdown, else binary page-text, else the passthrough body.
