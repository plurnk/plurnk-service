# Agent Plugins loader

§agent-plugins-scope This package implements the discovery, validation and failure boundaries of
[Agent Plugins 1.0.0](https://agent-plugins.org/specification) as a reference client. It reads the
directories its consumer names and returns validated plugins with typed reports. It installs,
executes and fetches nothing; enablement, trust, presentation and launching belong to its consumers.
Section numbers such as §5.2 cite the Agent Plugins specification, whose text governs where this page
is silent.

## §agent-plugins-roots Roots and shadowing

| Rule | Contract |
|---|---|
| Input | Ordered roots `{ scope, directory }`, followed by optional explicit installed directories in supplied order. An earlier source takes precedence. |
| Candidates | Every immediate child directory whose name does not begin with `.`. Files, such as another client's marketplace file, are not plugins, and a missing root holds none. |
| Identity | A plugin is identified by its manifest `name`, never its directory name: §11.1 loads a plugin from any path. |
| Shadowing | The first plugin with a name wins, by root order and then by directory name in code-point order; each later one is reported `shadowed`. |
| Filesystem failures | An unreadable root or candidate is reported `rejected`; other candidates remain available. |

## §agent-plugins-manifest Manifest

- `$schema` selects the rules. `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` is the one
  recognized identifier. A canonical identifier for another version is rejected as unsupported, and no
  schema is ever retrieved (§5.2).
- The manifest is closed. An unknown top-level field is reported `ignored` and dropped, and a non-object
  `extensions` is reported `ignored`. These are the only two non-fatal violations
  ([agent-plugins-spec#77](https://github.com/agentplugins/agent-plugins-spec/issues/77)); any other violation
  rejects the plugin, including an `extensions` member whose value is not an object. The contents of a
  namespace are never inspected (§8.1).
- Metadata fields are checked by JSON type only: `version`, the URLs, `author.email` and `license` are
  never rejected for their content (§5.4).

## §agent-plugins-containment Containment

A package path is checked lexically and, when it exists, again after symlinks resolve. A failure applies at
the narrowest boundary (§4.1):

| Path outside the plugin root | Outcome |
|---|---|
| `plugin.json` | the plugin is `rejected` |
| `skills/` or `mcp.json` | that component type is `invalid` |
| a discovered `SKILL.md` | that skill is `skipped` |
| a `./` command, or a `./` or `${PLUGIN_ROOT}` working directory after expansion | that server is `skipped` |
| a `${PLUGIN_DATA}` working directory that leaves the data directory | that server is `skipped`; the consumer checks the resolved path again at launch |

## §agent-plugins-components Components

| Location | Contract |
|---|---|
| `skills/` or `mcp.json` absent | no components of that type and no report (§6.2) |
| present but of the wrong kind | that type is `invalid`; the plugin's other components still load |
| unreadable paths | Filesystem errors are reported at the narrowest component or entry boundary; unaffected components still load. Programming errors remain failures. |
| `skills/<child>/SKILL.md` | immediate children only (§7.1). A skill that fails {§agent-skills-directory} is `skipped`. |
| `mcp.json` | invalid JSON, an unknown top-level field, a missing `mcpServers`, or a `$schema` other than the manifest's version makes MCP `invalid` for that plugin (§7.2.2, §10.1) |

## §agent-plugins-mcp-entries MCP server entries

Each entry is validated alone; an invalid entry is `skipped` and its siblings load (§7.2.2).

| Variant | Rules |
|---|---|
| every entry | an object whose `type` is `stdio`, `streamable-http` or `sse`, with no unknown field and no field of another variant |
| `stdio` | `command` is one token without whitespace: a bare name without `/`, or a `./` plugin path. `args` and `env` values are strings, and `env` never sets `PLUGIN_ROOT` or `PLUGIN_DATA` (§9.2). `cwd` begins `./`, `${PLUGIN_ROOT}` or `${PLUGIN_DATA}`. |
| `streamable-http`, `sse` | `url` is an absolute `http` or `https` URL without whitespace, user information or a fragment, and `http` only for `localhost` or a loopback IP literal. `headers` are valid field names and values, unique case-insensitively. |

The loader returns every valid variant; which transports are supported is the consumer's decision.

## §agent-plugins-expansion Placeholders

`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in one textual pass: text a replacement introduces is never
scanned again, and any other `${…}` stays literal (§9.2).

## §agent-plugins-reports Reports

Each finding is one report: the plugin directory, the path within it (`plugin.json`, `skills/<name>`,
`mcp.json#/mcpServers/<JSON pointer segment>`), the specification section, the outcome (`rejected`,
`invalid`, `skipped`, `ignored` or `shadowed`) and one sentence. Plurnk's own rules report the section
`client`.

## Module slice

§plugin-set-module-slice **A daemon module reads a workspace's installed plugins through
`WorkspacePluginsSeam`.** `readWorkspacePlugins(workspaceId)` returns a `WorkspacePluginSet`: the
plugins in root precedence order, each an `InstalledPlugin` with the `PLUGIN_DATA` directory its
subprocesses receive, the reports ({§agent-plugins-reports}), a signature that changes exactly when
a plugin, its manifest, its MCP configuration or its skills change, and each root the host reads,
null where it reads none. A root scope is opaque to this package, as it is to discovery; the host
names its scopes ({§agent-plugins-hosting}). These types complete the module contract's slices
({§module-seam-slices}).

## §agent-plugins-conformance Conformance corpus

Each `test/conformance/<case>/` holds one plugin root under test and an `expected.json` naming the section, the
normative requirement and the expected outcome: `accepted` or `rejected`, the discovered skills, the MCP
servers (`null` when MCP is absent or disabled) and the reports by path, section and outcome. The corpus is
the loader's test.
