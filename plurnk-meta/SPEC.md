# plurnk-meta — Specification

Contract for facts shared across the open plurnk packages: published teaching sources, installed extension discovery, environment readers, redaction-first spans, and ambient HTTP transport.

## §teaching-corpus 1. Published Teaching Sources and Skill Boundary

The package owns the authored defaults and exact membership below. Consumers own admission, runtime projection, and model-facing placement; every teaching source and `docs/*.md` obeys `TEACHING.md` (mechanism over advice, one owner per claim, knobs by name, shapes over purposes, no contract tags on a page).

| Source | Membership | Meta-owned content | Core read boundary |
| --- | --- | --- | --- |
| `POLICY.md` | Required | First-run default operating policy | Policy bootstrap {§packet-inject} |
| `recap.md` | Required | Optional default operational Recap (empty contributes no rendered section) | Per-packet user-slot footer {§packet-inject} |
| `docs/session.md` | Required | Deep reference prose for the reserved session scheme | Pull-doc materialization {§tools-resource-materialization} |
| `docs/delegation.md` | Required | Session delegation, lifecycle, and messaging | Pull-doc materialization with the session scheme |
| `docs/pattern.md` | Required | Operation-neutral pattern selection and literal source editing | Pull-doc materialization independent of schemes |
| `skills/plurnk/SKILL.md` | Required | Standard Plurnk skill entry and chapter directory | Service-provided skill {§tools-resource-materialization} |
| `skills/plurnk/references/extensibility.md` | Required | How integrations and extensions reach the model, and each kind's contract | Skill chapter {§tools-resource-materialization} |

- **Exact membership**: Each source is read only at its consuming boundary; missing required sources or read errors fail that boundary with the original cause. Consumers resolve exported membership without scanning `docs/` or inferring capabilities from filenames.
- **Scheme-bound vs language docs**: Exported documents declare their source and optional owning scheme. Plugin `documentation` is manifest-owned and serves as fallback only when meta owns no document of that name. Document exclusions apply to the document and its owning scheme.
- **Skill composition boundary**: Meta authors `skills/plurnk/SKILL.md`; Core composes its resource tree from package-owned references and generated resources ({§tools-resource-materialization}) and exposes it through the `skills` Functionality family ({§skills-module}) without copying skills into universal roots or invoking an installer.

## §extension-discovery 2. Installed Extension Discovery and Kinds

Enumeration (`Meta.packageDirs`) is scope-agnostic and symlink-aware across Node's ancestor resolution chain; the nearest package with a given name wins.

| Surface | Contract |
| --- | --- |
| Layer ownership | `plurnk-meta` owns Node package enumeration, exact `kind` identity, `Meta.isTrusted`, and attribution normalization. Each kind's framework owns kind-field validation, deterministic ordering/collisions, trust enforcement before import, and code loading. The composed host arbitrates cross-kind collisions and presents skipped-package evidence. |
| `plurnk.kind` values | `"exec"` (`runtimes[]`), `"mimetype"` (`handlers[]`), `"provider"` (singular `name`), `"scheme"` (`schemes[]` or singular `name` shorthand), `"http-materializer"` (`materializers[]`, {§http-lifecycle}), `"module"` (singular `module` export subpath, {§module-lifecycle}). |
| Manifest read (`Meta.readManifest(dir, kind?)`) | Reads `package.json#plurnk` (identity = npm package name) or Agent Plugin bundle `plugin.json#extensions.ai.plurnk` (validated per {§agent-plugins-roots}; identity = npm package name when packaged for Node, else plugin name; Plurnk files live under `ai.plurnk/`, resolved and contained inside the plugin root via `Meta.moduleFile(manifest, relative)`). Repeating the kind declaration in both manifests or having an invalid `plugin.json` is an error, never a fallback. `module` loads from npm or selected user plugin roots, never project roots ({§module-lifecycle}). Returns `null` for missing/malformed ordinary manifests, non-objects, absent declarations, or other kinds; propagates `AbortSignal` aborts. |
| Attribution (`plurnk.attribution` / `attributions(context)`) | Static `plurnk.attribution` (`string \| string[] \| null`) and optional synchronous runtime `attributions({ workspaceId, sessionId, primarySessionId, loop, turn, attempt })` normalize via `Meta.normalizeAttribution` / `Meta.runtimeAttribution` into readonly ordered lists (`packageAttributions`). Tags starting with `@plurnk/` are reserved to `@plurnk/*` packages; malformed declarations or thrown functions fail at the package boundary. The host flattens, deduplicates, and sorts tags as an opaque folksonomy. |
| Trust boundary (`Meta.isTrusted(packageName, env)`) | Enforced after reading the inert manifest and before importing or validating attribution. Empty or `"0"` `PLURNK_EXTENSIONS_TRUSTED_ONLY` trusts all installed packages; any other value trusts `@plurnk/*` plus the comma-separated allowlist in that value; an unset key falls back to this package's `.env.defaults` ({§operator-config-precedence}). Untrusted packages are preserved as skipped evidence without crashing discovery. |

## §env-knob 3. Environment Knobs, Resource Projection, and Error Detail

`Knob` reads a declared key by name from the system environment or an explicitly supplied authoritative environment (never falling through to `process.env` or mutating either environment, and accepting no code fallback).

| Surface | Contract |
| --- | --- |
| `Knob` readers | `text`, `list`, `flag` (`0` or `1`), `choice` (vocabulary member), `percent` (`80%` $\to$ `0.8`), `integer(name, floor)` (safe integer $\ge$ floor; floor bounds operator input and is never a fallback), `family(prefix)` (every `<prefix><alias>` with non-empty value in alias order; empty value turns member off). Unset keys are internal errors (broken floor); invalid operator values raise `ConfigurationError` naming `key` ({§configuration-repair-path}). |
| `ConfigurationError` identity | Available at `@plurnk/plurnk-meta/configuration-error`. `instanceof ConfigurationError` recognizes any `Error` named `ConfigurationError` with a string `key` across duplicate package copies. |
| `ResourceEnvironment` | Reads `PLURNK_<FAMILY>_<alias>=<definition>` (`_` decodes to `-`; validated against family grammar or `[a-z][a-z0-9-]*`, preserving case and Unicode without folding into uppercase controls), `PLURNK_<FAMILY>_ENABLED=0\|1`, `PLURNK_<FAMILY>_<alias>_ENABLED=0\|1`, and declared family controls. Empty/whitespace-only definitions are invalid even when disabled; `<alias>_ENABLED=0` suppresses activation without hiding the definition. |
| `ErrorDetail(knob)` | Binds `preview(value)` and `limit(environment?)` to a package's `*_ERROR_DETAIL_LIMIT` knob via `Knob`: truncates messages to at most that many characters with `...`, crashing by knob name if unset or invalid. |

## §observed-span 4. Redaction-First Spans

`observed(tracer, name, attributes, fn, options?)` and its synchronous twin wrap one span around `fn` on the caller's tracer: attributes admit strings (capped at 300 characters), numbers, and booleans and drop everything else; a thrown error marks the span `ERROR` and records only `error.type` (the error's class name, never its message).

## §ambient-http-transport 5. Ambient Proxy and CA Transport

`outboundFetch` and `syncAmbientHttp(env?)` apply ambient proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and lowercase spellings) and extra CA (`NODE_EXTRA_CA_CERTS`) settings from the shell or `$XDG_CONFIG_HOME/plurnk/.env` to Node's global HTTP/HTTPS agents, global `fetch` dispatcher, and OpenSSL root store, leaving global state untouched when none are set.
