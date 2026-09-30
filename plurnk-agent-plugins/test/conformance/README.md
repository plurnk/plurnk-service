# Agent Plugins 1.0.0 client conformance corpus

One case per normative client requirement of the
[Agent Plugins specification](https://agent-plugins.org/specification). Each directory holds:

- `plugin/`, the plugin root a client loads;
- `outside/`, when present, a target that lies outside that root;
- `expected.json`, which names the section and requirement and the outcome a conformant client reaches.

| Field | Meaning |
|---|---|
| `plugin` | `accepted` or `rejected` |
| `skills` | the names of the skills discovered, sorted |
| `mcpServers` | the names of the valid server entries, sorted, or `null` when MCP is absent or disabled |
| `reports` | one `{ path, section, outcome }` per finding. `path` is `plugin.json`, `skills`, `skills/<name>`, `skills/<name>/SKILL.md`, `mcp.json`, or `mcp.json#/mcpServers/<name>`. `outcome` is `rejected`, `invalid`, `skipped`, or `ignored`. |

Symlinks are part of the cases; a checkout must preserve them. One case takes an interpretive position
where the specification and its schema disagree, and says so in its requirement:
`manifest-extensions-member-not-object`, after
[agent-plugins-spec#77](https://github.com/agentplugins/agent-plugins-spec/issues/77).
