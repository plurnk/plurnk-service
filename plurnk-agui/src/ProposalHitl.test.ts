// The in-process HITL core, tested against a MOCK seam (no daemon) — validates the
// flagship round-trip in-process: a loop/proposal event → a gate on the call it
// concerns, delivered to the right workspace; a resume → resolveProposal; pending
// re-surfaced on connect.

import { test } from "node:test";
import assert from "node:assert/strict";
import ProposalHitl, { type HitlDelivery } from "./ProposalHitl.ts";
import { proposalKey } from "./AguiPlus.ts";
import type {
    ClientInteractionProjection,
    ProposalProjection,
    ProposalResolution,
} from "@plurnk/plurnk-contracts";
import type { ClientInteractionResolution } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { wireRow } from "../test/log-fixture.ts";

const OWNER = "agui://anonymous/threads/tui";

const proposal = (over: Partial<ProposalProjection> = {}): ProposalProjection => ({
    logEntryId: 5,
    workerId: 1,
    worker: "main",
    loopId: 1,
    turnId: 1,
    coordinate: "1/1/5",
    op: "EDIT",
    target: { scheme: "file", authority: null, pathname: "a" },
    body: "diff",
    attrs: {},
    owner: OWNER,
    disposition: { decision: "review" },
    ...over,
});

const interaction = (over: Partial<ClientInteractionProjection> = {}): ClientInteractionProjection => ({
    interactionId: 12,
    recipient: OWNER,
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

// The gated operation's row, read by its coordinate, as core holds it while it awaits its decision.
const gatedRow = (workerId: number, loopSeq: number, turnSeq: number, sequence: number) =>
    wireRow({ id: sequence, worker_id: workerId, loop_seq: loopSeq, turn_seq: turnSeq, sequence, op: "EDIT", scheme: "file", pathname: "a",
        status_rx: 202, rx: { status: 202 }, attrs: { patch: "…" }, state: "proposed" });

const mockSeam = (
    pending: ProposalProjection[] = [],
    pendingInteractions: ClientInteractionProjection[] = [],
) => {
    let handler: ((s: number | null, m: string, p: unknown) => void) | null = null;
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const interactionResolves: Array<{
        interactionId: number;
        resolution: ClientInteractionResolution;
    }> = [];
    const reads: Array<{ workerId: number; coordinate: string }> = [];
    const seam: Pick<ApplicationPort, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "pendingClientInteractions" | "resolveClientInteraction" | "readLog"> = {
        subscribeToEvents: (h) => { handler = h; return () => { handler = null; }; },
        pendingProposals: async () => pending,
        pendingClientInteractions: async () => pendingInteractions,
        resolveProposal: async (logEntryId, resolution, owner) => {
            assert.equal(owner.address, OWNER); resolves.push({ logEntryId, resolution }); },
        resolveClientInteraction: async (interactionId, resolution, owner) => {
            assert.equal(owner.address, OWNER);
            interactionResolves.push({ interactionId, resolution });
        },
        readLog: async ({ workerId, loopSeq, turnSeq, sequence }) => {
            reads.push({ workerId, coordinate: `${loopSeq}/${turnSeq}/${sequence}` });
            return [gatedRow(workerId, loopSeq!, turnSeq!, sequence!)];
        },
    };
    return {
        seam,
        fire: (s: number | null, m: string, p: unknown) => handler?.(s, m, p),
        resolves,
        interactionResolves,
        reads,
        subscribed: () => handler !== null,
    };
};

const emitted: Array<{ workspaceId: number } & HitlDelivery> = [];
const collect = () => {
    emitted.length = 0;
    return (workspaceId: number, delivery: Promise<HitlDelivery>) =>
        void delivery.then((value) => emitted.push({ workspaceId, ...value }));
};
// A gate renders after reading its row: let that settle.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("{§agui-proposal-resolve} start(): a loop/proposal event → a gate on the call it concerns, fanned to that workspace", async () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    assert.ok(m.subscribed(), "subscribed to the event source");
    m.fire(7, "loop/proposal", proposal({ logEntryId: 42, workerId: 9, worker: "helper", coordinate: "2/3/4" }));
    await settled();
    assert.equal(emitted.length, 1);
    const [delivery] = emitted;
    assert.deepEqual([delivery!.workspaceId, delivery!.workerId, delivery!.loopId], [7, 9, 1], "fanned to the event's workspace, its worker and loop");
    assert.deepEqual(delivery!.batch.events, [], "the Portal presents the operation's call on each Run");
    const [gate] = delivery!.batch.gates;
    assert.deepEqual([gate!.key, gate!.kind, gate!.interrupt.reason, gate!.interrupt.toolCallId], [proposalKey(42), "proposal", "tool_call", undefined]);
    assert.deepEqual(gate!.interrupt.metadata?.plurnk?.proposal?.worker, "helper", "the interrupt carries Core's projection");
    assert.deepEqual(m.reads, [{ workerId: 9, coordinate: "2/3/4" }], "the gated row is read by its coordinate");
    const { workerId, loopId, coordinate, entry } = gate!.call!;
    assert.deepEqual({ workerId, loopId, coordinate }, { workerId: 9, loopId: 1, coordinate: "2/3/4" });
    assert.deepEqual([entry.op, entry.status_rx, entry.state, `${entry.loop_seq}/${entry.turn_seq}/${entry.sequence}`], ["EDIT", 202, "proposed", "2/3/4"],
        "the gate carries the operation's row awaiting its decision");
    // an unrelated event is ignored
    m.fire(7, "log/entry", { entry: {} });
    await settled();
    assert.equal(emitted.length, 1, "non-proposal events present no gate here");
    hitl.stop();
    assert.ok(!m.subscribed(), "stop() unsubscribes");
});

