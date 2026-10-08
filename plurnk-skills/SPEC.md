# Plurnk skills specification

## Module

§skills-module **Skills load through ordinary daemon module discovery.**
The package registers its Functionality family and read-only resource tree during setup.
It opens no ingress and owns no producers to drain. Core supplies workspace paths, admitted
subprocess environment, operational storage, plugin components and host-composed reference trees
through published module seams. Invalid configuration leaves the family inspectable but unavailable
under {§configuration-repair-path}; the module reports it for offline validation too.

The durable namespace is `@plurnk/plurnk-skills`; existing state follows
{§skills-storage-upgrade}.

## Workspace family

§skills-functionality **Agent Skills are one workspace Functionality family.**
The discovered skills module registers the `skills` family with the coordinator ({§functionality-coordinator});
its adapter owns protocol truth for standard Agent Skills and nothing else. A
definition is `SkillDefinition`: the standard skill `name`, its `source`, and
optional Git `ref`/resolved `commit` ({§skills-sources}). Only a host-provided
resource tree omits `source`. Source location is not mutation ownership: standard
project/global roots are read-only configuration inputs; live changes belong to
the workspace. Plurnk neither installs into nor deletes from those roots.

*Available definitions.* The filesystem is the only truth about installation:
every `<root>/<name>/SKILL.md` directory under the project, plurnk, then global
root is one service-origin definition, a nearer root shadowing a farther one and
all of them shadowing host-provided trees by name. Each filesystem definition
names its actual source directory. The workspace's durable state owns
enablement ({§functionality-state}); a disabled skill stays client-visible and
leaves no model-facing trace.

§skills-configuration **Skills use the shared definition cascade.**

| Layer, low to high | Definition source |
|---|---|
| Service | Host-provided trees |
| Standard locations | Global, plurnk, then project roots selected by {§agent-roots} |
| Cascading environment | `PLURNK_SKILLS_<name>={"name":"<name>","source":"…","ref"?:"…"}` replaces the complete definition |
| Live workspace | `skills (add)` creates a workspace definition through {§functionality-coordinator} |

`PLURNK_SKILLS_ENABLED` supplies default enabledness; `<name>_ENABLED` overrides
it independently ({§resource-environment}). The decoded environment alias must
equal the standard skill name, including digit-leading and Unicode names.
Blank definitions are invalid; controls may precede a definition. Environment
validation checks shape, names, remote URL rules, and Git-only `ref` without
fetching or opening a source; `commit` is service-recorded, not an input.

*Discovery is inert.* `discover {source}` lists the standard skills one source
carries, each a candidate with `source` provenance and the exact definition to
add; it never installs, persists, or enables. Agent Skills have no standard
registry, so `discover {query}` is 400 `query-unsupported`, naming the source
forms. Client `configuration` contributes nothing and is refused with 400.

*Admission.* `add {alias, definition}` requires `alias = name` and a `source`;
the workspace definition may shadow a service skill of the same name. Relative
sources require a project root; absolute sources work in headless workspaces.
A local source is recorded as its absolute path.
A git source records the `commit` its `ref` names at admission, or its default
branch's when no `ref` is given; `ref` belongs to git sources, and a supplied
`commit` is refused because the service records it. The family's aliases use
the standard skill-name grammar ({§agent-skills-name}), including digit-leading
and Unicode names, rather than the coordinator's generic default.

*Preparation.* For each enabled alias the adapter selects the host-provided
tree or resolves the complete source definition ({§skills-sources}). Local
folders and their `SKILL.md` files remain live references, including supporting
resources and symlink retargeting. Git/archive sources are materialized only
inside {§module-workspace-directory}; different workspaces and complete source
definitions cannot reuse each other's materializations accidentally.
The first fetched Git/archive copy remains stable across enable, cooling, and
restart until the complete source definition changes. In particular, an
operator-configured symbolic Git ref is not an implicit update subscription.
Each admitted skill requires standard `name` and `description` frontmatter
with `name` matching its directory. A missing, uninstallable, or invalid skill
is `unavailable` with its exact Problem ({§problems-skills}) under the
coordinator's failure policy ({§functionality-model-mutation}); one bad skill
never fails the family.

