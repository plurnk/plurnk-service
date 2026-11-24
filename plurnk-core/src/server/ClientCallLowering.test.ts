import assert from "node:assert/strict";
import test from "node:test";
import { writtenOp } from "@plurnk/plurnk-contracts";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";
import { OperationFailureError } from "../core/results.ts";
import { lowerClientToolCalls } from "./ClientCallLowering.ts";

const fakeExecutors = {
    availableRuntimes: () => ["plurnk", "sh"],
    toolRegistry: (runtime: string) =>
        runtime === "plurnk"
            ? {
                  tools: [
                      { target: "mcp" },
                      { target: "skills" },
                      { target: "schedule" },
                  ],
              }
            : undefined,
} as unknown as ExecutorRegistry;

test("{§module-seam-slices} lowerClientToolCalls lowers valid core, runtime, and registered plurnk family calls", () => {
    const lowered = lowerClientToolCalls(
        [
            {
                server: "plurnk",
                tool: "read",
                arguments: { path: "workspace:///notes.md" },
                aside: "inspect notes",
            },
            {
                server: "sh",
                tool: "sh",
                arguments: { text: "echo ok" },
            },
            {
                server: "plurnk",
                tool: "skills",
                arguments: {},
            },
        ],
        fakeExecutors,
        1,
    );
    assert.equal(lowered.length, 3);
    assert.equal(writtenOp(lowered[0]), "read");
    assert.equal(lowered[0].aside, "inspect notes");
    assert.equal(writtenOp(lowered[1]), "sh");
    assert.equal(writtenOp(lowered[2]), "plurnk");
});

test("{§module-seam-slices} lowerClientToolCalls refuses empty arrays, malformed steps, turn-only verbs, question, unknown plurnk tools, and log kills", () => {
    const invalidCases: ReadonlyArray<readonly [Parameters<typeof lowerClientToolCalls>[0], RegExp]> = [
        [[], /must contain at least one tool call/u],
        [[{ server: "plurnk", tool: "read", arguments: {} }], /could not be lowered/u],
        [[{ server: "plurnk", tool: "done", arguments: { text: "bye" } }], /turn-only verb 'done'/u],
        [[{ server: "plurnk", tool: "fail", arguments: { text: "err" } }], /turn-only verb 'fail'/u],
        [[{ server: "plurnk", tool: "wait", arguments: {} }], /turn-only verb 'wait'/u],
        [[{ server: "plurnk", tool: "question", arguments: { prompt: "Continue?" } }], /invokes 'plurnk\.question'/u],
        [[{ server: "plurnk", tool: "nonexistent", arguments: {} }], /unknown plurnk tool 'nonexistent'/u],
        [[{ server: "plurnk", tool: "kill", arguments: { path: "log:///1/1/1/read" } }], /targets 'log:\/\/\/' with kill/u],
    ];

    for (const [calls, pattern] of invalidCases) {
        assert.throws(
            () => lowerClientToolCalls(calls, fakeExecutors, 1),
            (err: unknown) => err instanceof OperationFailureError && pattern.test(err.message),
            `expected ${JSON.stringify(calls)} to match ${String(pattern)}`,
        );
    }
});
