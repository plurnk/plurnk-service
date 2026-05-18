# MIMETYPES.md — Plurnk Mimetype Handler Contract

The specification for `@plurnk/plurnk-mimetypes-*` packages. The audience is anyone authoring a mimetype handler — bundled or third-party. The surface is small by design: a mimetype handler is a pure interpreter of bytes, not an actor in the system. Other contracts:

- **SCHEMES.md** — URI handlers (stateful, hold entries, drive ops).
- **PROVIDERS.md** — LLM transports (wire protocols).
- **SPEC.md** — the engine, packet, storage, and RPC surfaces these contracts plug into.

---

## §1 What a mimetype handler is

A mimetype handler interprets channel content for the engine's render-time packet assembly. Given a string of content and a budget, it produces three views:

- **`validate(content)`** — assert the content is well-formed under this mimetype.
- **`symbols(content)`** — extract a structural summary (heading outline, key tree, function list).
- **`preview(content, budget)`** — render a budget-bounded interpretation suitable for the model's index tile.

That is the entire contract. The handler is a pure function over its inputs. It does not own state. It does not touch the engine, the database, the filesystem, the network, or any other handler. It is invoked, it produces, it returns.

The engine invokes handlers at packet assembly time (SPEC §4 {§4-handlers-fire-render-time}). Each visible channel's stored content passes through its mimetype handler's `preview(content, budget)`; the result is what the model sees in `packet.system.index[].channels[name].content` for that turn.

---

## §2 Manifest

Each mimetype handler ships as an npm package matching `@plurnk/plurnk-mimetypes-<name>` with `package.json#plurnk` declaring:

```json
{
    "name": "@plurnk/plurnk-mimetypes-text-markdown",
    "plurnk": {
        "kind": "mimetype",
        "name": "text/markdown"
    }
}
```

- **`kind`** MUST be `"mimetype"`.
- **`name`** is the canonical mimetype identifier. Use the IANA registered type where one exists (`text/markdown`, `application/json`). For domain-specific types use the `application/vnd.<vendor>.<subtype>` namespace per RFC 6838 (`application/vnd.plurnk`).

The package's default export is a class implementing `PlurnkMimetype` (see §3). The engine instantiates it once at boot and reuses the instance — handlers are singletons.

Collisions on `(kind: "mimetype", name)` at plugin discovery are **fail-hard at boot** per SPEC §9. Two packages claiming `text/markdown` is a configuration error; the engine throws.

---

## §3 The interface

```ts
export interface PlurnkMimetype {
    readonly mimetype: string;
    readonly glyph: string;
    validate(content: string): void;
    symbols(content: string): string;
    preview(content: string, budget: number): string;
}
```

### §3.1 Fields

- **`mimetype: string`** — the canonical name. MUST match the manifest's `plurnk.name`. The engine checks the match at registration and throws on mismatch.
- **`glyph: string`** — a one-character visual marker used in model-facing rendering when the engine wants to compactly label a tile by mimetype. Choose something visually distinctive. Bundled examples: `📝` (markdown), `📄` (plain text), `🧾` (JSON), `🧪` (custom/test).

### §3.2 `validate(content): void`

Assert that `content` is well-formed under this mimetype.

**Promises:**
- Returns `void` on valid content.
- Throws an `Error` (or subclass) on invalid content. The error message SHOULD identify the violation precisely (line/column where applicable).
- Pure: no side effects, no allocation beyond what's needed to inspect.
- Deterministic: same input → same outcome.

**When it fires:** render time. The engine calls `validate` as part of packet assembly for each visible channel whose mimetype this handler owns. A thrown error crashes the engine loudly per the fail-hard discipline (SPEC §4.2). Schemes do NOT pre-validate at write time; if write-time validation is desirable, the scheme owns it as part of its own contract.

**For the trivially-valid case** (e.g., `text/plain` accepts any string), the body is `{}` — explicit no-op. Do not omit the method.

### §3.3 `symbols(content): string`

Extract a structural view of the content. For text-bearing structured types, this is the natural outline:

- `text/markdown` → indented heading list.
- `application/json` → key tree (with depth bound).
- `text/javascript`, `text/typescript` → exported symbol list.
- `text/vnd.plurnk` → op summary.

**Promises:**
- Returns a `string` (possibly empty when no structural extraction is meaningful, e.g., for `text/plain`).
- Pure: no side effects.
- Deterministic: same input → same output.
- Not budget-bounded; the engine never invokes `symbols` directly into a budget-constrained context. `preview` is the budget gate.

