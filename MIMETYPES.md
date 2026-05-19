# MIMETYPES.md

Contract for `@plurnk/plurnk-mimetypes-*` packages. Audience: implementer of a mimetype handler. Companion contracts: SCHEMES.md (URI handlers), PROVIDERS.md (LLM transports). Engine surface: SPEC.md.

---

## §1 Role

A mimetype handler interprets channel content for render-time packet assembly. Three methods:

- `validate(content)` — assert well-formed; throw on violation.
- `symbols(content)` — extract structural summary.
- `preview(content, budget)` — render budget-bounded interpretation.

Pure. Stateless. No IO. No access to engine, database, filesystem, network, subprocess, or peer handlers. Invoked at render time; the `preview` result lands in `packet.system.index[].channels[name].content`. SPEC §4 {§4-handlers-fire-render-time}.

---

## §2 Manifest

`package.json`:

```json
{
    "name": "@plurnk/plurnk-mimetypes-<name>",
    "plurnk": {
        "kind": "mimetype",
        "name": "<canonical mimetype>"
    }
}
```

- `kind` MUST be `"mimetype"`.
- `name` is the canonical mimetype. Use IANA where registered (`text/markdown`, `application/json`). Domain types use `application/vnd.<vendor>.<subtype>` per RFC 6838.

Default export: a class implementing `PlurnkMimetype` (§3). Singleton — engine constructs once at boot, reuses for every call.

Collision on `(kind: "mimetype", name)` at discovery: fail-hard. SPEC §9.

---

## §3 Interface

```ts
interface MimetypeHandler {
    readonly mimetype: string;
    readonly glyph: string;
    validate(content: string): void;
    symbols(content: string): string;
    preview(content: string, budget: number): string;
}
```

Duck-typed contract. The interface lives in `src/mimetypes/_types.ts` for in-tree handlers; external packages implement the shape without importing the type (avoids the circular `@plurnk/plurnk-service` → external → service dependency). Identity is enforced at registration via `package.json#plurnk.name` matching `instance.mimetype`.

### §3.1 Identity fields

| Field | Constraint |
|---|---|
| `mimetype` | MUST equal `package.json#plurnk.name`. Engine throws on mismatch at registration. |
| `glyph` | Single grapheme cluster. Used in model-facing tile labels. |

### §3.2 `validate(content): void`

Render-time well-formedness check.

- Returns `void` on valid content.
- Throws on invalid content. Error message identifies the violation (line/column where applicable).
- Pure. Deterministic. Synchronous.

Engine catches thrown errors and routes through the fail-hard path (SPEC §4.2). Schemes do NOT pre-validate at write time.

Trivially-valid types: `validate(_) {}`. Do not omit the method.

### §3.3 `symbols(content): string`

Structural extraction.

- Returns a string. Empty when no structural view applies.
- Pure. Deterministic. Synchronous. Not budget-bounded.

Engine invokes `symbols` directly when it wants the structural view alone (e.g., a `symbols` channel of a code file). `preview` MAY use `symbols` internally as a render strategy.

Typical content:

| Mimetype | symbols output |
|---|---|
| `text/markdown` | Indented heading list. |
| `application/json` | Key tree, depth-bounded. |
| `text/typescript` | Exported symbol list. |
| `text/vnd.plurnk` | Op summary. |
| `text/plain` | `""`. |

### §3.4 `preview(content, budget): string`

Budget-bounded interpretation.

- Returns a string, length ≤ `budget` (soft hint, not enforced).
- Pure. Deterministic. Synchronous.
- Empty input → empty output. Non-empty input → non-empty output (at minimum a head truncation).

The load-bearing render-time method. Invoked for every visible channel on every turn. SPEC §4 / §5.1.

Common implementation pattern:

```
result = symbols(content)
if result.length == 0: result = content
if result.length > budget: result = result.slice(0, budget)
return result
```

Handler MUST NOT memoize. Engine owns the cache.

### §3.5 Budget unit

Currently character count. Env var: `PLURNK_ENTRY_SIZE_DEFAULT_TOKENS` (named for the future direction; current semantics are character-count). Handlers MUST treat budget as `number`, smaller = shorter output. Do not bake unit assumptions deeper.

---

## §4 Engine → handler guarantees

- Content reaches the handler already at rest in the database. Whatever the scheme validated at write time has happened; handler's `validate` is the render-time check.
- Calls per handler are sequential per channel. No concurrent invocation against shared state — there is no shared state.
- Exceptions from `validate` are caught and route through fail-hard. Exceptions from `symbols` or `preview` are NOT caught — they crash the turn loudly. Implementations MUST NOT throw from `symbols` or `preview` for any input the contract permits.
- Constructor receives no arguments. Engine instantiates once at boot.

---

## §5 Handler → engine guarantees

