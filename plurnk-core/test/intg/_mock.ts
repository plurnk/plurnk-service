// Integration harness: mock provider responses built from plurnk Code Mode statements.

import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { chatMessageText, type ChatMessage, type MockResponse } from "@plurnk/plurnk-providers";

// {§packet-assembly} — role-filtered user text, not the complete request.
// Native parts belong to the log's user message; the footer can be a separate message.
export const userText = (messages: readonly ChatMessage[]): string =>
    messages.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");

// {§operation-fences} — every executor tag the integration fixtures write, as the daemon would name them.
export const TEST_EXECUTORS: readonly string[] = ["sh", "bash", "js", "python3", "plurnk", "gitea", "brave", "fixture", "dialogue", "tools", "svc", "alpha", "keep", "later", "viaexec", "candidate", "held", "local", "resource-tool", "optional-resource", "kubernetes", "goji", "example", "tool", "other", "registrytool", "calc", "workspacecap", "echo", "cdp", "playwright"];

const CORE_AND_PLURNK_TOOLS = new Set([
    "read", "edit", "copy", "move", "kill", "find", "bare", "work", "fork", "send", "done", "fail", "wait", "note", "text",
    "environment", "env", "mcp", "members", "personas", "schedule", "skills", "question", "fx", "destroy",
    "ts", "javascript", "typescript", "node",
]);

// Fixtures mint executors freely; every service namespace a Code Mode text invokes is an executor for that text.
export const fixtureExecutors = (text: string): readonly string[] => [...new Set([
    ...TEST_EXECUTORS,
    ...[...text.matchAll(/\bawait\s+([A-Za-z_$][A-Za-z0-9_$-]*)\s*(?:\.|\[)/gu)]
        .map((match) => match[1] ?? "")
        .filter((name) => name !== "plurnk"),
    ...[...text.matchAll(/\bawait\s+plurnk(?:\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[\s*["']([^"']+)["']\s*\])/gu)]
        .map((match) => match[1] ?? match[2] ?? "")
        .filter((name) => name.length > 0 && !CORE_AND_PLURNK_TOOLS.has(name.toLowerCase())),
])];

// Parse plurnk Code Mode into statement ops. Used to build mock provider responses.
export const parseDsl = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(text, { executors: fixtureExecutors(text) });
    const statements = result.items
        .filter((i) => i.kind === "statement")
        .map((i) => i.statement);
    // Recovery fixtures may omit a disposition, but must contain an executable operation.
    if (statements.length === 0 && result.items.some((i) => i.kind === "error")) {
        throw new Error(`parseDsl: DSL produced no statements: ${JSON.stringify(text)}`);
    }
    return statements;
};

// A response the parser admits nothing from (prose, bare headings): ops stay empty by design.
export const makeRawMockResponse = (text: string, completion: number = 0): MockResponse => ({
    ...makeMockResponse("await plurnk.note({});", completion),
    // No pre-parsed ops: the engine parses the content itself and rejects it on its own terms.
    assistant: { content: text, reasoning: null },
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
