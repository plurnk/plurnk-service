# @plurnk/plurnk-mimetypes — Specification

This document defines the handler contract, pipeline, data shapes, and policies owned by `@plurnk/plurnk-mimetypes`. Handler packages implement it; `plurnk-service` consumes the composed projection service.

---

## §mimetype-handler-contract 1. Handler contract

The exported `BaseHandler`, `HandlerContent`, `HandlerMetadata`, and channel types own the executable TypeScript surface. Handler packages extend `BaseHandler`, `TreeSitterExtractor`, or `AntlrExtractor` and override only the behavior their content algebra supports.

| Surface | Default | Handler responsibility |
|---|---|---|
| `extractRaw(content)` | `[]` | Emit structured `MimeSymbol[]` definitions (or `Promise<MimeSymbol[]>`) for the `symbols` channel. |
| `deepJson(content)` | `null` | Emit the algebra's faithful structural value for JSONPath. |
| `deepXml(content)` | Project `deepJson`, then the symbol outline. | Override only when native markup is more faithful. |
| `references(content)` | `[]` | Emit classified `MimeRef[]` symbol uses, never definitions. |
| `content(content)` | `undefined` | Emit readable text only when it differs from the raw body. |
| `validate(content)` | No-op | Reject content only when the mimetype has a meaningful validity check. |
| `parseIssues(content)` | `0` | Count parser recovery sites without deciding source validity. |
| `query(...)` | Text and structural dialect dispatch. | Override when native parsing can provide more faithful evidence. |
| `symbolsRaw(content)` | `format(await extractRaw(content))` | Human/diagnostic outline; not a model-facing projection channel. |
| `toText(content)` | String passthrough; binary content unsupported. | Supply readable text for binary regex/glob matching when valid. |
| `projectionConfiguration()` | `""` | Return a deterministic canonical string for effective settings that can change projections (fails hard on invalid settings). |
| `dispose()?` | No-op when extending `BaseHandler`. | Required only when the handler retains releasable resources. |

- **Authority:** The handler owns the material in each projection. The framework owns detection, handler routing, channel selection, default JSON-to-XML projection, and shared references/query engines. Consumers own storage, packet rendering, and token budgets.
- **Content shape (`plurnk.binary`):** A package-level `plurnk.binary: true` declaration selects `Uint8Array` rather than UTF-8 decoding when reading a filesystem path; text handlers receive a `string`. Inline callers supply `ProcessInput.content` in the declared shape; the framework does not coerce an explicitly supplied value.
- **Metadata injection:** Handler identity (`mimetype`, `glyph`, `extensions`) is injected from the discovered package declaration at construction, and the orchestrator validates the handler surface structurally before caching it.

### §mimetype-binary-input 1.1 Binary input, facts, and media handlers

Durable entry representation belongs to consumers; the framework admits raw bytes only as transient handler input, and the installed handler's `content` channel is the sole authority for deriving model-readable Unicode.

| Surface | Contract |
|---|---|
| `PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES` | One positive-integer ceiling for filesystem, inline, and streamed binary inputs before handler execution (a format handler may impose a stricter limit, never weaker). |
| `projectReadable(input)` | Returns derived Unicode, source mimetype, opaque projection identity, and optional `facts` (when the handler overrides `facts`); `null` when no content projection exists or `validate` refuses the source. |
| `projectReadableStream(chunks, mimetype)` | Consumes `Uint8Array` chunks within the ceiling only for an installed binary content projection. |
| `collectBinary(chunks, mimetype)` | Collects source bytes within the ceiling independently of readable projection availability; storage remains consumer-owned. |
| Limit exceeded | Throws `MimetypeInputLimitError` with source mimetype, maximum bytes, and observed bytes. |

