import type { ApplicationLoopPacket, ClientInteractionProjection, OperationResult, ProposalProjection } from "@plurnk/plurnk-contracts";
import type { TerminatedNotification } from "../src/types.ts";
import { loopUsage } from "./accounting-fixture.ts";

const OWNER = "acp://operator/threads/client";

export const termination = (
    overrides: Partial<TerminatedNotification> = {},
): TerminatedNotification => ({
    workerId: 10,
    loopId: 1,
    loopSeq: 1,
    result: { status: 200 },
    hitMaxTurns: false,
    turnIds: [1],
    attributions: [],
    usage: loopUsage(),
    terminatedAt: 1_792_008_205_250,
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
    worker: "main",
    loopId: 1,
    turnId: 1,
    coordinate: "1/1/42",
    op: "EDIT",
    target: { scheme: "file", authority: null, pathname: "/tmp/example" },
    body: "replacement",
    attrs: {},
    owner: OWNER,
    disposition: { decision: "review" },
} satisfies ProposalProjection);

export const interaction = Object.freeze({
    interactionId: 43,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    recipient: OWNER,
    request: {
        toolName: "request_user_input",
        arguments: {},
        responseSchema: { type: "object" },
    },
} satisfies ClientInteractionProjection);

// {§notifications-loop-packet} A packet of worker 10's loop 1, with no gauge facts known yet.
export const packet = (overrides: Partial<ApplicationLoopPacket> = {}): ApplicationLoopPacket => ({
    workerId: 10,
    loopId: 1,
    loopSeq: 1,
    packetCount: 1,
    gauge: { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null },
    ...overrides,
});

// {§acp-body-reference} The origin a test Run's client reached the daemon at.
export const ORIGIN = "http://acp.test";