- **Purity.** `symbols(x)` and `preview(x, b)` return identical output across invocations. `validate(x)` returns identical outcome.
- **No state.** No instance fields beyond `readonly mimetype` and `readonly glyph`. No module-level mutable state. No internal cache.
- **No IO.** No filesystem, network, database, subprocess, console, env.
- **No reaching.** No imports from `@plurnk/plurnk-service`. Sanctioned imports: `node:` built-ins, pure-function NPM dependencies. The `MimetypeHandler` interface is duck-typed (don't import it — implement the shape; identity-match at boot verifies).
- **Synchronous.** No `Promise`, no `async`, no timers.
- **No throwing from `symbols`/`preview`.** Use stub strings for refusal cases.

---

## §6 Forbidden

| ❌ |
|---|
| Filesystem access |
| Network access |
| Database access (`node:sqlite`, `@possumtech/sqlrite`, raw connections) |
| Subprocess spawning |
| Environment variable reads |
| `setTimeout` / `setInterval` / `setImmediate` |
| `Promise` chains, `async` keywords |
| Imports from `@plurnk/plurnk-service/*` |
| Internal memoization or caching |
| Mutation of input strings |
| `console.log` / `console.error` / any stdout/stderr write |
| Inter-handler state |

---

## §7 Reference — `text/plain` (bundled in plurnk-service)

`src/mimetypes/TextPlain.ts` — the universal fallback. Bundled rather than extracted because every deployment needs it and it has no external dependency.

```ts
import type { MimetypeHandler } from "./_types.ts";

export default class TextPlain implements MimetypeHandler {
    readonly mimetype = "text/plain";
    readonly glyph = "📄";

    validate(_content: string): void {}

    symbols(_content: string): string {
        return "";
    }

    preview(content: string, budget: number): string {
        return content.length <= budget ? content : content.slice(0, budget);
    }
}
```

---

## §8 Reference — `@plurnk/plurnk-mimetypes-text-markdown` (sibling repo)

Lives at [github.com/plurnk/plurnk-mimetypes-text-markdown](https://github.com/plurnk/plurnk-mimetypes-text-markdown). Validates the "bundle minimally" pattern: first real plugin extraction (#47). plurnk-service depends on it via npm; Daemon's plugin discovery scan registers it at boot.

External package, so no interface import — duck-typed against the contract:

```ts
export default class TextMarkdown {
    readonly mimetype = "text/markdown";
    readonly glyph = "📝";

    validate(_content: string): void {}

    symbols(content: string): string {
        const headings: string[] = [];
        for (const line of content.split("\n")) {
            const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
            if (match === null) continue;
            const indent = "  ".repeat(match[1].length - 1);
            headings.push(`${indent}${match[2]}`);
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

---

## §9 Conformance

`@plurnk/plurnk-mimetype-conformance` (TBD) verifies:

1. `instance.mimetype === packageJson.plurnk.name`.
2. `instance.glyph` is a non-empty string ≤ 4 chars (one grapheme cluster).
3. `validate("")` returns void without throwing.
4. `validate` is deterministic across 100 invocations.
5. `symbols(x)` returns a string for arbitrary `x`. Non-throwing.
6. `preview(content, 0)` returns a string ≤ ~4 chars.
7. `preview(content, ∞)` returns a string ≤ `content.length`.
8. `preview(c, b)` is deterministic across 100 invocations.
9. No filesystem, network, env, or subprocess access during the pack.
10. All methods return synchronously. No unresolved Promises after pack completion.

Mimetype-specific behavioral tests (heading extraction correctness, JSON tree depth, etc.) live in the package's own test surface.

---

## §10 Bundled vs sibling

Plurnk-service bundles only the universal fallback:

| Path | Mimetype |
|---|---|
| `src/mimetypes/TextPlain.ts` | `text/plain` |

Sibling repos we own:

| Package | Mimetype |
|---|---|
| `@plurnk/plurnk-mimetypes-text-markdown` | `text/markdown` |

Future packages, expected:

| Package | Mimetype |
|---|---|
| `@plurnk/plurnk-mimetypes-application-json` | `application/json` |
| `@plurnk/plurnk-mimetypes-text-vnd-plurnk` | `text/vnd.plurnk` |
| `@plurnk/plurnk-mimetypes-text-typescript` | `text/typescript` |

---

## §11 Open

- **Budget unit.** Character count today. May switch to tokens. Interface signature is `budget: number` — no unit assumption in handler math beyond ordering.
- **Structured returns.** All methods return `string`. Structured returns (e.g., JSON tree as object) would land as additive method `tree(content): unknown`, not by changing existing signatures.
- **Wildcards.** Not supported. One handler per concrete mimetype. Family fallback (e.g., unknown `text/*` → `text/plain`) is engine-side dispatch logic, not handler responsibility.
- **Write-time validation.** Scheme concern, not mimetype handler concern.
- **Memoization.** Engine-side. Keyed by `(mimetype, content_hash, budget)`. Handler MUST NOT memoize.