| Media package | Served mimetypes | Facts & readable line contract |
|---|---|---|
| `@plurnk/plurnk-mimetypes-image` | `image/png`, `image/jpeg`, `image/gif`, `image/webp` | Binary header-only handler: `validate` checks header magic; `facts` and `deepJson` expose `{ format, width, height, bytes }`; `content` is `PNG image, 640×480 px, 12345 bytes`. Native image attachment belongs to {§log-wire-format}. |
| `@plurnk/plurnk-mimetypes-application-pdf` | `application/pdf` | Binary header-only handler ({§pdf-magic}): `validate` checks `%PDF-` magic; `facts` and `deepJson` expose `{ pages, bytes }` (`pages` is root `/Count`, or `null` when inside a compressed object stream); `content` and `summary` are `PDF document, 3 pages, 12345 bytes`. Native attachment and page/byte weight belong to {§log-wire-format}. |
| `@plurnk/plurnk-mimetypes-audio` | Manifest-declared audio MIME names/extensions (`.webm` alone does not imply audio) | Lazily parses binary audio containers via `music-metadata` within the binary input limit: `facts` and `deepJson` expose `{ format, duration, bytes }` (`duration` in seconds or `null`); `content` and `summary` are one facts line; unrecognized/non-audio input has no readable/native projection; no transcription, sample decoding, transcoding, or cover-art extraction occurs ({§log-wire-format}). |

### §mimetype-lifecycle 1.2 Orchestrator lifecycle and projection identity

- **Shared readiness & caching:** Every discovery-dependent public method awaits `ready()` internally, sharing one discovery promise across concurrent first calls and constructing one handler instance per mimetype.
- **Idempotent quiescent `dispose()`:** Callers stop new work and await active operations before calling `dispose()`. Concurrent `dispose()` calls join one teardown attempt that awaits every cached handler's `dispose()`, aggregates their original failures (excluding resources that failed acquisition), and clears handler and grammar-fingerprint caches while retaining discovery. A disposed orchestrator may be used again as a new cache generation. Tree-sitter handlers delete their cached query before their parser.
- **Projection identity (`Mimetypes.projectionIdentity(mimetype)`):** Returns an opaque SHA-256 identity combining:
  1. Framework projection revision (`@plurnk/plurnk-mimetypes`).
  2. Mimetype, source kind, and npm package name (`Discovery`).
  3. Per-handler `revision` from the handler declaration (incremented whenever code or dependencies can change projection output).
  4. Effective projection configuration from `projectionConfiguration()`.
  5. Mapping revision and installed WASM bytes (or explicit absent-grammar state) for built-in Tree-sitter registry entries.
  Package versions, glyphs, extensions, and attribution are excluded; unregistered mimetypes have a stable identity without loading extension code.

---

## §mimetype-discovery 2. Package discovery and naming

A package declares one or more handlers in `package.json` under `"plurnk"`:

| Manifest / `HandlerDecl` field | Type | Required | Contract |
|---|---|---|---|
| `plurnk.kind` | `"mimetype"` | yes | Selects the mimetype extension kind ({§extension-kind}). Containing `package.json` `name` must be a valid npm package name. |
| `plurnk.binary` | boolean | no | `true` when every handler entry consumes `Uint8Array`; default `false`. |
| `plurnk.attribution` | string \| string[] | no | Normalized once into `Discovery.packageAttributions` for packages represented by at least one final package-sourced handler ({§extension-kind}); lazy handlers may also implement the synchronous attempt-time hook. |
| `plurnk.handlers` | `HandlerDecl[]` | yes | Non-empty array of peer handler entries. |
| `handlers[].name` | string | yes | RFC 6838 restricted `type/subtype` syntax; each registered name produces its own handler instance with its own metadata and preserves variant identity in `ProcessResult.mimetype` (e.g., `application/json` vs `application/jsonc`). |
| `handlers[].revision` | string | yes | Non-empty handler-owned projection revision ({§mimetype-lifecycle}). |
| `handlers[].glyph` | string | no | Opaque client presentation glyph (defaults to `""` in discovery; Core projects `""` as absence via {§mcp-module}). |
| `handlers[].extensions` | string[] | no | Dotted entries are case-insensitive extensions (`.py`); bare entries are case-sensitive filenames (`Dockerfile`). |

- **Discovery order & trust boundary:** When `packageDirs` is omitted, `discover()` enumerates `node_modules` packages (third-party sorted, then `@plurnk` sorted). The trust predicate runs before importing handler code; untrusted packages are recorded in `skipped` ({§extension-kind}). Later claims win on collision; a package claim for a Tree-sitter mimetype suppresses that built-in entry, and unclaimed Tree-sitter entries fill only unclaimed extension/filename keys.
- **Extension & resolution failures:** Missing manifests or non-mimetype packages are ignored. A trusted claim with a malformed declaration, or a registered handler's import, construction, or structural validation failure, throws `MimetypeExtensionError` with package and mimetype identity and original cause. Default loading resolves from `DiscoverOptions.cwd` (or `process.cwd()`) under the process's active Node conditions (`import`-only conditional roots are not resolved automatically unless a `HandlerLoader` is injected).
- **Naming conventions:** Prefer IANA names when accurate; retain established ecosystem names (`text/x-{language}`, `application/jsonc`, `application/jsonl`, `audio/aiff`, `text/typescript`, `text/tsx`, `text/stream`, and SQL dialects `text/x-sqlite`, `text/x-pgsql`, `text/x-mysql`, `text/x-tsql`, `text/x-plsql`, plus dialect-agnostic `application/sql`). Do not invent `-sql`, `-cli`, or `-script` suffixes.

