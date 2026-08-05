# @plurnk/plurnk-mimetypes

Framework and contract for `@plurnk/plurnk-mimetypes-*` handler packages.
Consumers pass a path and/or inline body to `Mimetypes.process()` and receive the
detected mimetype plus exactly the requested projections.

## Documentation

- [`SPEC.md`](./SPEC.md) — the authoritative author-facing contract. This README is the orientation.
- Monorepo siblings: [contracts](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts), [execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs), [providers](https://github.com/plurnk/plurnk-service/tree/main/plurnk-providers), and [schemes](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes).

## Install

```
npm install @plurnk/plurnk-mimetypes
```

Node ≥ 26, ESM. The framework is intentionally lean: it supplies detection,
discovery, projection, and authoring APIs without installing its leaf
consumers. Direct users install the format handlers and artifacts they want;
the default `@plurnk/plurnk-service` installation declares its standard set.

Tree-sitter language grammars remain independent WASM leaves. Install only the
languages you need; discovery already carries their detection metadata.

```
npm install @plurnk/plurnk-mimetypes-grammar-python   # one language
```

Third-party handler packages are independent in the same way: installing a leaf
is sufficient for discovery to register its declarations, subject to the shared
trust gate.

Detection recognizes registry languages independently of grammar-leaf
installation. Adding or removing a leaf changes structural availability without
changing detection code. A detected mimetype whose grammar isn't installed
**degrades**: `ok` stays true, metadata is real, requested channels come back
empty, and the missing package is on `ProcessResult.grammarMissing`. Pass
`{ strict: true }` to throw `GrammarNotInstalledError` instead.

## Write a handler

Ship a handler by publishing a package — **under any scope** (`@acme/whatever`; discovery keys on `plurnk.kind`, not the `@plurnk` scope) — that declares its mimetypes and default-exports a `BaseHandler` subclass.

### 1. Declare in `package.json`

```json
{
  "name": "@acme/acme-mime-cobol",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "plurnk": {
    "kind": "mimetype",
    "handlers": [
      { "name": "text/x-cobol", "revision": "1", "glyph": "🗄", "extensions": [".cbl", ".cob"] }
    ]
  }
}
```

One package may declare many handlers; each `handlers[]` entry registers
independently. Increment its required `revision` whenever code or dependencies
can change projection output. Add `"binary": true` at the top of the `plurnk` block for
byte-oriented formats. The framework then reads filesystem paths as
`Uint8Array`; inline callers supply the declared shape directly. Override
`toText()` when binary content has a readable regex/glob and embedding
projection. Automatic loading resolves the package root from the consumer
graph, so expose a condition-neutral root or `default` mapping. An `import`-only
root requires the consumer to inject a `HandlerLoader`
({§mimetype-package-resolution}).

### 2. Default-export a `BaseHandler` subclass

The framework instantiates one handler per mimetype, injecting `{ mimetype, glyph, extensions }` (`HandlerMetadata`), and calls only the channels a `process()` request asks for. Every channel has a working default — **override only what your algebra supports**:

| Override                      | Channel / purpose                                               | Default                           |
|-------------------------------|-----------------------------------------------------------------|-----------------------------------|
| `extractRaw(content)`         | `symbols`: structural definitions as `MimeSymbol[]`.            | `[]`                              |
| `deepJson(content)`           | `deepJson`: faithful JSONPath target.                           | `null`                            |
| `deepXml(content)`            | `deepXml`: faithful XPath target.                               | Projects deep JSON, then symbols. |
| `references(content)`         | `references`: classified symbol uses.                           | `[]`                              |
| `content(content)`            | Derived model-readable text and primary embed source.           | `undefined`                       |
| `validate(content)`           | Reject malformed input when validity is meaningful.             | No-op.                            |
| `query(...)` / `toText(...)`  | Body-matcher dispatch and readable-text projection.             | Standard four-dialect dispatch.   |
| `projectionConfiguration()`   | Canonical effective settings that can change projection output. | `""`                              |

`validate()` rejects malformed source; `Mimetypes.process()` wraps that cause
as `MimetypeInputError`. A channel with no applicable projection returns its
declared empty value. A projection-specific source rejection may throw
`MimetypeInputError`; every other channel exception is an implementation or
operational failure and propagates.

```ts
import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

export default class TextCobol extends BaseHandler {
    extractRaw(content: string): MimeSymbol[] {
        return [/* structural declarations */];
    }
}
```

### 3. Pick a parser backend

1. **tree-sitter, clean WASM** — in-registry via framework PR. Most languages.
2. **tree-sitter, own WASM** — `extends TreeSitterExtractor`, commit a built `.wasm` from a pinned grammar commit. `references()` is ~3 lines via the base `collectRefs()` helper ({§mimetype-references}).
3. **ANTLR** — vendor `.g4` in `grammar/`, run `npx plurnk-mimetypes-compile`, `extends AntlrExtractor`. `antlr4ng` ships with the framework; `antlr-ng` is your devDep (the only optional peer).
4. **hand-roll** — `extends BaseHandler` and scan directly. Justify in your README; the bar is high.

Use [the Markdown handler](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes-text-markdown) as a production example.

### Certify your references channel

If you emit `references()`, certify it against {§mimetype-references} through
the `@plurnk/plurnk-mimetypes/conformance` subpath:

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
// r.totalLines  source line count  r.ok

await m.dispose(); // when this owner shuts down
```

Channels materialize per call; unrequested fields are absent. `channels: []` is
the metadata-only call. Embedding inference is opt-in even though the default
service composition installs its artifact. Body-matcher queries use
`m.query(input, expr)` for regex, glob, JSONPath, and XPath. `format()` renders
an unbudgeted human outline. Failure behavior is owned by
{§mimetype-error-policy}.

## Discovery & trust

Default `discover()` scans every package under `<cwd>/node_modules` for the
exact string `plurnk.kind === "mimetype"`, returning
`{ registry, handlers, skipped }`. It reads declarations and applies trust
before importing handler code.

- **Scope-agnostic.** Publish under your own scope and the host's scan finds it like a first-party handler — no bundle membership, no registration.
- **Trust gate.** Discovery enforces the metaproject's shared pre-import predicate and preserves withheld package names in `skipped` for the consumer to present ({§plugin-trust-boundary}).
- **Failure boundary.** Non-mimetype packages are ignored; malformed trusted declarations and registered handler load failures throw `MimetypePluginError` with plugin identity and causal evidence ({§mimetype-plugin-failure}).
- **Default ordering.** Third-party packages are sorted first and `@plurnk` packages last; later declarations win, so the default scan protects the standard handlers from shadowing.
- **Explicit ordering.** `packageDirs` bypasses default enumeration and preserves caller order; later declarations still win.

## Public surface

| Family              | Root exports                                                                                                               |
|---------------------|----------------------------------------------------------------------------------------------------------------------------|
| Orchestration       | `Mimetypes`: discovery, detection, processing, querying, classification, projection identity, artifact seams, lifecycle.   |
| Handler authoring   | `BaseHandler`, parser extractors, `withExtractor`, parser-coordinate materializers, and tree/reference primitives.         |
| Detection/discovery | `detect`, `discover`, `emptyRegistry`, `MimetypePluginError`.                                                              |
| Query/projection    | Matcher and dialect primitives, JSON/XML projection, text coordinates, and typed query/coordinate failures.                |
| Classification      | `classifyMimetype`.                                                                                                        |
| Formatting          | `format`, `buildTree`, `renderTree`, `maxDepth`, `pruneToMaxDepth`.                                                        |
| Grammar build       | `runCompile`, `rewriteImports`, `injectBaseImports`.                                                                       |
| Types               | Public handler, discovery, projection, reference, coordinate, Notice, embedding, and tokenizer types.                      |

The `@plurnk/plurnk-mimetypes/conformance` subpath exports the handler and
query-evidence conformance harnesses without pulling `node:assert` into the
runtime entry point. Only the root and declared subpaths are public
({§mimetype-public-api}).

## CLI

```
npx plurnk-mimetypes-compile    # compile grammar/ → src/generated/ via antlr-ng, rewrite .js imports to .ts
```

Run from a handler package's root.

## Development

```
npm install && npm run build && npm test
```

`test:lint` (`tsc --noEmit` — no biome/eslint), `test:unit`, `test:intg`, `test:conf` separately. License: MIT.
