// The in-process HITL core, tested against a MOCK seam (no daemon) — validates the
// flagship round-trip in-process: a loop/proposal event → a tool-call to the right
// workspace; a resume tool-result → resolveProposal; pending re-surfaced on connect.

import { test } from "node:test";
import assert from "node:assert/strict";
import ProposalHitl from "./ProposalHitl.ts";
import type { DaemonSeam, PendingProposal, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";
import { DEFAULT_LOOP_FLAGS } from "@plurnk/plurnk-contracts";

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

const mockSeam = (pending: PendingProposal[] = []) => {
    let handler: ((s: number | null, m: string, p: unknown) => void) | null = null;
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const seam: Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal"> = {
        subscribeToEvents: (h) => { handler = h; return () => { handler = null; }; },
        pendingProposals: async () => pending,
        resolveProposal: (logEntryId, resolution) => { resolves.push({ logEntryId, resolution }); },
    };
    return { seam, fire: (s: number | null, m: string, p: unknown) => handler?.(s, m, p), resolves, subscribed: () => handler !== null };
};

const emitted: Array<{ workspaceId: number; workerId: number; events: AguiEvent[] }> = [];
const collect = () => { emitted.length = 0; return (workspaceId: number, workerId: number, events: AguiEvent[]) => emitted.push({ workspaceId, workerId, events }); };

test("start(): a loop/proposal event → a tool-call fanned to that workspace", () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    assert.ok(m.subscribed(), "subscribed to the event source");
    m.fire(7, "loop/proposal", proposal({ logEntryId: 42, workerId: 9, target: { scheme: "file", pathname: "README.md" } }));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].workspaceId, 7, "fanned to the event's workspace");
    assert.equal(emitted[0].workerId, 9, "addressed to the proposal's owning worker");
    assert.equal(emitted[0].events[0].type, "TOOL_CALL_START");
    assert.equal((emitted[0].events[0] as { toolCallId: string }).toolCallId, "prop:42");
    // an unrelated event is ignored
    m.fire(7, "log/entry", { entry: {} });
    assert.equal(emitted.length, 1, "non-proposal events don't render tool-calls here");
    hitl.stop();
    assert.ok(!m.subscribed(), "stop() unsubscribes");
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
            assert.equal(problem?.type, "https://problems.plurnk.dev/agui/proposal/interrupt-invalid");
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
    const events = await hitl.resurface(1);
    const starts = events.filter((e) => e.type === "TOOL_CALL_START") as Array<{ toolCallId: string; toolCallName: string }>;
    assert.deepEqual(starts.map((s) => s.toolCallId), ["prop:5", "prop:9"], "only client-owned pending proposals re-surfaced");
    assert.equal(starts[1].toolCallName, "request_user_input", "the [300] SEND re-surfaces as an input request");
});

test("proposal resume validation exposes exact Problems with the pending-set facts", async () => {
    const pending: PendingProposal[] = [
        proposal({ logEntryId: 5, loopId: 7 }),
        proposal({ logEntryId: 6, loopId: 7, target: { scheme: "file", pathname: "b" } }),
        proposal({ logEntryId: 7, loopId: 7, disposition: { owner: "loop", decision: "accept" } }),
    ];
    const hitl = new ProposalHitl(mockSeam(pending).seam, collect());
    await assert.rejects(
        hitl.resolve(3, [{ interruptId: "prop:5", status: "resolved", payload: { decision: "accept" } }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; pendingProposalIds?: number[]; receivedProposalIds?: number[] } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.dev/agui/proposal/proposal-set-incomplete");
            assert.deepEqual(problem?.pendingProposalIds, [5, 6]);
            assert.deepEqual(problem?.receivedProposalIds, [5]);
            return true;
        },
    );
    await assert.rejects(
        hitl.resolve(3, [{ interruptId: "prop:99", status: "resolved", payload: { decision: "accept" } }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; pendingProposalIds?: number[] } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.dev/agui/proposal/proposal-not-pending");
            assert.deepEqual(problem?.pendingProposalIds, [5, 6]);
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