test("start(): a generic loop/interaction is its own call, under the requested tool name and schema", async () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    m.fire(7, "loop/interaction", interaction({ interactionId: 40, workerId: 9 }));
    await settled();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.loopId, 1, "addressed to the interaction's owning loop");
    assert.deepEqual(emitted[0]!.batch.events, [
        { type: "TOOL_CALL_START", toolCallId: "int:40", toolCallName: "select_repository" },
        { type: "TOOL_CALL_ARGS", toolCallId: "int:40", delta: JSON.stringify({ owner: "plurnk" }) },
        { type: "TOOL_CALL_END", toolCallId: "int:40" },
    ]);
    assert.deepEqual(emitted[0]!.batch.gates, [{
        key: "int:40",
        kind: "interaction",
        interrupt: {
            reason: "tool_call",
            toolCallId: "int:40",
            message: "Choose one repository.",
            responseSchema: interaction().request.responseSchema,
        },
    }]);
    assert.deepEqual(m.reads, [], "an interaction reads no row");
    hitl.stop();
});

test("resolve(): a complete standard resume resolves the exact worker proposal", async () => {
    const m = mockSeam([proposal({ logEntryId: 42, loopId: 7 })]);
    const hitl = new ProposalHitl(m.seam, collect());
    assert.deepEqual(await hitl.resolve(3, OWNER, [{ interruptId: proposalKey(42), status: "resolved", payload: { decision: "accept", body: "edited" } }]), { loopId: 7, workerId: 1 });
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited" } });
    await assert.rejects(
        hitl.resolve(3, OWNER, [{ interruptId: "call_frontend_tool_9", status: "resolved", payload: {} }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; recovery?: string } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/agui/interrupt/interrupt-invalid");
            assert.match(problem?.recovery ?? "", /pending tool calls/);
            return true;
        },
    );
    assert.equal(m.resolves.length, 1, "the foreign resume issued no resolve");
});

test("{§agui-proposal-resolve} valid outcomes reach the owner and invalid outcomes release nothing", async () => {
    const m = mockSeam([proposal({ logEntryId: 42, loopId: 7 })]);
    const hitl = new ProposalHitl(m.seam, collect());
    for (const decision of ["accept", "reject", "cancel"] as const) {
        await hitl.resolve(3, OWNER, [{ interruptId: proposalKey(42), status: "resolved", payload: { decision, outcome: "client_reason" } }]);
        assert.deepEqual(m.resolves.at(-1), { logEntryId: 42, resolution: { decision, outcome: "client_reason" } });
    }
    await hitl.resolve(3, OWNER, [{ interruptId: proposalKey(42), status: "cancelled", payload: { outcome: "client_cancelled" } }]);
    assert.deepEqual(m.resolves.at(-1), { logEntryId: 42, resolution: { decision: "cancel", outcome: "client_cancelled" } });
    let released = false;
    await assert.rejects(hitl.resolve(3, OWNER, [{ interruptId: proposalKey(42), status: "resolved", payload: { decision: "accept", outcome: 42 } }], () => { released = true; }),
        (error: unknown) => (error as { problem?: { type?: string } }).problem?.type === "https://problems.plurnk.xyz/agui/interrupt/interrupt-invalid");
    assert.equal(released, false);
    assert.equal(m.resolves.length, 4);
});

