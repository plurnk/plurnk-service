# @plurnk/plurnk-meta

What plurnk's packages share that no single package owns: extension discovery and trust, and the teaching material the service gives models.

**Membership primitives** (`import Meta from "@plurnk/plurnk-meta"`): shared kind identity, trust, attribution, enumeration, and root resolution for each kind's scanner. [SPEC.md](./SPEC.md) owns the complete contract ({§extension-discovery}).

- `Meta.declaresKind(manifest, kind)` — accepts one exact string kind identity ({§extension-kind}).
- `Meta.isTrusted(packageName, env?)` — the `PLURNK_EXTENSIONS_TRUSTED_ONLY` gate: `""`/`"0"` off; any value on, `@plurnk/*` always trusted plus a comma-separated allowlist. An unset key is answered by this package's own panel, which ships the gate on.
- `Meta.normalizeAttribution(raw, packageName)` — normalize an always-on package declaration, including the reserved `@plurnk/` namespace rule ({§extension-attribution}).
- `Meta.runtimeAttribution(source, context, packageName)` — pull and normalize an extension's optional synchronous `attributions` function for one provider emission attempt.
- `Meta.composeAttributions(...lists)` — flatten, deduplicate, and sort opaque tag lists.
- `Meta.packageDirs(nodeModulesDir)` — scope-agnostic, symlink-aware enumeration across Node's ancestor resolution chain as `{ dir, name }` candidates; the nearest package name wins. Ordering and filtering are the caller's policy.
- `Meta.nearestNodeModules(fromDir)` — walk up to the nearest `node_modules` holding the ecosystem (witness: `@plurnk` scope); `null` when absent.

**The teaching corpus**: authored policy, an optional Recap, the Plurnk skill entry, and built-in scheme references resolved from this installed package. Meta owns the source bytes and membership; core owns admission, resource composition, and projection. See [`CORPUS.md`](./CORPUS.md) and {§teaching-corpus}.

Extension packages declare one `package.json#plurnk.kind`. Standard Agent Plugin bundles
instead put that same declaration under `plugin.json#extensions.ai.plurnk`.
The kind's loader and lifetime stay unchanged; `kind: "module"` opts into the daemon lifecycle.
Extensions install through npm, with user plugin-folder loading also available for modules.
Never declare both. Shared manifest and filesystem
validation is exported from `@plurnk/plurnk-meta/agent-plugin`; the portable component loader is
`@plurnk/plurnk-agent-plugins`. Extension imports use the same operator trust gate.

An admitted extension package may declare always-on `plurnk.attribution` tags and its loaded object
may return per-attempt tags from `attributions(context)` ({§extension-attribution}). MIT.
