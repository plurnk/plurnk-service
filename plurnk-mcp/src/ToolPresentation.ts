import type { Tool } from "@modelcontextprotocol/client";
import type { RuntimeToolRegistry } from "@plurnk/plurnk-execs";
import { summaryLine } from "./Summary.ts";

// {§mcp-summary-derivation}: purpose first; label fallback follows MCP title precedence.
const toolSummary = (tool: Tool, override?: string): string => {
    if (override !== undefined && override.trim() !== "") return override.trim();
    return summaryLine(tool.description) ?? summaryLine(tool.title) ?? summaryLine(tool.annotations?.title) ?? tool.name;
};

export const toolRegistry = (
    server: string,
    source: readonly Tool[],
    overrides?: ReadonlyMap<string, string>,
): RuntimeToolRegistry => {
    const tools = source.toSorted((left, right) => left.name.localeCompare(right.name));
    return {
        tools: tools.map((tool) => {
            return {
                target: tool.name,
                summary: toolSummary(tool, overrides?.get(`${server}/${tool.name}`)),
                invocation: {
                    body: {
                        role: "JSON arguments",
                        required: Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0,
                    },
                    target: {
                        role: "MCP tool",
                        required: true,
                        kind: "literal",
                    },
                    inputSchema: tool.inputSchema,
                },
                ...(tool.description === undefined ? {} : { details: tool.description }),
            };
        }),
    };
};
