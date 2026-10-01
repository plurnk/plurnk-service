import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentPluginFiles, expandPlaceholders } from "@plurnk/plurnk-meta/agent-plugin";
import type { McpServerDefinition } from "@plurnk/plurnk-contracts";

export interface PluginContext {
    readonly root: string;
    readonly data: string;
}

type StdioDefinition = Extract<McpServerDefinition, { type: "stdio" }>;

// {§mcp-plugin-configuration} Interpretation belongs to the complete source definition, not provenance.
export default class PluginConfiguration {
    static resolve(source: StdioDefinition, context: PluginContext) {
        const expand = (value: string): string => expandPlaceholders(value, context);
        return {
            type: "stdio" as const,
            command: source.command.startsWith("./") ? resolve(context.root, source.command) : source.command,
            args: (source.args ?? []).map(expand),
            cwd: resolve(context.root, expand(source.cwd ?? "${PLUGIN_ROOT}")),
            env: {
                ...Object.fromEntries(Object.entries(source.env ?? {}).map(([name, value]) => [name, expand(value)])),
                PLUGIN_ROOT: context.root,
                PLUGIN_DATA: context.data,
            },
        };
    }

    static async prepare(source: StdioDefinition, context: PluginContext): Promise<void> {
        await mkdir(context.data, { recursive: true });
        const definition = PluginConfiguration.resolve(source, context);
        const root = source.cwd?.startsWith("${PLUGIN_DATA}") ? context.data : context.root;
        for (const [field, base, path] of [
            ["cwd", root, definition.cwd],
            ...(source.command.startsWith("./") ? [["command", context.root, definition.command]] : []),
        ] as [string, string, string][]) {
            if (!await AgentPluginFiles.contained(await realpath(base), path)) {
                throw new TypeError(`MCP server '${source.name}' ${field} resolves outside its plugin ${field === "cwd" && root === context.data ? "data directory" : "root"}.`);
            }
        }
    }
}
