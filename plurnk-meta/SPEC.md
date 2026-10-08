# plurnk-meta — Specification

Contract for facts shared across the open plurnk packages. Each kind's
framework owns its kind-specific declarations and runtime interfaces; this
package owns the installed-membership primitives they share and the published
teaching sources listed below.

## §teaching-corpus Published teaching sources

The package owns the authored defaults and exact membership below. Consumers
own admission, runtime projection, and model-facing placement; copying these
sources into a consuming package would create a second teaching owner.

| Source                          | Membership | Meta-owned content                                 | Core read boundary                                      |
| ------------------------------- | ---------- | -------------------------------------------------- | ------------------------------------------------------- |
| `POLICY.md`                     | Required   | First-run default operating policy                 | Policy bootstrap {§policy-sections}                     |
| `recap.md`                       | Required   | Optional default operational Recap                 | Per-packet user-slot footer {§recap}                    |
| `docs/worker.md`                | Required   | Deep reference prose for the reserved worker scheme | Pull-doc materialization {§schemes-directory}           |
| `docs/delegation.md`            | Required   | Worker delegation, lifecycle, and messaging | Pull-doc materialization with the worker scheme |
| `docs/pattern.md`               | Required   | Operation-neutral pattern selection and literal source editing | Pull-doc materialization independent of schemes |
| `skills/plurnk/SKILL.md`         | Required   | Standard Plurnk skill entry and chapter directory | Service-provided skill {§plurnk-skill} |
| `skills/plurnk/references/extensibility.md` | Required | How integrations and extensions reach the model, and each kind's contract | Skill chapter {§plurnk-skill} |

Every teaching source, and every package's `docs/*.md`, is written to
`TEACHING.md`, the style rule for model-facing prose: mechanism over advice,
one owner per claim, knobs by name, shapes over purposes, one home per
mechanism, no contract tags on a page.

Required is a package-membership statement, not unconditional packet
projection. Each source is read only at its consuming boundary; absence or an
unrelated read failure fails that boundary with the original cause. An empty
`recap.md` intentionally contributes no rendered packet section while preserving
its one authored source for later use. Consumers resolve the exported membership
exactly: they do not scan `docs/`, infer new members from filenames, or treat a
missing required source as empty teaching.

A file in `docs/` does not declare a capability. Each exported document declares
its source and an optional owning scheme. Scheme-bound references follow that
scheme's visibility and capability admission; language references are independent
of scheme registration. A basename is a document identity, not an invented scheme.
Plugin documentation is owned by its manifest: an absent `documentation`
contributes no pull doc; a present field is the fallback when meta owns no
document of that name. Document exclusions apply to the document and its owning
scheme, when present.

## §skills-installation-boundary Skill composition and installation

Meta authors the standard Plurnk `SKILL.md`; Core composes its resource tree
from package-owned references and generated resources ({§plurnk-skill}). Skill
discovery and enablement use the same `skills` Functionality family as installed
skills ({§skills-functionality}). Neither package copies skills into universal roots
or invokes an installer merely to expose the service's own reference material.

## §extension-discovery Installed extension discovery

```mermaid
flowchart LR
    graph[Installed Node dependency graph] --> enumerate[Meta.packageDirs]
    enumerate --> scanner[Kind-owned scanner]
    manifest[package.json plurnk manifest] --> scanner
    policy[Meta.isTrusted] --> gate{Trusted?}
    scanner --> gate
    gate -->|yes| attribution[Meta.normalizeAttribution]
    attribution --> framework[Framework-owned validation, loading, and registry]
    gate -->|no| skipped[Skipped-package evidence]
    framework --> host[Composed host]
    skipped --> host
```

| Layer                 | Owns                                                                                                                              | Does not own                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `plurnk-meta`         | Node package enumeration, exact kind identity, the one trust predicate, and package-attribution normalization.                    | Kind fields, capability collisions, extension imports, or presentation. |
| Kind framework        | Kind-field validation, deterministic ordering/collisions, trust enforcement before any extension import, and trusted code loading. | A second trust or attribution policy, or cross-kind composition.     |
| Composed host         | Cross-kind arbitration and presentation of skipped-package evidence.                                                            | Re-parsing manifests or importing a declined package.                  |

The installed dependency graph is the compatibility boundary. Enumeration is
scope-agnostic and symlink-aware across Node's ancestor resolution chain; the
nearest package with a given package name wins. Installing a package makes a
valid declared extension discoverable. Environment values configure or bound
installed extensions; they never manufacture package existence.

### §extension-kind One package, one kind

The native declaration's `kind` is one exact string, in either manifest location
at {§extension-manifest-read}. A package may declare multiple named capabilities inside its one
kind-owned collection.

