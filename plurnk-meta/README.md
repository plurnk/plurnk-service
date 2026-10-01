# @plurnk/plurnk-meta

What plurnk's packages share that no single package owns: plugin discovery and trust, and the teaching material the service gives models.

**Membership primitives** (`import Meta from "@plurnk/plurnk-meta"`): shared family identity, trust, attribution, enumeration, and root resolution for capability scanners. [SPEC.md](./SPEC.md) owns the complete contract ({§plugin-discovery}).

- `Meta.declaresKind(manifest, kind)` — accepts one exact string family identity; arrays claim no family ({§plugin-family-kind}).
- `Meta.isTrusted(packageName, env?)` — the `PLURNK_PLUGINS_TRUSTED_ONLY` gate: `""`/`"0"` off; any value on, `@plurnk/*` always trusted plus a comma-separated allowlist. An unset key is answered by this package's own panel, which ships the gate on.
- `Meta.normalizeAttribution(raw, packageName)` — normalize an always-on package declaration, including the reserved `@plurnk/` namespace rule ({§plugin-attribution}).
- `Meta.runtimeAttribution(source, context, packageName)` — pull and normalize an optional synchronous plugin hook for one provider emission attempt.
- `Meta.composeAttributions(...lists)` — flatten, deduplicate, and sort opaque tag lists.
- `Meta.packageDirs(nodeModulesDir)` — scope-agnostic, symlink-aware enumeration across Node's ancestor resolution chain as `{ dir, name }` candidates; the nearest package name wins. Ordering and filtering are the caller's policy.
- `Meta.nearestNodeModules(fromDir)` — walk up to the nearest `node_modules` holding the ecosystem (witness: `@plurnk` scope); `null` when absent.

**The teaching corpus**: authored policy, an optional Recap, the Plurnk skill entry, and built-in scheme references resolved from this installed package. Meta owns the source bytes and membership; core owns admission, resource composition, and projection. See [`CORPUS.md`](./CORPUS.md) and {§teaching-corpus}.

Capability-library packages declare one `package.json#plurnk.kind`. Standard Agent Plugin bundles
instead put that same native declaration under `plugin.json#extensions.ai.plurnk`.
The capability's loader and lifetime stay unchanged; `kind: "module"` opts into the daemon lifecycle.
Native families use npm installation, with user plugin-folder loading also available for modules.
Never declare both. Shared manifest and filesystem
validation is exported from `@plurnk/plurnk-meta/agent-plugin`; the portable component loader remains
`@plurnk/plurnk-agent-plugins`. Native imports use the same operator trust gate.

An admitted capability package may declare always-on `plurnk.attribution` tags and its loaded object
may return per-attempt tags from `attributions(context)` ({§plugin-attribution}). MIT.
