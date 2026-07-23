# @plurnk/plurnk-meta

The plurnk metaproject layer, published — what the family shares that no single member owns.

**Membership primitives** (`import Meta from "@plurnk/plurnk-meta"`): the ONE implementation of trust, enumeration, and root resolution consumed by the daemon's plugin loader and env-defaults floor and by all four family-head scanners (schemes, mimetypes, providers, execs).

- `Meta.isTrusted(packageName, env?)` — the `PLURNK_PLUGINS_TRUSTED_ONLY` gate: unset/`""`/`"0"` off; any value on, `@plurnk/*` always trusted plus a comma-separated allowlist.
- `Meta.packageDirs(nodeModulesDir)` — scope-agnostic, symlink-aware enumeration of installed packages as `{ dir, name }` candidates. Ordering and filtering are the caller's policy.
- `Meta.nearestNodeModules(fromDir)` — walk up to the nearest `node_modules` holding the ecosystem (witness: `@plurnk` scope); `null` when absent.

**The teaching corpus**: `PLURNK_PERSONALITY.md` (the default operating policy the daemon seeds to `~/.plurnk/AGENTS.md`), `requirements.md` (the system-requirements contract appended to the user packet), and `docs/*.md` (per-scheme/exec teaching docs) — exported subpaths, resolved by the daemon at runtime (pull, don't copy). See `CORPUS.md`.

**Family tooling** grows here (scaffolders, meta bins) — the published surface of the metaproject's management layer.

[`DOGFOOD.md`](./DOGFOOD.md) defines the whole-product, outside-client acceptance gate for daily-driver and release readiness.

Third-party plugin authors: your package is discovered by ANY scope + a `plurnk` manifest (`plurnk.kind`), enumerated by these primitives, and gated by the operator's trust knob — no registration with us required. MIT.
