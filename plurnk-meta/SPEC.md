# plurnk-meta — Specification

Contract for facts shared across the open plurnk package family. Capability
frameworks own their family-specific declarations and runtime interfaces; this
package owns the installed-membership primitives they share and the published
teaching sources listed below.

## §teaching-corpus Published teaching sources

The package owns the authored defaults below. Consumers own admission, runtime
projection, and model-facing placement; copying these sources into a consuming
package would create a second teaching owner.

| Source                          | Meta-owned content                                 | Consuming contract                                      |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `PLURNK_PERSONALITY.md`         | First-run default operating policy                 | Core policy bootstrap and projection {§policy-sections} |
| `requirements.md`               | Default compact operational recap                  | Core user-slot Recap {§requirements}                    |
| `docs/log.md`, `docs/worker.md` | Deep reference prose for reserved built-in schemes | Core pull-doc materialization {§schemes-directory}      |
| `docs/questions.md`             | Conditional operator-question reference prose      | Core capability/teaching gate {§send-300-choices}       |

A file in `docs/` does not declare a capability. A built-in scheme document is
eligible only when its basename matches a registered reserved scheme; plugin
documentation remains owned by that plugin's manifest. `questions.md` is the
one explicit non-scheme document consumer. Retired or unregistered names do not
ship as speculative teaching.

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

| `plurnk.kind` | Family-owned names                                       |
| ------------- | -------------------------------------------------------- |
| `"exec"`      | `runtimes[]`                                             |
| `"mimetype"`  | `handlers[]`                                             |
| `"provider"`  | singular `name`                                          |
| `"scheme"`    | `schemes[]`; singular `name` is the one-scheme shorthand |

Coordinated capabilities spanning families use explicit daemon-module
composition ({§module-lifecycle}); a multi-kind manifest is not a parallel
module mechanism.

### §plugin-attribution One package attribution fact

| Stage                  | Contract                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Declaration            | Optional `plurnk.attribution` is one non-empty string or an array of non-empty strings. `null`, absence, and an empty array normalize to no tags.             |
| Trust                  | The family applies {§plugin-trust-boundary} before attribution validation; a withheld declaration is not interpreted.                                             |
| Normalization          | `Meta.normalizeAttribution(raw, packageName)` produces one readonly, ordered list of opaque tags. A malformed trusted declaration fails package admission.   |
| Namespace reservation  | A tag beginning `@plurnk/` is valid only when `packageName` also begins `@plurnk/`; a violating trusted package fails admission.                              |
| Discovery result       | Each family returns `packageAttributions`, keyed once by package name. Only non-empty lists for packages represented after family admission are present.       |
| Published projections  | Existing per-tag, per-handler, or name-keyed attribution fields may project the validated declaration for 1.x compatibility; they do not own another policy. |

Manifest acquisition and attribution validation therefore occur once in the
family discovery path. A composed host consumes the admitted package map and
never reopens a plugin manifest for this fact.

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
