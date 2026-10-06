// Integration harness: mock provider responses built from plurnk DSL.

import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { chatMessageText, type ChatMessage, type MockResponse } from "@plurnk/plurnk-providers";

// {§packet-wire-envelope} — the packet's text as the model reads it: every user message in order.
// Native parts ride the closing message alone; read `messages.at(-1)` for those.
export const userText = (messages: readonly ChatMessage[]): string =>
    messages.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");

// {§fence-heading-in-body} — every executor tag the integration fixtures write, as the daemon would name them.
export const TEST_EXECUTORS: readonly string[] = ["sh", "bash", "node", "python3", "sqlite", "jq", "gitea", "brave", "fixture", "fx", "dialogue", "tools", "question", "members", "skills", "env", "a2a", "svc", "mcp", "resource-tool", "optional-resource", "kubernetes", "goji", "example", "viaexec", "tool", "other", "registrytool", "calc", "workspacecap", "echo", "cdp", "playwright"];

// Fixtures mint executors freely; every fence tag a DSL text writes is an executor for that text.
export const fixtureExecutors = (text: string): readonly string[] => [...new Set([
    ...TEST_EXECUTORS,
    ...[...text.matchAll(/^`{3,}[0-9]*([a-z][A-Za-z0-9_.+-]*)/gmu)].map((match) => match[1]!),
])];

// Parse plurnk DSL into statement ops. Used to build mock provider responses.
export const parseDsl = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(text, { executors: fixtureExecutors(text) });
    const statements = result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
    // Recovery fixtures may omit a disposition, but must contain an executable operation.
    if (statements.length === 0 && result.items.some((i) => i.kind === "error")) {
        throw new Error(`parseDsl: DSL produced no statements: ${JSON.stringify(text)}`);
    }
    return statements;
};

// A response the parser admits nothing from (prose, bare headings): ops stay empty by design.
export const makeRawMockResponse = (text: string, completion: number = 0): MockResponse => ({
    ...makeMockResponse("````NOTE\n````", completion),
    // No pre-parsed ops: the engine parses the content itself and rejects it on its own terms.
    assistant: { content: text, reasoning: null } as MockResponse["assistant"],
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
