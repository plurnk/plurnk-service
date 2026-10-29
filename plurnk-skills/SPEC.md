# Plurnk skills specification

## §skills-module 1. Module, Workspace Family, and Configuration

`@plurnk/plurnk-skills` loads through daemon module discovery, registering the `skills` Functionality family ({§functionality-coordinator}) and its read-only `skill://` resource tree during `setup` (no ingress, no producers to drain). Invalid configuration leaves the family inspectable but unavailable under {§configuration-repair-path} and fails offline validation.

| Layer (low to high) | Definition source & contract |
| --- | --- |
| Service | Host-provided trees (`ProvidedSkillsSeam`, omitting `source`). |
| Standard locations | Every `<root>/<name>/SKILL.md` under project, plurnk, XDG global (`$XDG_CONFIG_HOME/agents/skills`), and home global (`~/.agents/skills`) roots ({§functionality-inspection}), nearer roots shadowing farther ones and all shadowing host-provided trees by name. Standard roots are read-only configuration inputs; Plurnk neither installs into nor deletes from them. |
| Cascading environment | `PLURNK_SKILLS_<name>={"name":"<name>","source":"…","ref"?:"…"}` replaces the complete definition; `PLURNK_SKILLS_ENABLED` and `<name>_ENABLED` control enabledness ({§env-knob}). Decoded alias must equal `name` ({§agent-skills-directory}, including digit-leading and Unicode names). Validates shape, names, remote URLs, and Git-only `ref` without fetching; `commit` is service-recorded and refused as input. |
| Live workspace | ```` ```plurnk (skills) ```` `add` creates and `replace` assigns `{ alias, definition }` (`alias = name`, requiring `source`) ({§functionality-replacement}). `discover { source }` inertly lists standard skills in `source`. |

- **Admission & preparation**: Relative sources require a project root (recorded as absolute paths); git sources resolve `ref` (or default branch) via `git ls-remote` at admission to record `commit`; MCP sources (`<server>:///`, `<server>:///skills`, or `<server>:///skills/<name>`) verify `SKILL.md` via `workspace.mcp.skills` at admission, canonicalize `source` to `<server>:///skills/<name>`, and record the 64-hex SHA-256 manifest digest in `commit` ({§mcp-skills}, #654). Local folders and `SKILL.md` files remain live references; Git, MCP, and archive sources materialize inside {§module-seam-slices}, isolated per workspace and complete definition, and stay pinned across enable, cooling, and restart until the definition changes. Each admitted skill requires matching `name` and `description` frontmatter; a bad skill is `unavailable` with its exact Problem without failing the family ({§functionality-model-projection}).

## §skills-sources 2. Sources and Resource Tree

| Source / Operation | Contract |
| --- | --- |
| Git remote (`https://`, `ssh://`, `user@host:path`) | Resolved via `git ls-remote` at admission; shallow-cloned at preparation with hooks and submodules off (`PLURNK_SKILLS_FETCH_TIMEOUT_MS` bounds each fetch, using operator git config/credentials/SSH agent and never prompting). Checkout at any other commit fails `409 source-moved`. Plain `http`, other schemes, or `https://` with credentials fail `400 source-invalid`. |
| MCP server (`<server>:///`, `<server>:///skills`, `<server>:///skills/<name>`) | Discovered, verified, and fetched through `workspace.mcp.skills` ({§mcp-skills}, #654). Connecting an MCP server never auto-enables its skills into `skill://`; explicit `add` pins the 64-hex SHA-256 manifest digest in `commit` and materializes verified files (`SKILL.md` and supporting files, both static-manifest and `resources: "dynamic"` skills) into workspace state. If the remote MCP server mutates a skill's manifest digests after admission, preparation fails `409 source-moved` until explicitly replaced (`replace`). Verification failure (`SkillVerificationError`) fails `422 skill-invalid`; an unconnected server fails `404 source-missing`. |
| Folder or `SKILL.md` file | Live reference (`~/`, absolute, or project-relative) with {§agent-skills-directory} containment. |
| Archive (`.zip`, `.tar`, `.tgz`, `.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tar.zst`) | Unpacked into private staging with `unzip` or `tar`; a lone top-level directory is the source's root. |
| Source walking & safety | Walks from root without entering `.git` or an already-found skill directory. A root skill in a fetched source is named by frontmatter; sub-skills and local folders use directory name. A root `plugin.json` is refused with `422 source-is-plugin`. Materialized copies containing outward links or non-file/dir/inward-link entries fail `422 source-unsafe`. |
| `skill://<name>/` resource tree | Exposes enabled, available {§provided-skills-module-slice} trees via {§resource-tree-scheme} (WHATWG URI percent-encoding for non-ASCII names). Turn0 `FIND (skill://*/SKILL.md)` lists catalog metadata via {§mimetype-channel-selection}; `READ` and `FIND` below the authority observe live bytes and paths; ```` ```runtime (skill://<name>/scripts/program.ext) ```` executes preserving native file and siblings ({§exec-target-routing}); read-only to model mutation (`EDIT`, `SEND`, `KILL` refused). Disabling or removing withdraws authority while keeping historical log receipts; `WORK`/`FORK` share workspace Functionality. |

## §skills-hotload 3. Removal, Hotload, and Problems

- **Removal (`remove`)**: Forgets the workspace binding and restores any inherited definition and enabledness ({§functionality-coordinator}) without deleting external folders. Fetched materializations remain in workspace state for reuse only by the identical complete definition.
- **Hotload**: The family keeps a per-resident-workspace signature of discovered roots, configured definitions, source locations, and `SKILL.md` sources. Turn admission recomputes it under the workspace gate before packet assembly and republishes only when the signature or effective published skill set changes ({§functionality-inspection}).

| Problem code | Status | Contract |
| --- | --- | --- |
| `definition-invalid` | 400 | The Agent Skill definition is invalid; a supplied commit must be a ref instead, and refs require Git sources. |
| `source-invalid` | 400 | '*source*' is not a valid git remote URL, carries https credentials, is relative without a project root, or is neither a folder, a SKILL.md, nor a zip/tar archive. |
| `alias-mismatch` | 400 | Alias '*alias*' must equal the skill name '*name*'. |
| `source-required` | 400 | Adding '*alias*' requires the source that provides it. |
| `source-missing` / `ref-missing` | 404 | No folder or file is at '*source*'; or '*remote*' has no branch/tag '*ref*' or default branch. |
| `skill-not-found` / `skill-missing` / `entry-not-found` | 404 | '*source*' carries no Agent Skill named '*name*'; skill '*alias*' is not provided by this service; or no skill resource exists at the requested address. |
| `source-moved` / `skill-ambiguous` | 409 | '*source*' *ref* now names *current* (added at *commit*; use `replace` to update); or '*source*' carries *count* skills named '*name*'. |
| `source-unreadable` / `source-is-plugin` / `source-unsafe` / `skill-invalid` | 422 | Unreadable/unpackable source; root is an Agent Plugin; outward link or special file in skill; or invalid standard skill frontmatter. |
| `install-failed` | 500 | Agent Skill '*name*' could not be placed under *root*: *cause*. |
| `source-unreachable` | 502 | git could not reach '*remote*' or fetch it (at '*ref*'): *reason*. |