Removal follows {§skills-remove}.

§skills-sources **A source is a git remote, a folder, or a file, read with standard tools.**
Fetching runs nothing it fetched. Materialized copies cannot contain references
outside their skill; live resources retain {§agent-skills-directory} containment.

| Source | How it is read |
|---|---|
| Git remote: a full `https://` or `ssh://` URL, or `user@host:path` | `git ls-remote` resolves the ref at admission; preparation shallow-clones it with hooks and submodules off, and a checkout at any other commit is 409 `source-moved` |
| Folder: absolute, `~/`, or relative to the project root | Live reference; standard directory/name matching applies |
| A file named `SKILL.md` | Live reference to its skill directory and supporting resources |
| A `.zip`, `.tar`, `.tgz`, `.tar.gz`, `.tar.bz2`, `.tar.xz`, or `.tar.zst` archive | Unpacked into private staging with `unzip` or `tar`; a lone top-level directory is the source's root |

Any other scheme, plain `http`, `owner/repo` shorthand, and an https URL carrying
credentials are refused with `source-invalid` or `source-missing`: shorthand names no
forge, and a recorded source is listed to every client. Git runs with the
operator's configuration, credentials, and SSH agent, never plurnk's secrets, and
never prompts; `PLURNK_SKILLS_FETCH_TIMEOUT_MS` bounds each fetch. The
retired vendor-installer knobs (`PLURNK_SERVICE_SKILLS_CLI`, `_CLI_TIMEOUT_MS`,
`_REGISTRY_URL`, `_REGISTRY_LIMIT`, `_REGISTRY_TIMEOUT_MS`) make the skills family
unavailable when set, each naming what replaced it ({§configuration-repair-path}).

A source's skills are the directories holding a `SKILL.md`, found by walking
from its root without entering `.git` or a skill already found. A fetched skill at
the root is named by its frontmatter ({§agent-skills-name}); local references and
directories below the root use the standard folder rule. A source with `plugin.json` at its root is an
Agent Plugin and is refused with 422 `source-is-plugin`, so its skills keep the
plugin's identity. Materialization copies the named skill beside its workspace-owned destination
and renames it to `<root>/<name>`; a copy that holds a link out of the skill, or
anything but files, directories, and inward links, is refused with 422
`source-unsafe` and leaves nothing behind.

§skills-resources **A skill is a resource tree, not a rewritten document.**
The family exposes enabled, available {§agent-skills-tree} sources through
`skill://<name>/` using {§resource-tree-scheme}. The source owns its bytes; commons entries are demand-loaded
projections, not writable installations. Filesystem skills retain their original
directories; service-provided trees need no generated filesystem directory.
The authority is the name's WHATWG URI representation, including percent-encoding
for non-ASCII names. Installation names remain unchanged; a raw spelling and its
serialized URI address the same resource, not separate skill identities.

| Operation | Contract |
| --- | --- |
| Turn0 `FIND (skill://*/SKILL.md)` | One ordinary resource catalog: name, address, and standard frontmatter description via {§mimetype-summary}. No synthetic index, body injection, or execution. |
| `READ (skill://<name>/SKILL.md)` | Original frontmatter and Markdown, unchanged; relative links remain relative to the source layout. |
| `READ` / `FIND` below the authority | References, scripts, and assets retain their source paths and ordinary pattern, channel, byte, and multimodal semantics. Acquisition observes current source contents, including disappearance. |
| ```` ```runtime (skill://<name>/scripts/program.ext) ```` | Ordinary resource execution and proposal policy; preserve the native file and its siblings under {§exec-source-temporary}. Discovery and READ never execute scripts. |
| Model mutation | Read-only; no EDIT, SEND, or KILL of skill resources. Manage definitions and enablement through ```` ```skills ````. |
| Disable / unavailable / remove | Withdraw the authority from new resource access and discovery. Existing log receipts remain historical evidence. |
| WORK / FORK | Use the same workspace Functionality, not copied definitions or resource caches. |

