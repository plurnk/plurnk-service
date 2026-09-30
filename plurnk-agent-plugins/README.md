# @plurnk/plurnk-agent-plugins

Load [Agent Plugins](https://agent-plugins.org) the way the specification says to: a closed
`plugin.json`, containment, `skills/`, and `mcp.json`, with every failure isolated to its boundary.

```ts
import { PluginRoots } from "@plurnk/plurnk-agent-plugins";

const { plugins, reports } = await PluginRoots.discover([
    { scope: "project", directory: "/work/app/.agents/plugins" },
    { scope: "global", directory: "/home/me/.agents/plugins" },
]);
for (const plugin of plugins) {
    plugin.manifest.name;
    plugin.skills;      // Agent Skills, each a SkillDirectory
    plugin.mcpServers;  // validated mcp.json entries, or null
}
```

Each report names the plugin directory, the path within it, the specification section, and the
outcome. The consumer owns installation, enablement, trust, and launching. See [SPEC.md](SPEC.md).
