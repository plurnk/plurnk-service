# plurnk-meta — Specification

Contract for facts shared across the open plurnk package family. Capability
frameworks own their family-specific declarations and runtime interfaces; this
package owns the installed-membership primitives they share and the published
teaching sources listed below.

## §teaching-corpus Published teaching sources

The package owns the authored defaults and exact membership below. Consumers
own admission, runtime projection, and model-facing placement; copying these
sources into a consuming package would create a second teaching owner.

| Source                          | Membership | Meta-owned content                                 | Core read boundary                                      |
| ------------------------------- | ---------- | -------------------------------------------------- | ------------------------------------------------------- |
| `PLURNK_PERSONALITY.md`         | Required   | First-run default operating policy                 | Policy bootstrap {§policy-sections}                     |
| `requirements.md`               | Required   | Default compact operational Recap                  | Per-packet user-slot footer {§requirements}            |
| `docs/worker.md`                | Required   | Deep reference prose for the reserved worker scheme | Pull-doc materialization {§schemes-directory}           |

Required is a package-membership statement, not unconditional packet
projection. Each source is read only at its consuming boundary; absence or an
unrelated read failure fails that boundary with the original cause. Consumers
resolve the exported membership exactly: they do not scan `docs/`, infer new
members from filenames, or treat a missing required source as empty teaching.

A file in `docs/` does not declare a capability. A built-in scheme document is
eligible only when its basename matches a registered reserved scheme; plugin
documentation remains owned by that plugin's manifest. Retired or
unregistered names do not ship as speculative teaching. Manifest `documentation` is deliberately
optional: an absent field contributes no pull doc, while a present field is the
fallback only when meta owns no source for that scheme name.

## §plugin-discovery Installed capability discovery

```mermaid
flowchart LR
    graph[Installed Node dependency graph] --> enumerate[Meta.packageDirs]
    enumerate --> scanner[Family-owned scanner]
    manifest[package.json plurnk manifest] --> scanner
    policy[Meta.isTrusted] --> gate{Trusted?}
    scanner --> gate
    gate -->|yes| attribution[Meta.normalizeAttribution]
    attribution --> family[Family-owned validation, loading, and registry]
    gate -->|no| skipped[Skipped-package evidence]
    family --> host[Composed host]
    skipped --> host
```

| Layer                 | Owns                                                                                                                              | Does not own                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `plurnk-meta`         | Node package enumeration, exact capability-family identity, the one trust predicate, and package-attribution normalization.       | Family fields, capability collisions, plugin imports, or presentation. |
| Family implementation | Family-field validation, deterministic ordering/collisions, trust enforcement before any plugin import, and trusted code loading. | A second trust or attribution policy, or cross-family composition.     |
| Composed host         | Cross-family arbitration and presentation of skipped-package evidence.                                                            | Re-parsing manifests or importing a declined package.                  |

The installed dependency graph is the compatibility boundary. Enumeration is
scope-agnostic and symlink-aware across Node's ancestor resolution chain; the
nearest package with a given package name wins. Installing a package makes a
valid declared capability discoverable. Environment values configure or bound
installed capabilities; they never manufacture package existence.

### §plugin-family-kind One package, one capability family

`package.json#plurnk.kind` is one exact string. Arrays and other shapes claim no
family. A package may declare multiple named capabilities inside its one
family-owned collection.

| `plurnk.kind`     | Family-owned names                                       |
| ----------------- | -------------------------------------------------------- |
| `"exec"`          | `runtimes[]`                                             |
| `"mimetype"`      | `handlers[]`                                             |
| `"provider"`      | singular `name`                                          |
| `"scheme"`        | `schemes[]`; singular `name` is the one-scheme shorthand |
| `"http-materializer"` | `materializers[]` ({§http-materializer-plugins})     |
| `"module"`        | singular `module` export subpath ({§module-discovery})   |

Coordinated capabilities spanning families use explicit daemon-module
composition ({§module-lifecycle}); a multi-kind manifest is not a parallel
module mechanism.

### §plugin-attribution Plugin-authored attribution tags

| Surface                 | Contract                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static declaration      | Optional `plurnk.attribution` is one non-empty string or an array of non-empty strings. `null`, absence, and an empty array normalize to no tags. A declaration is an always-on source for the admitted package.                            |
| Runtime declaration     | A loaded plugin object may implement synchronous `attributions(context)`, returning the same declaration shape, `null`, or `undefined`. The hook is pulled once for each provider emission attempt; returning no tags omits that source.     |
| Hook context            | `workspaceId`, `workerId`, and `primaryWorkerId` are opaque strings; `loop`, `turn`, and `attempt` are positive sequence numbers. The hook receives no engine, database, trust, or mutation capability.                                      |
| Trust                   | The family applies {§plugin-trust-boundary} before attribution validation or plugin import. Trust admits executable code; it does not make an authored tag truthful.                                                                        |
| Normalization           | `Meta.normalizeAttribution(raw, packageName)` and `Meta.runtimeAttribution(source, context, packageName)` produce readonly ordered lists. A malformed trusted declaration, malformed hook, or thrown hook fails at the package boundary.    |
| Namespace reservation   | A tag beginning `@plurnk/` is valid only when `packageName` also begins `@plurnk/`; a violating trusted package fails. Other tag vocabularies, collisions, and meanings are deliberately uninterpreted.                                      |
| Discovery result        | Each family returns `packageAttributions`, keyed once by package name. Only non-empty static lists for packages represented after family admission are present.                                                                             |
| Host composition        | The host flattens static and runtime lists from its admitted plugin objects, deduplicates and sorts the result, and treats it as an opaque folksonomy. It does not infer contribution, provenance, weight, trustworthiness, or causal value. |
| Published projections   | Existing per-tag, per-handler, or name-keyed attribution fields may project the validated static declaration for 1.x compatibility; they do not own another policy.                                                                       |

Manifest acquisition and static validation occur once in the family discovery
path. A composed host consumes the admitted package map and loaded plugin
objects without reopening a manifest or tracing tags through produced values.

### §plugin-trust-boundary One policy, enforcement before import

`Meta.isTrusted(packageName, env)` is the sole trust decision:

- unset, empty, or `"0"` `PLURNK_PLUGINS_TRUSTED_ONLY` trusts every installed
  package;
- any other value trusts every `@plurnk/*` package plus the comma-separated
  package-name allowlist in that value.

Every family scanner applies that predicate after reading the inert package
manifest and before importing or registering plugin code. An untrusted package
does not crash discovery: the family result preserves its package identity as
skipped evidence. The composed host decides how to present that evidence.
Direct framework consumers receive the same safe load boundary and can choose
their own presentation.
