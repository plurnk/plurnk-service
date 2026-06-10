# @plurnk/plurnk-mimetypes

Framework + detection service for the `@plurnk/plurnk-mimetypes-*` handler family. Sits between [plurnk-service](https://github.com/plurnk/plurnk-service) (the engine) and individual per-mimetype handler repos (the implementations).

plurnk-service hands a path or content blob to `Mimetypes.process(...)` and gets back metadata (`mimetype`, `ok`, `totalLines`, `extent`) plus the structural channels it asked for: `symbols` (structured definitions), `deepJson` (jsonpath target), `deepXml` (xpath target), `references` (classified symbol uses). The service stays mimetype-illiterate; this helper owns detection, discovery, handler instantiation, channel selection and projection, the duck contract spec, and the build utilities handler repos consume.

## install

```
npm install @plurnk/plurnk-mimetypes
```

Requires Node ≥ 25 (native TypeScript support, ESM only).

The framework ships the floor: `text/plain`, `text/markdown`, `application/json`, `application/xml`, `text/html`, and `text/csv` handlers (plus the tree-sitter and ANTLR loaders) are direct dependencies. One install gives a working framework for those types.

### grammar packages

Tree-sitter languages are opt-in — install only the grammars you actually use:

```
npm install @plurnk/plurnk-mimetypes-grammar-python
npm install @plurnk/plurnk-mimetypes-grammar-rust
# ...etc
```

To install every published grammar in one command:

```
npm install \
  @plurnk/plurnk-mimetypes-grammar-bash \
  @plurnk/plurnk-mimetypes-grammar-c \
  @plurnk/plurnk-mimetypes-grammar-cpp \
  @plurnk/plurnk-mimetypes-grammar-css \
  @plurnk/plurnk-mimetypes-grammar-dart \
  @plurnk/plurnk-mimetypes-grammar-elixir \
  @plurnk/plurnk-mimetypes-grammar-fsharp \
  @plurnk/plurnk-mimetypes-grammar-fsharp-signature \
  @plurnk/plurnk-mimetypes-grammar-go \
  @plurnk/plurnk-mimetypes-grammar-haskell \
  @plurnk/plurnk-mimetypes-grammar-java \
  @plurnk/plurnk-mimetypes-grammar-javascript \
  @plurnk/plurnk-mimetypes-grammar-julia \
  @plurnk/plurnk-mimetypes-grammar-kotlin \
  @plurnk/plurnk-mimetypes-grammar-lua \
  @plurnk/plurnk-mimetypes-grammar-make \
  @plurnk/plurnk-mimetypes-grammar-ocaml \
  @plurnk/plurnk-mimetypes-grammar-odin \
  @plurnk/plurnk-mimetypes-grammar-php \
  @plurnk/plurnk-mimetypes-grammar-python \
  @plurnk/plurnk-mimetypes-grammar-ruby \
  @plurnk/plurnk-mimetypes-grammar-rust \
  @plurnk/plurnk-mimetypes-grammar-scala \
  @plurnk/plurnk-mimetypes-grammar-toml \
  @plurnk/plurnk-mimetypes-grammar-tsx \
  @plurnk/plurnk-mimetypes-grammar-typescript \
  @plurnk/plurnk-mimetypes-grammar-yaml \
  @plurnk/plurnk-mimetypes-grammar-zig
```

The framework auto-detects which grammars are installed; no code changes when you add or remove one. When a detected mimetype's grammar isn't installed, `process()` degrades — `ok` stays true, metadata is real, requested channels come back empty, and the missing package is reported on `ProcessResult.grammarMissing`. Pass `{ strict: true }` to throw `GrammarNotInstalledError` instead.

## use — orchestrator (plurnk-service side)

```ts
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const mimetypes = new Mimetypes({
    defaultMimetype: "text/markdown",   // fall back when nothing matches
});

const result = await mimetypes.process(
    { path: "src/main.py" },
    { channels: ["symbols", "deepJson", "deepXml"] },   // default: all four
);
// result.mimetype   === "text/x-python"
// result.symbols    === MimeSymbol[] — structured definitions
// result.deepJson   === structural tree (jsonpath query target)
// result.deepXml    === XML projection of deepJson (xpath query target)
// result.totalLines === source line count; result.extent === navigation bound
// result.ok         === true
```

Channels are materialized per call: unrequested channels are never computed and their fields are absent. `channels: []` is the cheap stat call — metadata only, no parse. The `references` channel (classified symbol uses for code-graph consumers) ships with its final shape and returns `[]` until the per-language extraction engine lands.

`defaultMimetype` is the mimetype the orchestrator substitutes when detection finds no match. For LLM-driven systems where most content is model-generated, `"text/markdown"` is almost always the right default. Omit the option to preserve strict null-on-miss behavior.

To render symbols as an outline for human eyes, use `format(result.symbols)`.

Body-matcher queries dispatch through `mimetypes.query(input, expression)` — regex (`/pattern/`), glob, jsonpath (`$.field`) against the deep-json channel, and xpath (`//selector`) against the deep-xml channel.

Pipeline failure modes are documented in [SPEC.md](SPEC.md#7-error-policy).

## use — handler authors

A handler is a class extending `BaseHandler` (or `TreeSitterExtractor` / `AntlrExtractor` for grammar-backed extraction). Implement `extractRaw(content)`; the framework derives `symbolsRaw`, the deep channels, and query dispatch from the base classes.

```ts
import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

export default class TextSomething extends BaseHandler {
    extractRaw(content: string): MimeSymbol[] {
        // return structural declarations as MimeSymbol[]
        return [];
    }
}
```

Discovery: declare your handlers in `package.json` (one or more entries per package):

```json
{
    "plurnk": {
        "kind": "mimetype",
        "handlers": [
            { "name": "text/something", "glyph": "✨", "extensions": [".sth"] }
        ]
    }
}
```

Reference handler: [plurnk/plurnk-mimetypes-text-markdown](https://github.com/plurnk/plurnk-mimetypes-text-markdown). Fork and adapt for new mimetypes — it's a real production handler, not a synthetic skeleton.

For ANTLR-backed handlers, vendor your `.g4` files in `grammar/`, run `npx plurnk-mimetypes-compile`, and switch the parent class to `AntlrExtractor`. The `antlr4ng` runtime ships with the framework; the `antlr-ng` compiler goes in your own devDependencies (it's the framework's only optional peer):

```
npm install --save-dev antlr-ng@^1.0.10
```

See [SPEC.md](SPEC.md#9-parser-backends) for the backend selection hierarchy and full handler wiring.

## public API

The package exposes its full primitive surface for tools building on top of it:

| Export | Purpose |
|---|---|
| `Mimetypes` | top-level pipeline orchestrator (`process`, `detect`, `getHandler`, `query`, `ready`) |
| `BaseHandler` | base class for handlers (default export) |
| `TreeSitterExtractor` | base class for tree-sitter-backed handlers; `walkDeepNode` default deep-json walker |
| `AntlrExtractor` | base class for ANTLR-backed handlers |
| `withExtractor(BaseVisitor)` | mixin that adds symbol-collection state to any antlr4ng visitor |
| `detect(input, registry)` | path/ext/hint/content → mimetype resolver |
| `discover(options)` | scan installed `@plurnk/plurnk-mimetypes-*` packages |
| `emptyRegistry()` | construct an empty `Registry` |
| `format(symbols)` | `MimeSymbol[]` → indented outline string |
| `buildTree(symbols)` | flat `MimeSymbol[]` → nested `TreeNode[]` |
| `renderTree(nodes)` | `TreeNode[]` → outline string |
| `maxDepth(nodes)` / `pruneToMaxDepth(nodes, limit)` | tree depth primitives |
| `parseBodyMatcher(expr)` | leading-prefix → `QueryDialect` + pattern |
| `queryRegex` / `queryGlob` / `queryJsonpathObject` / `queryXpathString` | per-dialect query primitives |
| `projectJsonToXml(value)` | universal deep-json → deep-xml projection (`pk:` bookkeeping namespace) |
| `buildJsonOutline(symbols)` | bare-leaves outline for legacy jsonpath fallback |
| `UnsupportedDialectError` / `InvalidExpressionError` / `QueryParseFailureError` | query error classes with `toTelemetryEvent()` |
| `GrammarNotInstalledError` | thrown by `process({ strict: true })` / `getHandler` when a grammar package is missing |
| `runCompile(opts)` | invoke antlr-ng + post-process imports |
| `rewriteImports(dir)` / `injectBaseImports(dir)` | generated-output post-processing utilities |

Public types: `MimeSymbol`, `SymbolKind`, `MimeRef`, `RefKind`, `Channel`, `HandlerMetadata`, `HandlerContent`, `ExtractionVisitor`, `Registry`, `DetectInput`, `HandlerInfo`, `Discovery`, `DiscoverOptions`, `TreeNode`, `CompileOptions`, `HandlerLoader`, `MimetypesOptions`, `ProcessInput`, `ProcessOptions`, `ProcessResult`, `QueryDialect`, `QueryMatch`, `ParsedBodyMatcher`, `JsonOutline`, `DeepTreeNode`, `TreeSitterTree`, `TreeSitterNode`, `TreeSitterParser`, `TelemetryEvent`, `ContentOffset`, `LogCoordinate`.

## cli

```
plurnk-mimetypes-compile      compile grammar/ → src/generated/ via antlr-ng
                              and rewrite .js import extensions to .ts
```

Run from a handler repo's root directory.

## development

```
npm install
npm run build
npm test
```

`test:lint`, `test:unit`, `test:intg` separately if needed. No biome / eslint — `tsc --noEmit` is lint.

## license

MIT.
