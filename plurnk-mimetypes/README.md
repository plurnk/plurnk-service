# @plurnk/plurnk-mimetypes

Framework + contract for the `@plurnk/plurnk-mimetypes-*` handler family. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service): it hands `Mimetypes.process(path | content)` a blob and gets back `mimetype` + the structural channels it asked for. The service stays mimetype-illiterate; this owns detection, discovery, instantiation, channel selection/projection, and the author contract.

## Documentation

- [`SPEC.md`](./SPEC.md) — the authoritative author-facing contract. This README is the orientation.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar), [plurnk-execs](https://github.com/plurnk/plurnk-execs), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes).

## Install

```
npm install @plurnk/plurnk-mimetypes
```

Node ≥ 26, ESM. The framework ships the **floor** as direct deps — `text/plain`, `text/markdown`, `application/json`, `application/xml`, `text/html`, `text/csv` — so one install parses those. Everything else is opt-in: add the languages you use, or the whole family at once.

```
npm install @plurnk/plurnk-mimetypes-grammar-python   # one language
npm install @plurnk/plurnk-mimetypes-all              # every first-party handler
```

Detection auto-finds installed grammars — no code changes when you add or remove one. A detected mimetype whose grammar isn't installed **degrades**: `ok` stays true, metadata is real, requested channels come back empty, and the missing package is on `ProcessResult.grammarMissing`. Pass `{ strict: true }` to throw `GrammarNotInstalledError` instead.

## Write a handler

Ship a handler by publishing a package — **under any scope** (`@acme/whatever`; discovery keys on `plurnk.kind`, not the `@plurnk` scope) — that declares its mimetypes and default-exports a `BaseHandler` subclass.

### 1. Declare in `package.json`

```json
{
  "plurnk": {
    "kind": "mimetype",
    "handlers": [
      { "name": "text/x-cobol", "glyph": "🗄", "extensions": [".cbl", ".cob"] }
    ]
  }
}
```

One package may declare many handlers; each `handlers[]` entry registers independently. Add `"binary": true` at the top of the `plurnk` block for byte-oriented formats (PDF, images) — every method then receives a `Uint8Array` instead of a `string` (override `toText()` so regex/glob and embeddings still get a readable projection).

### 2. Default-export a `BaseHandler` subclass

The framework instantiates one handler per mimetype, injecting `{ mimetype, glyph, extensions }` (`HandlerMetadata`), and calls only the channels a `process()` request asks for. Every channel has a working default — **override only what your algebra supports**:

| Override | Channel / purpose | Default |
|---|---|---|
| `extractRaw(content)` | `symbols` — structural defs as `MimeSymbol[]` | `[]` |
| `deepJson(content)` | `deepJson` — full structural tree (jsonpath/xpath target) | `null` |
| `deepXml(content)` | `deepXml` — XML view | projects `deepJson()` for you |
| `references(content)` | `references` — classified symbol uses (`MimeRef[]`), §16 | `[]` |
| `content(content)` | `content` — model-facing readable text (and embed-source) | `undefined` (absent) |
| `extent(content)` | navigation bound (lines, pages, items) | line count / `0` for binary |
| `validate(content)` | throw on malformed input | no-op |
| `query(...)` / `toText(content)` | body-matcher dispatch (§11) | regex/glob/jsonpath/xpath defaults |

```ts
import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

export default class TextCobol extends BaseHandler {
    extractRaw(content: string): MimeSymbol[] {
        return [/* structural declarations */];
    }
}
```

### 3. Pick a parser backend — in this order (SPEC §9)

1. **tree-sitter, clean WASM** — in-registry via framework PR. Most languages.
2. **tree-sitter, own WASM** — `extends TreeSitterExtractor`, commit a built `.wasm` from a pinned grammar commit. `references()` is ~3 lines via the base `collectRefs()` helper (§16).
3. **ANTLR** — vendor `.g4` in `grammar/`, run `npx plurnk-mimetypes-compile`, `extends AntlrExtractor`. `antlr4ng` ships with the framework; `antlr-ng` is your devDep (the only optional peer).
4. **hand-roll** — `extends BaseHandler` and scan directly. Justify in your README; the bar is high.

Fork a real one: [plurnk-mimetypes-text-markdown](https://github.com/plurnk/plurnk-mimetypes-text-markdown) — a production handler, not a synthetic skeleton.

### Certify your references channel

If you emit `references()`, certify it against the same SPEC §16 invariants the in-registry languages run — at the `@plurnk/plurnk-mimetypes/conformance` subpath:

```ts
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { it } from "node:test";

it("text-cobol refs are conformant", async () => {
    await assertHandlerConformance(new TextCobol(metadata), {
        source: REAL_WORLD_FIXTURE,            // not a synthetic snippet
        decoyNames: ["secret", "TODO note"],   // strings/comments that must NOT surface as refs
        expectJoins: [{ refName: "Helper", container: "Foo.run" }], // ≥1 ref that joins to a local def
        expectRefs: [{ name: "Helper", kind: "instantiate" }],
    });
});
```

Checks 1-indexed positions, container-names-an-emitted-def, no refs from string/comment positions, the service's `(container, name)` join, and deterministic order. Refs-free handlers (data formats, symbols-only) skip it — an empty channel is honest.

## Use it (plurnk-service side)

```ts
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const m = new Mimetypes({ defaultMimetype: "text/markdown" }); // fallback on no match
const r = await m.process({ path: "src/main.py" }, { channels: ["symbols", "references"] });
// r.mimetype  "text/x-python"
// r.symbols   MimeSymbol[]   r.references MimeRef[]
// r.deepJson  jsonpath target  r.deepXml xpath target  r.content readable text
// r.extent    navigation bound  r.totalLines  r.ok
```

Channels materialize per call — unrequested ones are never computed and their fields are absent. `channels: []` is the stat-only call (metadata, no parse). `embedding` is opt-in (model inference) and needs `@plurnk/plurnk-mimetypes-embeddings`. Body-matcher queries: `m.query(input, expr)` — regex `/p/`, glob, jsonpath `$.x` (deep-json), xpath `//x` (deep-xml). `format(r.symbols)` renders a human outline. Failure modes: [SPEC §7](SPEC.md#7-error-policy).

## Discovery & trust

`discover(options?)` scans **every installed package** under `<cwd>/node_modules` — scope-agnostic — for `plurnk.kind === "mimetype"`, reading handler metadata from `package.json` (no handler code is imported until a mimetype is actually used).

- **Scope-agnostic.** Publish under your own scope and the host's scan finds it like a first-party handler — no bundle membership, no registration.
- **Trust gate.** `PLURNK_PLUGINS_TRUSTED_ONLY` (host posture, honored by all four plugin families): unset/`""`/`0` → every package registers (default, no regression); any value → `@plurnk/*` always trusted plus a comma-separated allowlist (`1` = first-party only). An untrusted package is discovered but not registered — never a crash.
- **Floor protection.** `@plurnk` is scanned **last**, so a third party can *add* a mimetype but cannot shadow a floor handler.

## Exports

- `Mimetypes` — orchestrator: `process`, `detect`, `getHandler`, `query`, `embedderInfo`, `ready`.
- `BaseHandler` (default) / `TreeSitterExtractor` (+ `walkDeepNode`, `collectRefs`, `setQueryContext`) / `AntlrExtractor` / `withExtractor` — the handler base-class ladder.
- `detect`, `discover`, `emptyRegistry` — detection + the scope-agnostic, trust-gated scan.
- `collectReferences` + `format`/`buildTree`/`renderTree`/`maxDepth`/`pruneToMaxDepth` — refs engine + outline primitives.
- `parseBodyMatcher`, `queryRegex`/`queryGlob`/`queryJsonpathObject`/`queryXpathString`, `projectJsonToXml`, `buildJsonOutline` — query primitives.
- `UnsupportedDialectError`/`InvalidExpressionError`/`QueryParseFailureError`/`GrammarNotInstalledError` — error classes with `toTelemetryEvent()`.
- `runCompile`/`rewriteImports`/`injectBaseImports` — ANTLR build utilities.
- Subpath `@plurnk/plurnk-mimetypes/conformance` — `assertHandlerConformance` + conformance types (kept off the main entry so `node:assert` stays out of the runtime bundle).
- Contract types: `MimeSymbol`, `SymbolKind`, `MimeRef`, `RefKind`, `Channel`, `HandlerMetadata`, `HandlerContent`, `ProcessInput`/`ProcessOptions`/`ProcessResult`, `RefsQuery`/`RefsQueryCapture`/`RefsCaptureNode`/`QueryConstructor`, `Discovery`/`DiscoverOptions`/`HandlerInfo`/`Registry`, `QueryDialect`/`QueryMatch`, `TreeSitterTree`/`TreeSitterNode`/`TreeSitterParser`/`DeepTreeNode`, `TelemetryEvent`.

## CLI

```
npx plurnk-mimetypes-compile    # compile grammar/ → src/generated/ via antlr-ng, rewrite .js imports to .ts
```

Run from a handler repo's root.

## Development

```
npm install && npm run build && npm test
```

`test:lint` (`tsc --noEmit` — no biome/eslint), `test:unit`, `test:intg`, `test:conf` separately. License: MIT.
