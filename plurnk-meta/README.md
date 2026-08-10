# @plurnk/plurnk-meta

The plurnk metaproject layer, published — what the family shares that no single member owns.

**Membership primitives** (`import Meta from "@plurnk/plurnk-meta"`): the shared implementation of exact family identity, trust, attribution normalization, enumeration, and root resolution consumed by the four family-owned scanners (schemes, mimetypes, providers, execs). [SPEC.md](./SPEC.md) owns the complete contract ({§plugin-discovery}).

- `Meta.declaresKind(manifest, kind)` — accepts one exact string family identity; arrays claim no family ({§plugin-family-kind}).
- `Meta.isTrusted(packageName, env?)` — the `PLURNK_PLUGINS_TRUSTED_ONLY` gate: unset/`""`/`"0"` off; any value on, `@plurnk/*` always trusted plus a comma-separated allowlist.
- `Meta.normalizeAttribution(raw, packageName)` — normalize an always-on package declaration, including the reserved `@plurnk/` namespace rule ({§plugin-attribution}).
- `Meta.runtimeAttribution(source, context, packageName)` — pull and normalize an optional synchronous plugin hook for one provider emission attempt.
- `Meta.composeAttributions(...lists)` — flatten, deduplicate, and sort opaque tag lists.
- `Meta.packageDirs(nodeModulesDir)` — scope-agnostic, symlink-aware enumeration across Node's ancestor resolution chain as `{ dir, name }` candidates; the nearest package name wins. Ordering and filtering are the caller's policy.
- `Meta.nearestNodeModules(fromDir)` — walk up to the nearest `node_modules` holding the ecosystem (witness: `@plurnk` scope); `null` when absent.

**The teaching corpus**: authored policy, a compact Recap, built-in scheme, and conditional question sources resolved from this installed package. Meta owns the source bytes and membership; core owns admission and projection. See [`CORPUS.md`](./CORPUS.md) and {§teaching-corpus}.

**Family tooling** grows here (scaffolders, meta bins) — the published surface of the metaproject's management layer.

[`DOGFOOD.md`](./DOGFOOD.md) defines the whole-product, outside-client acceptance gate for daily-driver and release readiness.

Third-party plugin authors: your package is discovered under any scope through one string `plurnk.kind`, enumerated by these primitives, and gated before import by the operator's trust knob — no registration with us required. An admitted package may declare always-on `plurnk.attribution` tags and its loaded plugin object may decide per provider attempt whether to return additional tags from `attributions(context)` ({§plugin-attribution}). MIT.
