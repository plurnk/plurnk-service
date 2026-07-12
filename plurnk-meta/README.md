# @plurnk/plurnk-plugins

Plugin-membership primitives for the plurnk ecosystem — the ONE implementation of trust, enumeration, and root resolution that every discovery surface (the daemon's plugin loader and env-defaults floor; the schemes/mimetypes/providers/execs family-head scanners) consumes.

- `Plugins.isTrusted(packageName, env?)` — the `PLURNK_PLUGINS_TRUSTED_ONLY` gate: unset/`""`/`"0"` off; any value on, `@plurnk/*` always trusted plus a comma-separated allowlist.
- `Plugins.packageDirs(nodeModulesDir)` — scope-agnostic, symlink-aware enumeration of installed packages as `{ dir, name }` candidates. Ordering and filtering are the caller's policy.
- `Plugins.nearestNodeModules(fromDir)` — walk up to the nearest `node_modules` holding the ecosystem (witness: `@plurnk` scope); `null` when absent.

Third-party plugin authors: your package is discovered by ANY scope + a `plurnk` manifest (`plurnk.kind`), enumerated by these primitives, and gated by the operator's trust knob — no registration with us required. MIT.