---

## §mimetype-symbol 3. `MimeSymbol`, container, and outline format

| Field / aspect | Contract |
|---|---|
| `name`, `kind` | Identify one named structural definition using the closed `SymbolKind` vocabulary. Include top-level, module, type, class, and private/public member declarations plus durable document structure (headings, CSV fields, JSON keys); exclude function-local variables, control flow, comments, literals, anonymous declarations, and imports/re-exports. |
| `line`, `endLine` | Positive 1-based inclusive line interval (`endLine >= line`). |
| `column`, `endColumn` | Present together as a complete {§text-coordinates} span (1-based Unicode code points, start inclusive, end exclusive). |
| `params` | Function/method parameter spellings (`["source", "options"]`, `["{host, port}"]`, `["...args"]`, `["entryRule=\"program\""]`) when exposed by the grammar; omitted otherwise. |
| `level` | Heading depth `1`–`6`; meaningful only for `kind: "heading"`. |
| `container` | Dot-joined path of enclosing *emitted* named symbols (`"Parser"`, `"Outer.Inner"`); absent (never `""`) at top level. Anonymous/unemitted scopes contribute nothing; dotted symbol names (`Foo.Bar`, `database.options`) remain verbatim single segments. `container` is extraction-time truth for the code graph `(entry, container, name)`. |
| `format(symbols)` / `symbolsRaw` | Renders a 2-space-indented outline tree: headings nest by `level` (`<indent># Name [line]`), other symbols nest by `[line, endLine]` containment (`<indent>kind name(params)? [line-endLine]`, collapsing to `[N]` when single-line). |

---

## §mimetype-channel-selection 4. Channel selection, parse issues, summary, and validation

`Mimetypes.process(input, { channels?, parseIssues?, summary?, strict? })` materializes requested channels eagerly per call ({§mimetype-channel-architecture}):

| Request / option | Behavior |
|---|---|
| Default (`channels` omitted) | Materializes the 5 structural/content channels: `symbols`, `deepJson`, `deepXml`, `references`, `content`. `facts` is materialized only when explicitly named. |
| Explicit `channels` | Unrequested channels are not computed and their fields are omitted from `ProcessResult`. A requested channel that an entry lacks is present with its empty representation (`[]`, `null`, `""`, or `undefined` for `content`). `channels: []` performs metadata-only inspection (`mimetype`, `ok`, `totalLines`). |
| `deepXml` dependency reuse | Consumes `deepJson` (reusing it if already requested) and falls back to `symbols`; unrequested intermediate dependencies remain unexposed. |
| `parseIssues` | Computed when any structural channel is materialized or `parseIssues: true` is passed. Awaits `handler.parseIssues(content)` (Tree-sitter counts `isError` and `isMissing` nodes); positive safe integers appear as `ProcessResult.parseIssues`, while `0` is omitted. Advisory only—never suppresses partial projections, matching, or indexing. |
| `summary` | When `summary: true`, invokes `handler.summary(content)`, collapses whitespace and trims into one line, and sets `ProcessResult.summary` when nonempty. For `text/markdown`, leading YAML frontmatter string `description` takes precedence over the first paragraph directly beneath the first exact semantic H2 `Summary` before any subsequent heading (headings in code and other levels/names are inert). |
| `validate` | Invoked before channel materialization (and before JSONPath/XPath in `Mimetypes.query`, while regex/glob remain available without structural validation). When `validate` throws, the orchestrator wraps the cause once in `MimetypeInputError` ({§mimetype-error-policy}). |

---

## §mimetype-error-policy 5. Error policy, line count, and derivation evidence