Explicit skill URIs address these resources; bare operation paths still address
project files, with no implicit current-skill directory. Source resolution follows
{§agent-skills-directory}, including symlinked skill directories and containment of references.
An uninstalled Git skill is not manufactured by repository detection.

§skills-remove **`remove` forgets the workspace binding, not the source.**
It withdraws that definition and restores any inherited definition and enabledness
({§functionality-coordinator}). External folders are never deleted. Fetched
materializations remain workspace-owned operational state, reusable only for the
same complete definition; they confer no availability without a definition.
Inherited definitions cannot be removed here; their enabledness can be overridden.

§skills-hotload **Skills placed out of band are admitted at the next turn** ({§functionality-hotload}). The
family keeps one signature of the discovered roots, configured definitions, source locations, and `SKILL.md` sources
per resident workspace, read before a publication loads the skills it describes. Turn admission
recomputes it under the workspace gate before packet assembly: a changed signature republishes the
family, and an unchanged one republishes only when the skills the coordinator would publish differ
from the published ones. A skill installed, edited or removed by any other tool is therefore
discoverable in the first subsequent model turn, while an unchanged set dispatches nothing. The model manages skills
only through the generated ```` ```skills ```` family
({§functionality-model-projection}); it is never taught a package manager.

## Problems

§problems-skills **Agent Skills source and setup Problems.** Shared coordination failures use
{§problems-functionality}. Placeholders below describe the failing source or definition.

| code | status | contract |
|---|---:|---|
| `configuration-unsupported` | 400 | Agent Skills discovery takes a source; client configuration contributes nothing. |
| `definition-invalid` | 400 | The Agent Skill definition is invalid; a supplied commit must be a ref instead, and refs require Git sources. |
| `query-unsupported` | 400 | Agent Skills have no standard registry to search; discover takes a source: a git remote as a full https or ssh URL, a folder, a lone SKILL.md, or a zip or tar archive. |
| `source-invalid` | 400 | '*source*' is not a valid git remote URL; an https source carries no credentials (git's credential helper supplies them); is not a source: a git remote is a full https or ssh URL; is relative, and this workspace has no project root to resolve it against; or is neither a folder, a SKILL.md, nor a zip or tar archive. |
| `source-missing` | 404 | No folder or file is at '*source*'. |
| `source-unreadable` | 422 | '*source*' cannot be read: *cause*; or '*path*' could not be unpacked: *reason*. |
| `source-unreachable` | 502 | git could not reach '*remote*', or fetch it (at '*ref*'): *reason*. |
| `ref-missing` | 404 | '*remote*' has no branch or tag '*ref*', or names no default branch. |
| `source-moved` | 409 | '*source*' *ref* now names *current*; this skill was added at *commit*. Recovery: Remove the skill and add it again to take the current commit. |
| `source-is-plugin` | 422 | '*source*' is an Agent Plugin, not a skill. |
| `source-unsafe` | 422 | '*path*' links outside its skill, or is neither a file, a directory, nor an inward link. |
| `skill-not-found` | 404 | '*source*' carries no Agent Skill named '*name*'. |
| `skill-ambiguous` | 409 | '*source*' carries *count* skills named '*name*'. |
| `alias-mismatch` | 400 | Alias '*alias*' must equal the skill name '*name*'. |
| `source-required` | 400 | Adding '*alias*' requires the source that provides it. |
| `install-failed` | 500 | Agent Skill '*name*' could not be placed under *root*: *cause*. |
| `skill-missing` | 404 | Agent Skill '*alias*' is not provided by this service. |
| `skill-invalid` | 422 | Agent Skill '*alias*' is not a valid standard skill: *cause*. |
