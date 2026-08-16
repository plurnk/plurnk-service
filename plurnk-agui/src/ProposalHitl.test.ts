// The in-process HITL core, tested against a MOCK seam (no daemon) — validates the
// flagship round-trip in-process: a loop/proposal event → a tool-call to the right
// workspace; a resume tool-result → resolveProposal; pending re-surfaced on connect.

import { test } from "node:test";
import assert from "node:assert/strict";
import ProposalHitl, { type HitlBatch } from "./ProposalHitl.ts";
import type {
    DaemonSeam,
    PendingClientInteraction,
    PendingProposal,
    ProposalResolution,
} from "./DaemonSeam.ts";
import {
    DEFAULT_LOOP_FLAGS,
    type ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";

const proposal = (over: Partial<PendingProposal> = {}): PendingProposal => ({
    logEntryId: 5,
    workerId: 1,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", pathname: "a" },
    body: "diff",
    attrs: {},
    flags: DEFAULT_LOOP_FLAGS,
    staleClobberRisk: false,
    disposition: { owner: "client" },
    ...over,
});

const interaction = (over: Partial<PendingClientInteraction> = {}): PendingClientInteraction => ({
    interactionId: 12,
    workerId: 1,
    loopId: 1,
    turnId: 1,
    request: {
        toolName: "select_repository",
        arguments: { owner: "plurnk" },
        message: "Choose one repository.",
        responseSchema: {
            type: "object",
            properties: { repository: { type: "string" } },
            required: ["repository"],
        },
    },
    ...over,
});

const mockSeam = (
    pending: PendingProposal[] = [],
    pendingInteractions: PendingClientInteraction[] = [],
) => {
    let handler: ((s: number | null, m: string, p: unknown) => void) | null = null;
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const interactionResolves: Array<{
        interactionId: number;
        resolution: ClientInteractionResolution;
    }> = [];
    const seam: Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "pendingClientInteractions" | "resolveClientInteraction"> = {
        subscribeToEvents: (h) => { handler = h; return () => { handler = null; }; },
        pendingProposals: async () => pending,
        pendingClientInteractions: async () => pendingInteractions,
        resolveProposal: (logEntryId, resolution) => { resolves.push({ logEntryId, resolution }); },
        resolveClientInteraction: async (interactionId, resolution) => {
            interactionResolves.push({ interactionId, resolution });
        },
    };
    return {
        seam,
        fire: (s: number | null, m: string, p: unknown) => handler?.(s, m, p),
        resolves,
        interactionResolves,
        subscribed: () => handler !== null,
    };
};

const emitted: Array<{ workspaceId: number; workerId: number; batch: HitlBatch }> = [];
const collect = () => { emitted.length = 0; return (workspaceId: number, workerId: number, batch: HitlBatch) => emitted.push({ workspaceId, workerId, batch }); };

test("start(): a loop/proposal event → a tool-call fanned to that workspace", () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    assert.ok(m.subscribed(), "subscribed to the event source");
    m.fire(7, "loop/proposal", proposal({ logEntryId: 42, workerId: 9, target: { scheme: "file", pathname: "README.md" } }));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].workspaceId, 7, "fanned to the event's workspace");
    assert.equal(emitted[0].workerId, 9, "addressed to the proposal's owning worker");
    assert.equal(emitted[0].batch.events[0].type, "TOOL_CALL_START");
    assert.equal((emitted[0].batch.events[0] as { toolCallId: string }).toolCallId, "prop:42");
    // an unrelated event is ignored
    m.fire(7, "log/entry", { entry: {} });
    assert.equal(emitted.length, 1, "non-proposal events don't render tool-calls here");
    hitl.stop();
    assert.ok(!m.subscribed(), "stop() unsubscribes");
});

test("start(): a generic loop/interaction uses the requested tool name and schema", () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    m.fire(7, "loop/interaction", interaction({ interactionId: 40, workerId: 9 }));

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0].batch.events, [
        { type: "TOOL_CALL_START", toolCallId: "int:40", toolCallName: "select_repository" },
        { type: "TOOL_CALL_ARGS", toolCallId: "int:40", delta: JSON.stringify({ owner: "plurnk" }) },
        { type: "TOOL_CALL_END", toolCallId: "int:40" },
    ]);
    assert.deepEqual(emitted[0].batch.interrupts[0], {
        id: "int:40",
        reason: "tool_call",
        toolCallId: "int:40",
        message: "Choose one repository.",
        responseSchema: interaction().request.responseSchema,
    });
    hitl.stop();
});