| Condition / surface | Behavior |
|---|---|
| `totalLines` | Editor-convention logical line count owned by `TextCoordinates.lineCount(content)` (mirrored in `entry_channels.lines`, {§tokenomics}): `"abc\ndef"` $\to 2$, `"abc\ndef\n"` $\to 2$, `"\n"` $\to 1$, `""` $\to 0$. Binary mimetypes (`binary: true`) and error results (`ok: false`) report `totalLines: 0`. |
| Detection returns `null` or path unreadable | Returns `{ mimetype: null \| string, ok: false, totalLines: 0 }` with no channel fields. |
| Registered handler fails to load | Throws `MimetypeExtensionError` (only when module resolution names that exact requested package as missing is an optional artifact considered absent; missing transitive dependencies or init faults in installed artifacts propagate). |
| Tree-sitter grammar package absent | Non-strict returns `{ mimetype, ok: true, totalLines, grammarMissing: pkg, notices: [{ level: "warn", source: "mimetype:<normalized-type>", kind: "grammar_degraded", data }] }` with empty requested structural channels; `{ strict: true }` throws `GrammarNotInstalledError`. |
| `validate()` throws | Throws `MimetypeInputError` preserving the validator cause (`QueryParseFailureError` in `query()`). |
| Unexpected handler/channel exception | Wraps once at the channel-materialization boundary in `MimetypeDerivationError` carrying JSON-quoted `path` (or `null`) and `mimetype` (each clipped to 512 UTF-16 units retaining both ends, with control characters escaped) and the exact original `cause`. |

---

## §treesitter-runtime-gate 6. Detection and parser backends

- **Detection priority (`detect({ path?, ext?, hint? }, registry)`):** Resolves in strict order:
  1. `hint` (caller-asserted mimetype).
  2. `path` basename matching a registered filename (`Dockerfile`, `Makefile`).
  3. `ext` or `extname(path)` matching a registered extension (case-insensitive, leading dot enforced).
  `Mimetypes.detect()` applies `MimetypesOptions.defaultMimetype` when all three lanes miss.
- **One Tree-sitter runtime, serialized loads:** Every Tree-sitter handler shares one `web-tree-sitter` WASM runtime initialized once per process, and grammar loads (`Language.load()`) are serialized through the shared gate; no handler calls `Parser.init()` or `Language.load()` directly. Linear WASM memory grows to the largest single parse and is reused across parses; `dispose()` frees parser and query objects inside it.
- **Backend selection hierarchy:**
  1. *Framework Tree-sitter registry:* Upstream grammar built as reproducible WASM (`@plurnk/plurnk-mimetypes-grammar-{slug}`) + shared mapping.
  2. *Dedicated portable parser:* Separate handler package (`@plurnk/plurnk-mimetypes-{lang}`) with prebuilt WASM or portable JS parser (wins conflicts over Tier 1 registry entries).
  3. *`antlr4ng` + `grammars-v4`:* Pure-JS ANTLR visitor via `npx plurnk-mimetypes-compile` and `AntlrExtractor` + `withExtractor`.
  4. *Focused hand-written extractor:* Zero-dependency `BaseHandler` subclass for simple formats lacking maintained grammars.
  Native `node-gyp` `tree-sitter`, native FFI bindings, and install-time compiler/emscripten requirements are forbidden.

### §mimetype-parser-coordinates 6.1 Parser coordinate boundary

Parser-native spans are materialized into 1-based Unicode code-point `TextRegion` coordinates (`startLine`, `startColumn`, `endLine`, `endColumn`, exclusive end; {§text-coordinates}) against the exact original source through `ParserCoordinates`:

| Producer | Retained native span | Materialization rule |
|---|---|---|
| `antlr4ng` | Code-point `start` and inclusive `stop` offsets (`-1` on inserted recovery tokens). | Recovery tokens with `-1` carry no source coordinates; otherwise make `stop` exclusive and map against the exact source (an epsilon context where `stop < start` becomes zero-width). |
| `web-tree-sitter` string input | UTF-16 `startIndex` and exclusive `endIndex` offsets. | Map UTF-16 offsets against the exact source via `treeSitterSpan` / `materializeTreeSitterSymbols`; never publish native point columns. |
| Point-only synthetic Tree-sitter capture | Zero-based row and UTF-16 column offsets. | Resolve against the exact source; retain absolute indices whenever source nodes expose them. |

