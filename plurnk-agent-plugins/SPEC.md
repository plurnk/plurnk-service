# Agent Plugins loader

## §agent-plugins-roots 1. Scope, Roots, and Manifest

This package implements the discovery, validation, and failure boundaries of [Agent Plugins 1.0.0](https://agent-plugins.org/specification) as a reference client: it reads consumer-supplied directories and returns validated plugins with typed reports, without installing, executing, or fetching anything.

| Aspect | Contract |
| --- | --- |
| Input & candidates | Ordered roots `{ scope, directory }` followed by optional explicit installed directories in supplied order (earlier takes precedence). Candidates are immediate child directories not starting with `.` (files and missing roots hold none). Unreadable roots/candidates report `rejected` while other candidates remain available. |
| Identity & shadowing | Identified by manifest `name`, never directory name (§11.1). First plugin with a name wins by root order then directory name in code-point order; later duplicates report `shadowed`. |
| Manifest (`plugin.json`) | `$schema` recognizes only `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` (other canonical versions reject as unsupported; no schema is ever retrieved, §5.2). Closed schema: an unknown top-level field or non-object `extensions` reports `ignored` and is dropped ([agent-plugins-spec#77](https://github.com/agentplugins/agent-plugins-spec/issues/77)); any other violation (including a non-object `extensions` member) rejects the plugin; namespace contents are never inspected (§8.1). Metadata (`version`, URLs, `author.email`, `license`) is checked by JSON type only (§5.4). |

## §agent-plugins-containment 2. Containment, Components, and MCP Entries

Package paths are checked lexically and, when existing, after symlink resolution (§4.1).

| Surface | Contract |
| --- | --- |
| Containment outcomes | Path outside plugin root: `plugin.json` $\to$ plugin `rejected`; `skills/` or `mcp.json` $\to$ component type `invalid`; discovered `SKILL.md` $\to$ skill `skipped`; `./` command or `./` / `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` `cwd` escaping root or data dir $\to$ server `skipped` (consumer rechecks resolved `PLUGIN_DATA` path at launch). |
| Components (`skills/`, `mcp.json`) | Absent $\to$ no components and no report (§6.2); wrong file kind or filesystem error $\to$ reported at narrowest component/entry boundary while unaffected components load. `skills/<child>/SKILL.md` checks immediate children only (§7.1) via {§agent-skills-directory} (failures `skipped`). `mcp.json` with invalid JSON, unknown top-level field, missing `mcpServers`, or mismatched `$schema` marks MCP `invalid` (§7.2.2, §10.1). |
| MCP server entries | Validated individually (invalid entry `skipped`, siblings load). Every entry is an object with `type: 'stdio' \| 'streamable-http' \| 'sse'` and no unknown or cross-variant fields. `stdio`: single-token whitespace-free `command` (bare name without `/` or `./` plugin path), string `args`/`env` (never setting `PLUGIN_ROOT` or `PLUGIN_DATA`, §9.2), `cwd` starting with `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}`. `streamable-http`/`sse`: absolute `http`/`https` `url` without whitespace, userinfo, or fragment (`http` only for `localhost` or loopback IP literal), and case-insensitively unique valid `headers`. |

## §agent-plugins-expansion 3. Placeholders, Reports, Module Slice, and Conformance

- **Placeholders**: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in one single textual pass; replacement text is never rescanned and other `${…}` tokens stay literal (§9.2).
- **Reports**: Each finding records plugin directory, relative path (`plugin.json`, `skills/<name>`, `mcp.json#/mcpServers/<JSON pointer segment>`), specification section (`client` for Plurnk-owned rules), outcome (`rejected`, `invalid`, `skipped`, `ignored`, `shadowed`), and one sentence.
- **Module slice (`WorkspacePluginsSeam`)**: `readWorkspacePlugins(workspaceId)` returns `WorkspacePluginSet` (plugins in root precedence order as `InstalledPlugin` with `PLUGIN_DATA` directory, reports, change signature across plugin/manifest/MCP/skills, and read roots or `null` where unread, with opaque host-named scopes per {§functionality-inspection} and {§module-seam-slices}).
- **Conformance corpus**: Each `test/conformance/<case>/` holds a plugin root and `expected.json` (section, requirement, `accepted`/`rejected`, discovered skills, MCP servers or `null`, and reports by path, section, and outcome).
