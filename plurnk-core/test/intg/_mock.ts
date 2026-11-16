// Integration harness: mock provider responses built from plurnk MCP statements and structured `mcp` toolCalls.

import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { chatMessageText, type ChatMessage, type FinishReason, type MockResponse, type ProviderToolCall } from "@plurnk/plurnk-providers";

// {§packet-assembly} — role-filtered user + tool receipt text, not the complete request.
// Native parts belong to the log's user message; paired receipts sit in `tool` messages.
export const userText = (messages: readonly ChatMessage[]): string =>
    messages.filter(({ role }) => role === "user" || role === "tool").map(chatMessageText).join("\n\n");

// {§mcp-expressions} — every executor tag the integration fixtures write, as the daemon would name them.
export const TEST_EXECUTORS: readonly string[] = ["sh", "bash", "js", "python3", "plurnk", "gitea", "brave", "fixture", "dialogue", "tools", "svc", "alpha", "keep", "later", "viaexec", "candidate", "held", "local", "resource-tool", "optional-resource", "kubernetes", "goji", "example", "tool", "other", "registrytool", "calc", "workspacecap", "echo", "cdp", "playwright"];

const CORE_AND_PLURNK_TOOLS = new Set([
    "read", "edit", "copy", "move", "kill", "find", "bare", "work", "fork", "send", "done", "fail", "wait", "note", "text",
    "environment", "env", "mcp", "members", "personas", "schedule", "skills", "question", "fx", "destroy",
    "ts", "javascript", "typescript", "node",
]);

// Fixtures mint executors freely; every service namespace an MCP expression text invokes is an executor for that text.
export const fixtureExecutors = (text: string): readonly string[] => [...new Set([
    ...TEST_EXECUTORS,
    ...[...text.matchAll(/(?:^|\n|\bawait\s+)([A-Za-z_$][A-Za-z0-9_$-]*)\s*(?:\.|\[)/gu)]
        .map((match) => match[1] ?? "")
        .filter((name) => name !== "plurnk"),
    ...[...text.matchAll(/(?:^|\n|\bawait\s+)plurnk(?:\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[\s*["']([^"']+)["']\s*\])/gu)]
        .map((match) => match[1] ?? match[2] ?? "")
        .filter((name) => name.length > 0 && !CORE_AND_PLURNK_TOOLS.has(name.toLowerCase())),
])];

// Parse plurnk MCP statement blocks into statement ops. Used to build mock provider responses.
export const parseDsl = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parseStatements(text, { executors: fixtureExecutors(text) });
    const statements = result.items
        .filter((i) => i.kind === "statement")
        .map((i) => i.statement);
    if (statements.length === 0 && result.items.some((i) => i.kind === "error")) {
        throw new Error(`parseDsl: DSL produced no statements: ${JSON.stringify(text)}`);
    }
    return statements;
};

// Project a statement block into structured wire `mcp` toolCalls for source-backed Mock responses.
export const mcpToolCalls = (dsl: string, idPrefix = "mock_call"): ProviderToolCall[] =>
    parseDsl(dsl).map((stmt, index) => {
        const payload = PlurnkParser.toMcpCall(stmt);
        return {
            index,
            id: `${idPrefix}_${index}`,
            type: "function",
            name: "mcp",
            arguments: JSON.stringify({
                server: payload.server,
                tool: payload.tool,
                arguments: payload.arguments,
                ...(payload.aside === undefined ? {} : { aside: payload.aside }),
            }),
        };
    });

// Build a source-backed Mock response using structured `mcp` toolCalls.
export const mcpMockTurn = (
    dsl: string,
    options: {
        readonly content?: string;
        readonly reasoning?: string | null;
        readonly finishReason?: FinishReason;
        readonly model?: string;
        readonly usage?: MockResponse["usage"];
        readonly cost?: MockResponse["cost"];
        readonly assistantRaw?: unknown;
    } = {},
): MockResponse => {
    const toolCalls = dsl.trim().length === 0 ? [] : mcpToolCalls(dsl);
    return {
        assistant: {
            content: options.content ?? "",
            reasoning: options.reasoning ?? null,
            ...(options.finishReason === undefined ? {} : { finishReason: options.finishReason }),
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(toolCalls.length === 0 ? {} : { toolCalls }),
        },
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        ...(options.cost === undefined ? {} : { cost: options.cost }),
        assistantRaw: options.assistantRaw ?? null,
    };
};

// A response the parser rejects before dispatch (malformed `mcp` tool call or fabricated log heading).
export const makeRawMockResponse = (text: string, completion: number = 0): MockResponse => ({
    ...makeMockResponse("await plurnk.note({});", completion),
    assistant: text.includes("### log:///") || text.includes("**plurnk:")
        ? { content: text, reasoning: null }
        : text.trim().length === 0
            ? { content: "", reasoning: null }
            : {
                content: "",
                reasoning: null,
                finishReason: "tool_calls",
                toolCalls: [{ id: "bad_call_0", name: "mcp", arguments: text }],
            },
});

export const makeMockResponse = (dsl: string, completion: number = 0): MockResponse => {
    return {
        assistant: {
            content: dsl, ops: parseDsl(dsl), reasoning: null,
        },
        usage: {
            inputTokens: 0,
            outputTokens: completion,
            totalTokens: completion,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: completion, reasoningTokens: 0 },
        },
        assistantRaw: null,
    };
};

// {§message-completion}: the scripted model's reply, optionally beside operations
// whose results must still be observed before the loop can settle.
export const answer = (text: string, operations: string = ""): MockResponse => makeMockResponse(
    [...(operations.length > 0 ? [operations] : []), `await plurnk.done(${JSON.stringify(text.length > 0 ? { text } : {})});`].join("\n"),
);
