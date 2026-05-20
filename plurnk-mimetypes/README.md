# @plurnk/plurnk-mimetypes

Framework + detection service for the `@plurnk/plurnk-mimetypes-*` handler family. Sits between [plurnk-service](https://github.com/plurnk/plurnk-service) (the engine) and individual per-mimetype handler repos (the implementations).

plurnk-service hands a path or content blob to `Mimetypes.process(...)` and gets back `{ mimetype, symbols, preview, ok }`. The service stays mimetype-illiterate; this helper owns detection, discovery, handler instantiation, outline formatting, token-budgeted preview truncation, the duck contract spec, and the build utilities handler repos consume.

## install

```
npm install @plurnk/plurnk-mimetypes
```

Requires Node ≥ 25 (native TypeScript support, ESM only).

## use — orchestrator (plurnk-service side)

```ts
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const mimetypes = new Mimetypes({
    tokenize: (text) => myProviderTokenizer(text),   // sync or async
    defaultMimetype: "text/markdown",                // fall back when nothing matches
});

const result = await mimetypes.process(
    { path: "src/main.py" },
    { budget: 256 },
);
// result.mimetype === "text/x-python"
// result.symbols  === structural outline (string)
// result.preview  === bounded outline within budget tokens
// result.ok       === true
```

Without a budget the preview is unbounded — equivalent to `symbols`. plurnk-service supplies the real budget (sourced from `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS`).

`defaultMimetype` is the mimetype the orchestrator substitutes when detection finds no match. For LLM-driven systems where most content is model-generated, `"text/markdown"` is almost always the right default. Omit the option to preserve strict null-on-miss behavior.

`tokenize` accepts sync or async signatures. Sync WASM-backed tokenizers (tiktoken-js, llama-tokenizer-js, etc.) don't need to be wrapped in `async`.

Pipeline failure modes are documented in [SPEC.md](SPEC.md#error-policy).

## use — handler authors

A handler is a class extending `BaseHandler` (or `AntlrExtractor` for grammar-backed extraction). The framework derives `symbols`, `preview`, and `validate` from your single `extract(content)` method.

```ts
import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

export default class TextSomething extends BaseHandler {
    extract(content: string): MimeSymbol[] {
        // return structural declarations as MimeSymbol[]
        return [];
    }
}
```

Discovery: declare yourself in `package.json`.

```json
{
    "plurnk": {
        "kind": "mimetype",
        "name": "text/something",
        "glyph": "✨",
        "extensions": [".sth"]
    }
}
```

Reference handler: [plurnk/plurnk-mimetypes-text-markdown](https://github.com/plurnk/plurnk-mimetypes-text-markdown). Fork and adapt for new mimetypes — it's a real production handler, not a synthetic skeleton.

For grammar-backed handlers, vendor your `.g4` files in `grammar/`, run `npx plurnk-mimetypes-compile`, and switch the parent class to `AntlrExtractor`. ANTLR handlers add the runtime and compiler to their own devDependencies (the framework declares both as optional peer deps so consumers who only use `BaseHandler`/`Mimetypes` don't pay):

```
npm install --save-dev antlr-ng@^1.0.10 antlr4ng@^3.0.0
```

See [SPEC.md](SPEC.md#9-antlr-extractor) for the full handler wiring.

## public API

The package exposes its full primitive surface for tools building on top of it:

| Export | Purpose |
|---|---|
| `Mimetypes` | top-level pipeline orchestrator (`process`, `detect`, `getHandler`, `ready`) |
| `BaseHandler` | base class for handlers (default export) |
| `AntlrExtractor` | base class for ANTLR-backed handlers |
| `withExtractor(BaseVisitor)` | mixin that adds symbol-collection state to any antlr4ng visitor |
| `detect(input, registry)` | path/ext/hint/content → mimetype resolver |
| `discover(options)` | scan installed `@plurnk/plurnk-mimetypes-*` packages |
| `emptyRegistry()` | construct an empty `Registry` |
| `format(symbols)` | `MimeSymbol[]` → indented outline string |
| `fit(symbols, budget, tokenize)` | drop-deepest-first token-budget truncation |
| `fitContent(content, budget, tokenize)` | raw-content token-budget truncation |
| `buildTree(symbols)` | flat `MimeSymbol[]` → nested `TreeNode[]` |
| `renderTree(nodes)` | `TreeNode[]` → outline string |
| `maxDepth(nodes)` | tree's maximum nesting depth |
| `pruneToMaxDepth(nodes, limit)` | drop nodes deeper than `limit` |
| `runCompile(opts)` | invoke antlr-ng + post-process imports |
| `rewriteImports(dir)` | rewrite `.js` import extensions to `.ts` |
| `defaultTokenize` | fallback heuristic (`text.length / 2`); biased toward safety |

Public types: `MimeSymbol`, `SymbolKind`, `HandlerMetadata`, `HandlerOptions`, `TokenizeFn`, `ExtractionVisitor`, `Registry`, `DetectInput`, `HandlerInfo`, `Discovery`, `DiscoverOptions`, `TreeNode`, `CompileOptions`, `HandlerLoader`, `MimetypesOptions`, `ProcessInput`, `ProcessOptions`, `ProcessResult`.

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