test("resolve(): a complete standard resume resolves the exact worker proposal", async () => {
    const m = mockSeam([proposal({ logEntryId: 42, loopId: 7 })]);
    const hitl = new ProposalHitl(m.seam, collect());
    assert.deepEqual(await hitl.resolve(3, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept", body: "edited" } }]), { loopId: 7, workerId: 1 });
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited" } });
    await assert.rejects(
        hitl.resolve(3, [{ interruptId: "call_frontend_tool_9", status: "resolved", payload: {} }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; recovery?: string } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.dev/agui/interrupt/interrupt-invalid");
            assert.match(problem?.recovery ?? "", /pending tool calls/);
            return true;
        },
    );
    assert.equal(m.resolves.length, 1, "the foreign tool-result issued no resolve");
});

test("resurface(): a workspace's pending stopped-worlds come back as tool-calls", async () => {
    const pending: PendingProposal[] = [
        proposal({ logEntryId: 5, op: "EXEC", target: { scheme: null, pathname: null }, body: "rm -rf /tmp/x", attrs: { command: "rm" } }),
        proposal({ logEntryId: 9, turnId: 2, op: "SEND", target: { scheme: null, pathname: null }, body: "", attrs: { question: "which env?" } }),
        proposal({ logEntryId: 10, disposition: { owner: "loop", decision: "accept" } }),
    ];
    const hitl = new ProposalHitl(mockSeam(pending).seam, collect());
    const { events } = await hitl.resurface(1);
    const starts = events.filter((e) => e.type === "TOOL_CALL_START") as Array<{ toolCallId: string; toolCallName: string }>;
    assert.deepEqual(starts.map((s) => s.toolCallId), ["prop:5", "prop:9"], "only client-owned pending proposals re-surfaced");
    assert.equal(starts[1].toolCallName, "request_user_input", "the [300] SEND re-surfaces as an input request");
});

test("resolve(): proposals and interactions share one complete worker-scoped resume", async () => {
    const m = mockSeam(
        [proposal({ logEntryId: 42, loopId: 7 })],
        [interaction({ interactionId: 12, loopId: 7 })],
    );
    const hitl = new ProposalHitl(m.seam, collect());
    assert.deepEqual(await hitl.resolve(3, [
        { interruptId: "prop:42", status: "resolved", payload: { decision: "accept" } },
        { interruptId: "int:12", status: "resolved", payload: { repository: "plurnk-service" } },
    ]), { loopId: 7, workerId: 1 });
    assert.deepEqual(m.resolves, [
        { logEntryId: 42, resolution: { decision: "accept" } },
    ]);
    assert.deepEqual(m.interactionResolves, [{
        interactionId: 12,
        resolution: { status: "resolved", payload: { repository: "plurnk-service" } },
    }]);
});

test("interrupt resume validation exposes exact Problems with the complete pending set", async () => {
    const pending: PendingProposal[] = [
        proposal({ logEntryId: 5, loopId: 7 }),
        proposal({ logEntryId: 6, loopId: 7, target: { scheme: "file", pathname: "b" } }),
        proposal({ logEntryId: 7, loopId: 7, disposition: { owner: "loop", decision: "accept" } }),
    ];
    const hitl = new ProposalHitl(mockSeam(pending).seam, collect());
    await assert.rejects(
        hitl.resolve(3, [{ interruptId: "prop:5", status: "resolved", payload: { decision: "accept" } }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; pendingInterruptIds?: string[]; receivedInterruptIds?: string[] } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.dev/agui/interrupt/interrupt-set-incomplete");
            assert.deepEqual(problem?.pendingInterruptIds, ["prop:5", "prop:6"]);
            assert.deepEqual(problem?.receivedInterruptIds, ["prop:5"]);
            return true;
        },
    );
    await assert.rejects(
        hitl.resolve(3, [{ interruptId: "prop:99", status: "resolved", payload: { decision: "accept" } }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; pendingInterruptIds?: string[] } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.dev/agui/interrupt/interrupt-not-pending");
            assert.deepEqual(problem?.pendingInterruptIds, ["prop:5", "prop:6"]);
            return true;
        },
    );
});

test("proposal disposition, not raw loop flags, owns live tool-call presentation", () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    m.fire(7, "loop/proposal", proposal({
        logEntryId: 50,
        flags: { ...DEFAULT_LOOP_FLAGS, auto: true },
        disposition: { owner: "loop", decision: "accept" },
    }));
    m.fire(7, "loop/proposal", proposal({
        logEntryId: 51,
        op: "EXEC",
        flags: { ...DEFAULT_LOOP_FLAGS, noProposals: true },
        disposition: { owner: "loop", decision: "reject", outcome: "no_review_channel" },
    }));
    assert.equal(emitted.length, 0, "server settles in-process; the stream continues");
    m.fire(7, "loop/proposal", proposal({
        logEntryId: 52,
        op: "SEND",
        body: "",
        attrs: { question: "Which environment?" },
        flags: { ...DEFAULT_LOOP_FLAGS, auto: true, noProposals: true },
        disposition: { owner: "client" },
    }));
    assert.equal(emitted.length, 1, "an auto-loop question remains client-owned even when both raw policy flags are true");
    hitl.stop();
});