| `plurnk.kind`     | Kind-owned names                                         |
| ----------------- | -------------------------------------------------------- |
| `"exec"`          | `runtimes[]`                                             |
| `"mimetype"`      | `handlers[]`                                             |
| `"provider"`      | singular `name`                                          |
| `"scheme"`        | `schemes[]`; singular `name` is the one-scheme shorthand |
| `"http-materializer"` | `materializers[]` ({§http-materializer-extensions})     |
| `"module"`        | singular `module` export subpath ({§module-discovery})   |

Coordinated capabilities spanning kinds use explicit daemon-module
composition ({§module-lifecycle}).

### §env-knob One environment reader

`Knob` reads a declared key by name from the system environment, or an explicitly
supplied assembled environment: `text`, `list`, `flag` (exactly `0` or `1`), `choice` (one of a
vocabulary), `percent` (`80%` is 0.8) and `integer(name, floor)` (a safe
integer of at least the floor, which bounds what the operator may say and is
never a value used in the operator's place). An unset key is a broken floor
and remains an internal error. Invalid operator values raise a
`ConfigurationError` naming the key; the owning capability contains that
diagnostic without inventing a value ({§configuration-repair-path}).
The same class is available from `@plurnk/plurnk-meta/configuration-error`
without loading discovery or observability machinery.
No reader accepts a fallback: a signature that could carry one is a second
home for a choice. A supplied environment is authoritative: missing keys do not
fall through to the process, and reading never mutates either environment.
Every package reads its knobs through it, so validation and failure wording
have one home for runtime and offline configuration checks.

### §resource-environment Named resource environment projection

`ResourceEnvironment` reads one family's assembled environment without loading
resources or changing configuration. Families declare their supported controls,
per-resource settings and, when required by their resource standard, an alias
grammar. Definition parsing and validation remain family-owned.

| Form | Meaning |
|---|---|
| `PLURNK_<FAMILY>_<alias>=<definition>` | One complete definition. `_` represents `-` in the resource name; validate the decoded name with the family's grammar, otherwise `[a-z][a-z0-9-]*`. |
| `PLURNK_<FAMILY>_ENABLED=0\|1` | The family default, declared in its owning `.env.defaults`. |
| `PLURNK_<FAMILY>_<alias>_ENABLED=0\|1` | This resource's independent override; it does not copy or modify the definition. |
| Other uppercase controls/settings | Accepted only when the family declares them. Definition aliases are never case-folded into controls. |

Enabledness uses {§env-knob}. Controls may precede a definition or address resources
supplied by other sources; they do not manufacture definitions. An unused alias
is valid. Spelling, supported settings and their values are validated when the
environment is read, independently of whether a definition exists.
Definition data remains verbatim for its owning schema; this reader neither merges
fields nor includes those values in its diagnostics. Empty or whitespace-only
definitions are invalid even when disabled. Absence leaves inheritance intact;
`<alias>_ENABLED=0` suppresses activation without hiding the definition.
Names are preserved without case folding or Unicode normalization. Standard skill
names ({§agent-skills-name}) may lead with a digit or contain Unicode; native
`.env` files and `env 'NAME=value' command` carry such keys even when a shell's
assignment grammar cannot. Uppercase controls remain distinct from aliases.

### §error-detail-bound One diagnostic-preview bound

`new ErrorDetail(knob)` binds a package's model-facing diagnostic preview to
that package's `*_ERROR_DETAIL_LIMIT` knob, read through {§env-knob}:
`preview(value)` keeps at most that many characters of an error's message
(or a value's string form) and marks the cut with `...`. The bound is read at
each preview; an unset or invalid bound crashes by name at the first
diagnostic, never degrades into an unbounded one.
`limit(environment?)` validates the same bound without rendering a diagnostic;
an explicitly supplied environment is complete and never falls back to the process.

### §extension-manifest-read One extension declaration

| Distribution | Declaration | Identity |
|---|---|---|
| Extension package | `package.json#plurnk` | npm package name |
| Agent Plugin bundle | `plugin.json#extensions.ai.plurnk` | npm package name when packaged for Node; otherwise the standard plugin name |

The bundle uses the standard manifest validation at {§agent-plugins-manifest}.
Its namespace contains the same `kind` and kind-owned fields as an extension
package. Each kind's loader, import convention, registry and lifetime remain
unchanged; bundling does not convert extensions into daemon modules.
Use `kind: "module"` when the extension needs the daemon lifecycle ({§module-lifecycle}).
Its Plurnk-specific files, including defaults, live under `ai.plurnk/`.
A bundle never repeats its kind declaration in `package.json`: two declarations
are an error, not an override. npm exports and dependencies remain Node packaging
metadata. The standard manifest is authoritative when present; an invalid one
cannot fall through to a package declaration. Other clients' extension namespaces
claim no Plurnk extension.

| Kind | Installation boundary |
|---|---|
| `module` | npm or selected user plugin roots; never project roots ({§module-discovery}) |
| `exec`, `mimetype`, `provider`, `scheme`, `http-materializer` | Existing npm discovery and each kind's import conventions |

`Meta.moduleFile(manifest, relative)` resolves a kind-owned file entry. A standard
bundle's entry must be under `ai.plurnk/` and resolve inside the plugin root.
npm export-based kinds retain Node's package export resolution. Declared file
entry loaders use this shared containment boundary before importing.

`Meta.readManifest(dir, kind?)` is the one read of a package's kind claim:
its declaration, parsed, with an object declaring exactly that
`kind` ({§extension-kind}); omitting the filter inspects any kind,
as required by the configuration-floor collector. It answers `null` for a missing or
malformed ordinary package manifest, a non-object, no declaration, or another kind —
none of those is a package of that kind, and a scanner skips them without
evidence. The result carries the manifest path, the package name when
`name` is a non-empty string (otherwise `null`; what an unnamed package is
remains the kind's decision), and the `plurnk` object untouched: kind
fields are validated by the kind's framework, after the trust gate. A scanner that
passes an `AbortSignal` receives the abort; it is never masked as an
unreadable directory. No framework reads a manifest any other way.

### §extension-attribution Extension-authored attribution tags

| Surface                 | Contract                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static declaration      | Optional `plurnk.attribution` is one non-empty string or an array of non-empty strings. `null`, absence, and an empty array normalize to no tags. A declaration is an always-on source for the admitted package.                            |
| Runtime declaration     | A loaded extension object may implement synchronous `attributions(context)`, returning the same declaration shape, `null`, or `undefined`. The function is pulled once for each provider emission attempt; returning no tags omits that source.     |
| Function context        | `workspaceId`, `workerId`, and `primaryWorkerId` are opaque strings; `loop`, `turn`, and `attempt` are positive sequence numbers. The function receives no engine, database, trust, or mutation capability.                                      |
| Trust                   | The kind's framework applies {§extension-trust-boundary} before attribution validation or extension import. Trust admits executable code; it does not make an authored tag truthful.                                                                        |
| Normalization           | `Meta.normalizeAttribution(raw, packageName)` and `Meta.runtimeAttribution(source, context, packageName)` produce readonly ordered lists. A malformed trusted declaration, malformed function, or thrown function fails at the package boundary.    |
| Namespace reservation   | A tag beginning `@plurnk/` is valid only when `packageName` also begins `@plurnk/`; a violating trusted package fails. Other tag vocabularies, collisions, and meanings are deliberately uninterpreted.                                      |
| Discovery result        | Each kind's discovery returns `packageAttributions`, keyed once by package name. Only non-empty static lists for packages represented after admission are present.                                                                             |
| Host composition        | The host flattens static and runtime lists from its admitted extension objects, deduplicates and sorts the result, and treats it as an opaque folksonomy. It does not infer contribution, provenance, weight, trustworthiness, or causal value. |

Manifest acquisition and static validation occur once in each kind's discovery
path. A composed host consumes the admitted package map and loaded extension
objects without reopening a manifest or tracing tags through produced values.

### §extension-trust-boundary One policy, enforcement before import

`Meta.isTrusted(packageName, env)` is the sole trust decision:

- empty or `"0"` `PLURNK_EXTENSIONS_TRUSTED_ONLY` trusts every installed package;
- any other value trusts every `@plurnk/*` package plus the comma-separated
  package-name allowlist in that value;
- an **unset** key is answered by this package's own `.env.defaults`, because the
  gate decides whose panel joins the floor and so is asked before the floor
  exists. A value in code would outrank the panel, so there is none
  ({§operator-config-only-home}).

Every kind's scanner applies that predicate after reading the inert package
manifest and before importing or registering extension code. An untrusted package
does not crash discovery: the scanner's result preserves its package identity as
skipped evidence. The composed host decides how to present that evidence.
Direct framework consumers receive the same safe load boundary and can choose
their own presentation.

## §observed-span Redaction-first spans

`observed(tracer, name, attributes, fn, options?)` and its synchronous twin wrap
one span around `fn` on the caller's tracer: attributes admit strings (capped at
300 characters), numbers and booleans and drop everything else; a thrown error
marks the span `ERROR` and records only `error.type`, the error's class name,
never its message. Every instrumented package binds these to its own tracer
rather than declaring a second helper; prompts, payloads and arbitrary URLs never
reach a span through them.
