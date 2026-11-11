# @plurnk/plurnk-meta

What plurnk's packages share that no single package owns: first-party extension discovery, Agent Plugins format primitives, environment knob readers, and the teaching material the service gives models.

**Membership primitives** (`import Meta from "@plurnk/plurnk-meta"`): shared kind identity, first-party `@plurnk/*` manifest discovery, attribution, enumeration, and root resolution for each kind's scanner. [SPEC.md](./SPEC.md) owns the complete contract ({§extension-discovery}).

- `Meta.declaresKind(manifest, kind)` — accepts one exact string kind identity (`exec`, `mimetype`, `provider`, `scheme`; {§extension-discovery}).
- `Meta.readManifest(dir, kind?, options?)` — reads `package.json#plurnk` for `@plurnk/*` packages and returns `null` for anything else ({§extension-discovery}).
- `Meta.scanKind(kind, options?)` — scans installed `@plurnk/*` packages (or explicit `packageDirs`) for one extension kind ({§extension-discovery}).
- `Meta.normalizeAttribution(raw, packageName)` — normalize an always-on package declaration, including the reserved `@plurnk/` namespace rule ({§extension-discovery}).
- `Meta.runtimeAttribution(source, context, packageName)` — pull and normalize an extension's optional synchronous `attributions` function for one provider emission attempt.
- `Meta.composeAttributions(...lists)` — flatten, deduplicate, and sort opaque tag lists.
- `Meta.packageDirs(nodeModulesDir)` — scope-agnostic, symlink-aware enumeration across Node's ancestor resolution chain as `{ dir, name }` candidates; the nearest package name wins.
- `Meta.resolvedPackageDirs(cwd)` — `@plurnk/*` package directories resolved from the nearest `@plurnk`-bearing `node_modules`.
- `Meta.nearestNodeModules(fromDir)` — walk up to the nearest `node_modules` holding the ecosystem (witness: `@plurnk` scope); `null` when absent.

**The teaching corpus**: authored policy, the Plurnk skill entry, and built-in scheme references resolved from this installed package. Meta owns the source bytes and membership; core owns admission, resource composition, and projection. See [`CORPUS.md`](./CORPUS.md) and {§teaching-corpus}.

First-party extension packages (`@plurnk/*`) declare one `package.json#plurnk.kind`. Standard Agent Plugins (`plugin.json`) bundle portable `skills/`, `personas/`, and `mcp.json` components without executing in-process daemon code; shared manifest and filesystem validation is exported from `@plurnk/plurnk-meta/agent-plugin`, and the portable component loader is `@plurnk/plurnk-agent-plugins`.

An admitted extension package may declare always-on `plurnk.attribution` tags and its loaded object may return per-attempt tags from `attributions(context)` ({§extension-discovery}). MIT.