test("{§agui-proposal-disposition} resurface(): a workspace's pending stopped-worlds come back as gates on their calls", async () => {
    const pending: ProposalProjection[] = [
        proposal({ logEntryId: 5, op: "sh", target: { scheme: null, authority: null, pathname: null }, body: "rm -rf /tmp/x", attrs: { command: "rm" } }),
        proposal({ logEntryId: 10, coordinate: "1/1/10", disposition: { decision: "accept" } }),
    ];
    const m = mockSeam(pending);
    const hitl = new ProposalHitl(m.seam, collect());
    const [delivery] = await hitl.resurface(1, OWNER);
    assert.ok(delivery !== undefined);
    assert.deepEqual(delivery.batch.gates.map(({ key, call }) => [key, call?.coordinate]), [[proposalKey(5), "1/1/5"]],
        "only client-owned pending proposals re-surfaced, each on its own call");
    assert.deepEqual(delivery.batch.events, []);
});

test("resolve(): proposals and interactions share one complete worker-scoped resume", async () => {
    const m = mockSeam(
        [proposal({ logEntryId: 42, loopId: 7 })],
        [interaction({ interactionId: 12, loopId: 7 })],
    );
    const hitl = new ProposalHitl(m.seam, collect());
    assert.deepEqual(await hitl.resolve(3, OWNER, [
        { interruptId: proposalKey(42), status: "resolved", payload: { decision: "accept" } },
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
    const pending: ProposalProjection[] = [
        proposal({ logEntryId: 5, loopId: 7 }),
        proposal({ logEntryId: 6, loopId: 7, coordinate: "1/1/6", target: { scheme: "file", authority: null, pathname: "b" } }),
        proposal({ logEntryId: 7, loopId: 7, coordinate: "1/1/7", disposition: { decision: "accept" } }),
    ];
    const hitl = new ProposalHitl(mockSeam(pending).seam, collect());
    await assert.rejects(
        hitl.resolve(3, OWNER, [{ interruptId: proposalKey(5), status: "resolved", payload: { decision: "accept" } }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; pendingInterruptIds?: string[]; receivedInterruptIds?: string[] } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/agui/interrupt/interrupt-set-incomplete");
            assert.deepEqual(problem?.pendingInterruptIds, [proposalKey(5), proposalKey(6)]);
            assert.deepEqual(problem?.receivedInterruptIds, [proposalKey(5)]);
            return true;
        },
    );
    await assert.rejects(
        hitl.resolve(3, OWNER, [{ interruptId: proposalKey(99), status: "resolved", payload: { decision: "accept" } }]),
        (error: unknown) => {
            const problem = (error as { problem?: { type?: string; pendingInterruptIds?: string[] } }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/agui/interrupt/interrupt-not-pending");
            assert.deepEqual(problem?.pendingInterruptIds, [proposalKey(5), proposalKey(6)]);
            return true;
        },
    );
});

test("{§agui-proposal-disposition} {§proposal-ownership-notification} proposal disposition owns live gate presentation", async () => {
    const m = mockSeam();
    const hitl = new ProposalHitl(m.seam, collect());
    hitl.start();
    m.fire(7, "loop/proposal", proposal({ logEntryId: 50, coordinate: "1/1/50", disposition: { decision: "accept" } }));
    m.fire(7, "loop/proposal", proposal({ logEntryId: 51, coordinate: "1/1/51", op: "sh", disposition: { decision: "reject", outcome: "no_review_channel" } }));
    await settled();
    assert.equal(emitted.length, 0, "server settles in-process; the stream continues");
    m.fire(7, "loop/proposal", proposal({ logEntryId: 52, coordinate: "1/1/52", op: "SEND", body: "", attrs: { question: "Which environment?" }, disposition: { decision: "review" } }));
    await settled();
    assert.equal(emitted.length, 1, "the validated client disposition remains authoritative");
    hitl.stop();
});
