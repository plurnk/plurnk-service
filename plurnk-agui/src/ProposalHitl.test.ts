// The in-process HITL core, tested against a MOCK seam (no daemon) — validates the
// flagship round-trip in-process: a loop/proposal event → a tool-call to the right
// workspace; a resume tool-result → resolveProposal; pending re-surfaced on connect.

import { test } from "node:test";
import assert from "node:assert/strict";
import ProposalHitl from "./ProposalHitl.ts";
import type { DaemonSeam, PendingProposal, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";

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
    m.fire(7, "loop/proposal", { logEntryId: 42, workerId: 9, op: "EDIT", target: { scheme: "file", pathname: "README.md" }, body: "diff", attrs: {} });
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
    const m = mockSeam([{ logEntryId: 42, workerId: 1, loopId: 7, turnId: 1, op: "EDIT", suffix: "", scheme: "file", pathname: "a", tx: "", attrs: null }]);
    const hitl = new ProposalHitl(m.seam, collect());
    assert.deepEqual(await hitl.resolve(3, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept", body: "edited" } }]), { loopId: 7, workerId: 1 });
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited" } });
    await assert.rejects(hitl.resolve(3, [{ interruptId: "call_frontend_tool_9", status: "resolved", payload: {} }]), /unknown PLURNK interrupt/);
    assert.equal(m.resolves.length, 1, "the foreign tool-result issued no resolve");
});

test("resurface(): a workspace's pending stopped-worlds come back as tool-calls", async () => {
    const pending: PendingProposal[] = [
        { logEntryId: 5, workerId: 1, loopId: 1, turnId: 1, op: "EXEC", suffix: "", scheme: "sh", pathname: null, tx: "rm -rf /tmp/x", attrs: '{"command":"rm"}' },
        { logEntryId: 9, workerId: 1, loopId: 1, turnId: 2, op: "SEND", suffix: "300", scheme: null, pathname: null, tx: "which env?", attrs: null },
    ];
    const hitl = new ProposalHitl(mockSeam(pending).seam, collect());
    const events = await hitl.resurface(1);
    const starts = events.filter((e) => e.type === "TOOL_CALL_START") as Array<{ toolCallId: string; toolCallName: string }>;
    assert.deepEqual(starts.map((s) => s.toolCallId), ["prop:5", "prop:9"], "both pending proposals re-surfaced");
    assert.equal(starts[1].toolCallName, "request_user_input", "the [300] SEND re-surfaces as an input request");
});

test("a server-owned proposal (flags.auto / noProposals) emits NO tool-call — the worker must not terminate", () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    m.fire(7, "loop/proposal", { logEntryId: 50, op: "EDIT", target: {}, body: "d", attrs: {}, flags: { auto: true } });
    m.fire(7, "loop/proposal", { logEntryId: 51, op: "EXEC", target: {}, body: "d", attrs: {}, flags: { noProposals: true } });
    assert.equal(emitted.length, 0, "server settles in-process; the stream continues");
    m.fire(7, "loop/proposal", { logEntryId: 52, op: "EDIT", target: {}, body: "d", attrs: {}, flags: {} });
    assert.equal(emitted.length, 1, "a client-owned proposal still rides the tool-call");
    hitl.stop();
});
