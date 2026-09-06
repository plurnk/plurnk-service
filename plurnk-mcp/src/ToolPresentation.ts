import type { Tool } from "@modelcontextprotocol/client";
import type { RuntimeToolRegistry } from "@plurnk/plurnk-execs";

const firstSentence = (text: string, cap = 80): string => {
    const normalized = text.replaceAll(/\s+/gu, " ").trim();
    const boundary = /[.!?](?:\s|$)/u.exec(normalized);
    const sentence = boundary === null ? normalized : normalized.slice(0, boundary.index + 1);
    if (sentence.length <= cap) return sentence;
    const clipped = sentence.slice(0, cap + 1);
    const wordBreak = clipped.lastIndexOf(" ");
    return `${wordBreak > cap / 2 ? clipped.slice(0, wordBreak) : clipped.slice(0, cap)}…`;
};

// {§mcp-summary-derivation} — one tool one-liner: authored override, then the
// spec's display title, then the first sentence of the authored description,
// then the tool name. Never the container template.
const toolSummary = (tool: Tool, override?: string): string => {
    if (override !== undefined && override.trim() !== "") return override.trim();
    const authored = tool.annotations?.title ?? tool.title ?? firstSentenceOrEmpty(tool.description);
    if (authored !== undefined && authored.trim() !== "") return authored.trim();
    return tool.name;
};

const firstSentenceOrEmpty = (description: string | undefined): string | undefined => {
    if (description === undefined) return undefined;
    const sentence = firstSentence(description);
    return sentence.length === 0 ? undefined : sentence;
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
