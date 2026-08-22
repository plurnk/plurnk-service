import { DEFAULT_LOOP_FLAGS, type OperationResult } from "@plurnk/plurnk-contracts";
import type { TerminatedNotification } from "../src/types.ts";
import { loopUsage } from "./accounting-fixture.ts";

export const termination = (
    overrides: Partial<TerminatedNotification> = {},
): TerminatedNotification => ({
    workerId: 10,
    loopId: 1,
    result: { status: 200 },
    hitMaxTurns: false,
    turnIds: [1],
    attributions: [],
    usage: loopUsage(),
    ...overrides,
});

export const streamEvent = (
    overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
    entryId: 9,
    workerId: 10,
    target: "worker:///1/1/9",
    channel: "body",
    state: "active",
    contentLength: 0,
    ...overrides,
});

export const streamConclusion = (
    overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
    entryId: 9,
    workerId: 10,
    target: "worker:///1/1/9",
    subscriptionId: 1,
    result: { status: 200 } satisfies OperationResult,
    scheme: "worker",
    summary: "complete",
    wakeAction: "no-loop",
    ...overrides,
});

export const proposal = Object.freeze({
    logEntryId: 42,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", pathname: "/tmp/example" },
    body: "replacement",
    attrs: {},
    flags: DEFAULT_LOOP_FLAGS,
    staleClobberRisk: false,
    disposition: { owner: "client" },
});

export const interaction = Object.freeze({
    interactionId: 43,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    request: {
        toolName: "request_user_input",
        arguments: {},
        responseSchema: { type: "object" },
    },
});
