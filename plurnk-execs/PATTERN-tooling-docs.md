# Model-facing tooling-docs convention

A portable pattern, prototyped in plurnk-execs (plurnk-execs#7 + this round), for how a
**model-facing plugin family** surfaces its self-documentation into the model's context.
This is a **convention to follow, not a shared type to import** — each family keys on its
own unit and renders its own cardinality. The alignment is in the URI shape, the
skeleton-from-registry resolver, and the sheet-line format; not in shared code.

## Who this applies to

Only families the **model directly wields as ops**:

- **execs** — the model emits `EXEC[tag]:…:EXEC`; each tag is a tool. ✅ (reference impl)
- **schemes** — the model emits `READ`/`FIND`/`EDIT`/`SEND`/… against a scheme; each
  (scheme × op) cell is a tool. ✅ (next adopter)

Not **mimetypes** (handlers invoked by the substrate, not the model) and not **providers**
(the model *is* the provider). Neither is dispatched by the model, so neither injects
tooling docs.

## The convention

1. **Manifest declares two optional fields per capability:**
   - `example` — a one-line, self-documenting usage example. Stored **bare** (no `<<`).
   - `documentation` — full markdown: flags, modes, gotchas the one-liner can't carry.
2. **Discovery flows both through the family's info struct** (`ExecInfo` here; `SchemeInfo`
   for schemes), defaulting to `""`. The framework carries the data; the consumer renders.
3. **Hot-path sheet line pairs them:**
   ```
   * plurnk://<family>/<id>.md - <<EXEC[qbasic]:ECHO "Hello World":EXEC
   ```
   The `<<` is prepended **at render time** (the stored `example` is bare), so the sheet
   matches how ops already render in the log. One line per *available* capability — the
   example to vibe off, the link for depth. The full `documentation` is **never** in the
   sheet (it scales with installed capabilities and torpedoes the token budget).
4. **The doc lives behind a readable resource:** `plurnk://<family>/<id>.md`, resolved from
   the registry. The model READs it on demand when it commits to a non-trivial capability —
   reusing READ, no new op. The resolver **skeletons a baseline doc from registry metadata**
   (id, example, declared channels/mimetypes, effect/gating, availability) and appends the
   author's `documentation` when present, so the link **never 404s** even for a capability
   that authored no prose. Author opts into depth; the floor is free.

## Why it's a convention, not a shared type

The *cardinality* differs enough that a shared `ToolingDoc` type would contort both:

| | unit (the "tool") | examples per id | doc resource |
|---|---|---|---|
| **execs** | a tag (flat namespace) | **one** (`EXEC[tag]:…`) | `plurnk://execs/<tag>.md` |
| **schemes** | a scheme × op cell (a grid) | **per op** the scheme implements | `plurnk://schemes/<scheme>.md` |

execs honestly has one example per tag, so its `example` is a single string — pre-building
"one-or-more examples per id" to pre-fit schemes would be exactly the just-in-case
generality we don't do. Schemes keys on the scheme (its ops are cohesive; its static
manifest already enumerates channels/category once), with an example *per op it supports*.
Same convention, different unit.

## Instance injection is NOT shared

execs injects `{ runtime, glyph }` into each executor instance because it's **multi-identity**
(one package, many tags — the instance must know which tag it is). Schemes is
**single-identity per handler** (one scheme per class, `new ()` with no args), so it declares
`example`/`documentation` directly in its **static `SchemeManifest`** — no constructor
injection. The injection the two families *share* is the **model-facing** one (the sheet line
+ the doc resource); the instance-facing one is execs-specific and schemes must not copy it.

## Schemes adoption sketch

- Add `example?: string` **per op** and `documentation?: string` **per scheme** to
  `SchemeManifest` (static, no injection).
- `SchemeInfo` carries them through discovery.
- Engine's tools-sheet hook emits, for each available scheme, one line per supported op:
  `* plurnk://schemes/<scheme>.md - <<READ <scheme>://…`.
- A `plurnk://schemes/<scheme>.md` resolver skeletons from the static manifest (name,
  channels, category, scope, writableBy, supported-ops = the implemented methods) and
  appends the scheme's `documentation`.

The optional-method-as-capability contract means a scheme already declares its op surface by
which methods it implements — the skeleton reads that directly, no second list to drift.