Astral characters count once, combining code points remain distinct, LF/CRLF/CR are line separators, spans starting or ending between CR and LF expand to enclose the separator (zero-width spans there map to the preceding line's end), and offsets inside an indivisible text unit are enclosed minimally. Unaddressable, partial, inverted, or bisecting spans throw `ParserCoordinateError` (never converted into an empty channel), and rejected column ranges name the line's current text clipped to 96 code points.

---

## §mimetype-query 7. Body-matcher query and conformance

`Mimetypes.query(input, matcher)` accepts either a raw matcher string classified by `parseBodyMatcher(expr)` or an already-parsed `ParsedBodyMatcher { dialect, pattern, flags? }` (dispatched verbatim without re-parsing):

| Prefix | Dialect | Dispatch & `matched` / `matching` / region contract |
|---|---|---|
| `//` | `xpath` | Tested before `/`. Runs over `deepXml(content)`. `matched` is string value (text/attribute) or serialized XML (element); multi-match sets `matching: "(//expr)[1]"`. |
| `/` | `regex` | `/pattern/flags` over `toText(content)`. `matched` is full string (bare), `[c1, ...]` (anonymous captures), or object (named/mixed captures); `matching` omitted. |
| `$` | `jsonpath` | `$.field` over `deepJson(content)` (falling back to symbol outline). `matched` is the resolved JSON value; wildcard multi-match sets `matching: "$.users[0].name"`. |
| otherwise | `glob` | Shared Picomatch `globToRegex` compiler over `toText(content)` (wildcards span `/`, extglobs enabled, leading `!text` literal, `!(a\|b)` negative extglob; no-magic pattern is literal non-overlapping substring search; explicit globs select complete lines). |

- **Query error mapping:** Detection `null` or unreadable content throws `ReferenceError` (propagates); unregistered mimetype or unsupported dialect throws `UnsupportedDialectError` (scheme adapter maps to `415`); malformed regex/glob/JSONPath/XPath expression throws `InvalidExpressionError` (`400`, whereas unexpected JSONPath evaluation/projection defects propagate unchanged); unparseable source for JSONPath/XPath throws `QueryParseFailureError` (`MimetypeInputError` subtype, mapped by the scheme adapter to `203` with readable content); zero findings returns `[]` (`204`).
- **Query-evidence conformance (`assertQueryEvidenceConformance(handler, cases)`):** Validates every reported region through `TextRegion` against one of four verdicts:
  - `exact`: Complete 4-coordinate `regions` in readable text (regex/glob on addressable boundaries, or structural nodes with complete source coordinates).
  - `enclosing`: Complete 4-coordinate `enclosingRegions` with `regions` absent (regex bisecting a surrogate pair/CRLF, or structural nodes with ancestor/line-only coordinates).
  - `locator-only`: Nonempty canonical `matching` and no `regions` or `enclosingRegions` (computed scalars, or synthetic/transformed trees without a source map).
  - `unsupported`: Throws `UnsupportedDialectError` (text matcher without readable text, or structural matcher with neither deep channel nor symbols).

---

## §mimetype-channel-architecture 8. Channel architecture (`deep-json` and `deep-xml`)

| Channel | Result field | Convention |
|---|---|---|
| `symbols` | `symbols: MimeSymbol[]` | Definition graph, chunk boundaries, and human outline ({§mimetype-symbol}). |
| `deepJson` | `deepJson: unknown` | Native vocabulary per algebra: Tree-sitter named-children AST (`DeepTreeNode` with `type`, `line`, `endLine >= line`, optional columns, leaf `text`, and named children); parsed data value directly for JSON/YAML/TOML/CSV/JSONL/INI/dotenv; nested DOM objects for HTML/XML/SVG; marked block AST for Markdown. |
| `deepXml` | `deepXml: string` | Projected via `projectJsonToXml()` in two modes—*annotated tree* (nonempty `type` or parent key as element name, `line`/`endLine`/`column`/`endColumn`/`level` as `pk:` attributes in `https://plurnk.xyz/deep-xml/1`, `text` as element text, `attrs` as unprefixed content attributes, `null`/`undefined` skipped) or *parsed value* (JSON/JSONL/ipynb/CSV/INI/dotenv/outline maps where `type`/`text`/`attrs`/`line` remain ordinary data keys and `null` renders as empty elements with source coordinates). Every element name is sanitized to `[A-Za-z_][A-Za-z0-9_.-]*` (empty $\to$ `node`), top-level arrays/primitives wrap in `<root>`, disjoint `TextRegion[]` from `ProjectLineFor` are preserved in `pk:regions`, and every XPath dispatch binds `xmlns:pk="https://plurnk.xyz/deep-xml/1"`. |
| `references` | `references: MimeRef[]` | Classified symbol uses ({§mimetype-references}). |

`deepJson` and `deepXml` are internal query targets and are never model-visible.

---

## §mimetype-grammar-packages 9. Per-grammar package architecture and reproducibility

- **Runtime boundary:** Each Tree-sitter grammar ships prebuilt WASM in `@plurnk/plurnk-mimetypes-grammar-{slug}/{slug}.wasm` with `web-tree-sitter` as its runtime peer and zero dependency on Plurnk frameworks. `TreeSitterLanguageHandler.loadParser()` resolves only that subpath and throws `GrammarNotInstalledError` when absent. `detect()` is install-state-blind.
- **Optional grammars (`optional: true`):** Keep their mapping, detection, and revision in the framework, but are omitted from `@plurnk/plurnk-service`'s default dependency set ({§bundled-set}); operators install them on demand (`npm i @plurnk/plurnk-mimetypes-grammar-<slug>`). F# (`fsharp`, `fsharp-signature`) is optional.
- **Reproducibility & maintenance:** Each grammar package locks an exact checkout-local `tree-sitter-cli` devDependency under strict allow-script policy, fetches the full commit ID in `.grammar-pin` from `.grammar-source` at depth 1 in a disposable repo (installing upstream JS grammar lockfiles only with `npm ci --ignore-scripts --omit=dev`), and verifies that `verify:wasm` matches the committed WASM SHA-256 (`build:wasm` updates it; `update:pin [--check]` selects the highest stable semver tag). Coordinated grammar updates require a per-package issue number, clean `main` matching `origin/main`, a signed Conventional commit on a topic branch, and push to Gitea without automatic npm publication or GitHub mirroring.

---

## §mimetype-references 10. References channel and public API

The exported `MimeRef` and `RefKind` types own classified symbol uses (never definitions, string/comment decoys, or bare local variable reads) in deterministic document order, with complete 1-based coordinates ({§mimetype-parser-coordinates}):

| `RefKind` / field | Meaning |
|---|---|
| `import` | Name bound from another module (path-only imports emit no guessed name). |
| `call` | Invoked callable name, including member-call property names. |
| `instantiate` | Syntactically distinct construction of a type or value. |
| `inherit` | Base type, implemented interface, trait, or analogous relation. |
| `type` | Name used in a type position. |
| `use` | Explicit language use fitting none of the narrower kinds. |
| `container` | Full qualified path of the innermost enclosing emitted definition (`"Parser.parse"`), matching a path from that entry's symbols; omitted at module top level. |

- **Query assets & conformance:** Framework reference queries live in `queries/<language>.scm` (TSX composes TypeScript and JSX patterns); missing assets or invalid `.scm` queries are package failures, never empty fallbacks ({§mimetype-error-policy}). Dedicated Tree-sitter handlers call `setQueryContext(...)` and `collectRefs(...)` (with an optional `wrap` adapter producing `RefsCaptureNode`), ANTLR handlers use `withExtractor.addRef(...)` and `gateContainer(...)`, and `@plurnk/plurnk-mimetypes/conformance` exports `assertHandlerConformance` (alongside the package root, forming the semver-stable public API).

---

## §mimetype-content 11. Content channel and binary classification

- **Content channel (`ProcessResult.content`):** Present only when the model-readable representation differs from the raw body (absent for already-readable text or binary inputs without a readable projection; derived string for transformed text like HTML/notebooks or binary inputs with a facts/readable projection). Stored by the service as the `readable` channel ({§channel-selection}) with its own coordinate space.
- **Channel-scoped query (`toText()`):** Regex and glob always run over the channel content they are given in that channel's own coordinates (raw markup/JSON on `source`, projected Markdown on `readable`); handlers must not route regex/glob on `source` through `content()`. Structural queries on a text `source` retain parser-backed source coordinates even when a separate `readable` channel exists.
- **Binary classification (`classifyMimetype` / `Mimetypes.classify`):** `Mimetypes.classify(mimetype)` uses the installed handler's `plurnk.binary` declaration (`source: "handler"`) when available, otherwise falling back to `classifyMimetype(mimetype)` (`source: "heuristic"`), which classifies `""`, `text/*`, known textual `application/*` formats, and `+json`/`+xml`/`+yaml`/`+toml` suffixes as `binary: false`, and values without `/` or any other MIME type as `binary: true`.