**When it fires:** invoked by the engine when it wants the structural view directly (e.g., for the symbols channel of a code file). The handler's own `preview` MAY internally use `symbols` to short-circuit to outline-style output; that's the handler's call.

### §3.4 `preview(content, budget): string`

Render a budget-bounded interpretation suitable for the model's index tile.

**Promises:**
- Returns a `string`, length-bounded by `budget` (interpreted as a character-count hint; see §3.5).
- Pure: no side effects.
- Deterministic: same `(content, budget)` → same output.
- The handler does its best to fit within budget. If the content is structurally hard to compress (a single long line, a binary-encoded blob), the handler MAY return a string slightly over budget; the engine treats this as a hint, not a hard ceiling.
- Returns an empty string only when the content is empty. For non-empty content, return something — even a budget-truncated head suffices.

**When it fires:** every packet assembly, for every visible channel. This is the load-bearing render-time method (SPEC §4 / §5.1).

**Implementation guidance:**
- For text-bearing structured types, the typical implementation is: `result = symbols(content)`, then truncate to budget if `result.length > budget`; if `symbols` returns empty, fall back to head-truncation of `content` itself.
- Memoization is the engine's concern, not the handler's. Do not cache internally — handler instances are reused across calls and a stale cache would corrupt unrelated channels.

### §3.5 Budget unit

`budget` is a character count. Future revisions MAY switch to a token unit; until then handlers SHOULD treat it as a soft character-count cap. The default budget is from `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` (named for the future direction, despite the current character-count semantics).

---

## §4 Promises the engine makes to handlers

- Handlers receive content that has already passed through whatever validation the scheme performed at write time. The handler's `validate` is the engine-side render-time check, not the only check.
- Handlers are invoked sequentially per channel per turn; a handler will not be invoked concurrently against the same content (each call has its own arguments).
- The engine catches exceptions from `validate` and routes them through the fail-hard path. Exceptions from `symbols` or `preview` are NOT caught — they propagate and crash the turn loudly. Handlers MUST NOT throw from `symbols` or `preview` for any input the contract permits; if they need to refuse, they return a stub string.
- The handler instance is constructed once at boot and reused. The constructor receives no arguments.

---

## §5 Promises handlers make to the engine

- **Purity.** `symbols(x)` and `preview(x, b)` return the same value every time. `validate(x)` returns the same outcome every time.
- **No state.** No instance fields beyond the readonly identity fields (`mimetype`, `glyph`). No module-level mutable state. No caches.
- **No IO.** No filesystem, network, database, process spawning, or `console` output.
- **No reaching.** No imports from `@plurnk/plurnk-service` internals. The only sanctioned imports are: `node:` built-ins; pure-function NPM dependencies (parsers, ASTs, tokenizers); types from `@plurnk/plurnk-grammar`. Anything else is suspect.
- **No mutation.** Input strings are not mutated. Output strings do not share references with inputs in surprising ways.
- **No throwing from `symbols` or `preview`.** Use stub strings for refusal cases; never throw.

---

## §6 What handlers MUST NOT do

The anti-promises are the discipline that lets the engine treat handlers as black-box functions:

- ❌ Read or write any file.
- ❌ Open any network connection (HTTP, WebSocket, DNS).
- ❌ Touch the database. No `node:sqlite`, no SqlRite, nothing.
- ❌ Spawn subprocesses.
- ❌ Read environment variables. (If a handler needs configuration, it goes through the constructor or a static field — but no bundled handler needs configuration, and we'd be skeptical of one that did.)
- ❌ Use `setTimeout`, `setInterval`, `setImmediate`, `Promise` chains. Handlers are synchronous. The engine awaits no handler call.
- ❌ Reach into `@plurnk/plurnk-service` source. Handlers ship against the published interface from `@plurnk/plurnk-grammar`; that is the sole contract surface.
- ❌ Memoize results. The engine caches at the appropriate layer; handlers do not.
- ❌ Mutate or store anything across calls.

---

## §7 Worked example — `@plurnk/plurnk-mimetypes-text-plain`

```ts
import type { PlurnkMimetype } from "@plurnk/plurnk-grammar";

export default class TextPlain implements PlurnkMimetype {
    readonly mimetype = "text/plain";
    readonly glyph = "📄";

    validate(_content: string): void {
        // Every string is valid text/plain.
    }

    symbols(_content: string): string {
        // No structural view for unstructured text.
        return "";
    }

    preview(content: string, budget: number): string {
        return content.length <= budget ? content : content.slice(0, budget);
    }
}
```

That is the complete implementation. The package's `package.json` declares the manifest; the file above is the entire runtime surface.

---

## §8 Worked example — `@plurnk/plurnk-mimetypes-text-markdown`

```ts
import type { PlurnkMimetype } from "@plurnk/plurnk-grammar";

export default class TextMarkdown implements PlurnkMimetype {
    readonly mimetype = "text/markdown";
    readonly glyph = "📝";

    validate(_content: string): void {
        // Any string is valid markdown.
    }

    symbols(content: string): string {
        const lines = content.split("\n");
        const headings: string[] = [];
        for (const line of lines) {
            const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
            if (match === null) continue;
            const level = match[1].length;
            const text = match[2];
            const indent = "  ".repeat(level - 1);
            headings.push(`${indent}${text}`);
        }
        return headings.join("\n");
    }

    preview(content: string, budget: number): string {
        const outline = this.symbols(content);
        const result = outline.length > 0 ? outline : content;
        return result.length <= budget ? result : result.slice(0, budget);
    }
}
```

Same shape. The interface is small enough that a handler is essentially its three method bodies plus a manifest.

---

## §9 Conformance

Any package claiming `kind: mimetype` is expected to pass the conformance test pack (`@plurnk/plurnk-mimetype-conformance`, package TBD). The pack verifies:

1. **Identity match.** `instance.mimetype === packageJson.plurnk.name`.
2. **Glyph present.** `instance.glyph` is a non-empty string ≤ 4 characters (one grapheme cluster).
3. **`validate(emptyString)` returns void without throwing.**
4. **`validate` is deterministic.** Same input across calls → same outcome.
5. **`symbols` returns a string.** Non-throwing, deterministic.
6. **`preview(content, 0)`** returns the empty string or a near-empty string (≤ a few characters).
7. **`preview(content, ∞)`** returns at most `content.length` characters of length (no allocation beyond input size).
8. **Determinism.** `preview(c, b) === preview(c, b)` across 100 invocations.
9. **No side effects.** Running the test pack against an instance does not modify the global environment, filesystem, or any observable state.
10. **No async leakage.** All methods return synchronously; there are no unresolved Promises after the test pack completes.

The conformance pack is the floor. Mimetype-specific behavioral tests (e.g., that `TextMarkdown.symbols` extracts headings correctly) live in the handler's own test surface.

---

## §10 Bundled reference set

Plurnk-service bundles two reference mimetype handlers as the minimum needed for the engine to run standalone:

- `src/mimetypes/TextPlain.ts` — `text/plain`, the unstructured-content fallback.
- `src/mimetypes/TextMarkdown.ts` — `text/markdown`, the default for `known`/`unknown`/`skill` body channels.

These are reference implementations. Third-party packages SHOULD treat them as the canonical examples of the shape; new packages SHOULD copy their structure and replace only the method bodies.

Future bundled or third-party packages expected to land:

- `@plurnk/plurnk-mimetypes-application-json` — JSON key-tree structural view.
- `@plurnk/plurnk-mimetypes-text-vnd-plurnk` — plurnk DSL op summary (depends on grammar #6).
- `@plurnk/plurnk-mimetypes-text-typescript` — exported-symbol list, when needed for code-aware schemes.

---

## §11 Design notes (open questions, explicit non-decisions)

- **Budget unit is character count.** A future revision MAY switch to tokens. The interface signature is `budget: number` — handlers should not encode an assumption about the unit in their math beyond "smaller number means shorter output."
- **No structured return types.** `symbols` and `preview` return `string`, not a structured AST. If a future need surfaces for structured output (e.g., a UI client wants the JSON key tree as actual JSON), it will land as an additive method like `tree(content): unknown`, not by changing the existing signatures.
- **No content-type negotiation.** A handler owns exactly one mimetype name. Wildcards (`text/*`) are not supported. Use the textual-vs-binary classifier in the engine if dispatch needs to fall back on a family default; handler instances stay 1:1 with concrete mimetypes.
- **No write-time validation.** The handler's `validate` is render-time. Schemes that want write-time validation own that themselves (e.g., the `file://` scheme might syntax-check JSON before persisting, but it does so independently of the mimetype handler).
- **Memoization is engine-side.** The engine MAY cache `preview` results keyed by `(mimetype, content_hash, budget)`. Handlers MUST NOT memoize internally; doing so defeats the engine's cache invalidation strategy and risks staleness.
