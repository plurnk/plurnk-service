import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import Dsl from "./dsl.ts";
import { OperationFailureError, type SchemeResult } from "../../src/core/results.ts";
import SeamSocket from "./_seam.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Places, { type PlaceGates } from "../../src/server/Places.ts";
import { serverProposals } from "./_approval.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitFor, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession, insertLoop, insertTurn, openMigrated, holdChild, seedEntryWithChannel } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { namedModelSession } from "./_sessions.ts";
import { type ProblemDetails, Problems, type ApplicationGauge, type ApplicationStream } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText, ModelProvider, type ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";


describe("Daemon.addressed-messages", () => {
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";

test("{§methods}: a client message's address is its idempotency key: the same words are the accepted message, other words are refused", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [makeMockResponse(PlurnkParser.frame("SEND [200]", "Hello back."))] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "keyed-messages", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "keyed" });
        const address = "acp://operator/threads/keyed/messages/m1";
        const refusal = async (attempt: Promise<unknown>): Promise<string | null> => {
            try { await attempt; return null; } catch (cause) {
                const problem = Problems.fromError(cause);
                return problem === null ? String(cause) : `${problem.status} ${problem.type.slice(problem.type.lastIndexOf("/") + 1)}`;
            }
        };
        assert.equal(await daemon.messageAdmission({ workspaceId, address, body: "Hello." }), "new");
        await daemon.runLoop({ workspaceId, sessionId, prompt: "Hello.", source: address, messageAddress: address });
        assert.equal(await daemon.messageAdmission({ workspaceId, address, body: "Hello." }), "accepted", "a repeat attaches to the message already accepted");
        assert.equal(await refusal(daemon.messageAdmission({ workspaceId, address, body: "Edited." })), "422 message-address-reused");
        assert.equal(await refusal(daemon.runLoop({ workspaceId, sessionId, prompt: "Hello.", source: address, messageAddress: address })),
            "409 message-already-accepted", "admission refuses the same words racing the original");
        assert.equal(await refusal(daemon.runLoop({ workspaceId, sessionId, prompt: "Edited.", source: address, messageAddress: address })),
            "422 message-address-reused", "and other words under the same key");
        const elsewhere = await daemon.createWorkspace({ name: "keyed-messages-elsewhere", projectRoot: null });
        assert.equal(await daemon.messageAdmission({ workspaceId: elsewhere.workspaceId, address, body: "Edited." }), "new", "the key is the workspace's");
        assert.deepEqual((await daemon.readMessages({ workspaceId, sessionId })).filter(({ direction }) => direction === "inbound").map(({ body }) => body),
            ["Hello."], "nothing refused is admitted");
    });
});

test("{§session-scheme}: an empty directed SEND refuses before admission and the model can recover", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse([
            PlurnkParser.frame("SEND (session://receiver)", null),
            PlurnkParser.frame("NOTE", "Keep the sibling operation."),
        ].join("\n\n")),
        makeMockResponse(PlurnkParser.frame("SEND [200]", "No message was delivered to the receiver.")),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "empty-session-message", projectRoot: null });
        const sender = await daemon.createSession({ workspaceId, name: "sender" });
        const receiver = await daemon.createSession({ workspaceId, name: "receiver" });
        const accepted = await daemon.runLoop({ workspaceId, sessionId: sender.sessionId, prompt: "Check delivery." });
        const loops = await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: sender.sessionId }),
            (rows) => rows.some((row) => row.id === accepted.loopId && row.status === 200));
        assert.equal(loops.find((row) => row.id === accepted.loopId)?.status, 200);
        const rows = await daemon.readLog({ workspaceId, sessionId: sender.sessionId, loopId: accepted.loopId });
        const refused = rows.find((row) => row.origin === "model" && row.op === "SEND" && row.status_rx === 422);
        assert.ok(refused);
        assert.equal(refused.status_rx, 422);
        const receipt = refused.rx as SchemeResult;
        assert.equal(receipt.problem?.type, "https://problems.plurnk.xyz/scheme/session/message-empty");
        assert.equal(receipt.problem?.detail, "SEND has no message text or attachments."); // {§operation-results}
        assert.ok(rows.some((row) => row.origin === "model" && row.op === "NOTE" && row.status_rx === 200));
        assert.deepEqual(await daemon.listSessionLoops({ workspaceId, sessionId: receiver.sessionId }), [], "no empty receiving loop is created");
        assert.deepEqual(await daemon.readMessages({ workspaceId, sessionId: receiver.sessionId }), [], "no empty message is stored");
        assert.equal(provider.received.length, 2, "only the sender ran and recovered");
        assert.match(provider.received[1].map(chatMessageText).join("\n"), /SEND has no message text or attachments\./);
        const history = await daemon.readMessages({ workspaceId, sessionId: sender.sessionId });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), [
            "No message was delivered to the receiver.",
        ]);
    });
});

test("{§message-arrival} {§connection-lifecycle}: a person's answer, sent as a client operation, wakes its assigned session without making another request", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("````WAIT\nA collaborator may answer the request.\n````"),
        makeMockResponse("````WAIT\nThe collaborator answered; the held child is still running.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "client-answer-wake" });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "assigned" });
        await holdChild(db, workspaceId, sessionId);
        const address = "message://assigned/12345678";
        const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "What is the result?", messageAddress: address });
        await waitForDb(() => db.test_get_loop_status.get({ id: accepted.loopId }), (row) => row?.status === 202);
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(`SEND (${address}) [200]`, "The result is 42."));
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0];
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") throw new Error("The reply fixture did not parse.");
        const [result] = await daemon.dispatchClientAction({ workspaceId, actor: "test://collaborator", statements: [item.statement] });
        assert.equal(result.status, 200);
        await waitForDb(async () => provider.received.length, (count) => count === 2);
        await waitForDb(() => db.test_get_loop_status.get({ id: accepted.loopId }), (row) => row?.status === 202);
        assert.match(JSON.stringify(provider.received[1]), /The result is 42\./);
        assert.equal((await db.message_unanswered_count.get({ loop_id: accepted.loopId }))?.count, 0);
        assert.equal((await db.test_messages_by_session.all({ session_id: sessionId })).length, 1, "a reply is not another incoming obligation");
        assert.equal((await db.test_loop_queue_by_session.all({ session_id: sessionId })).length, 1, "the same parked loop resumed");
        const history = await daemon.readMessages({ workspaceId, sessionId });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "What is the result?" },
            { direction: "outbound", body: "The result is 42." },
        ]);
        await daemon.cancelSession({ workspaceId, sessionId });
    });
});
});

describe("Daemon.inbox", () => {
const streamed = (frames: readonly object[], hold?: Promise<void>): Response => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
        const send = (frame: object): void => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); };
        const [first, ...rest] = frames;
        if (first !== undefined) send(first);
        await hold;
        for (const frame of rest) send(frame);
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

// Turn 1 streams its reasoning, holds until released, then answers; turn 2 answers at once.
const heldProvider = (): { provider: ModelProvider; release: () => void; calls: () => number } => {
    const held = Promise.withResolvers<void>();
    let calls = 0;
    const frame = (delta: object, finish: string | null = null): object => ({
        id: `inbox-${calls}`, model: "inbox-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
    });
    const provider = new ModelProvider({
        model: "inbox-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            calls++;
            if (calls === 1) {
                return streamed([frame({ reasoning_content: "Weighing A." }), frame({ content: "````SEND [200]\nAnswer A.\n````" }, "stop")], held.promise);
            }
            return streamed([frame({ content: "````SEND [200]\nAnswer B.\n````" }, "stop")]);
        },
    });
    return { provider, release: () => held.resolve(), calls: () => calls };
};

const address = (id: string): string => `acp://operator/threads/inbox/messages/${id}`;

test("{§methods} a message accepted mid-turn is in the inbox until its arrival row lands", async () => {
    const { provider, release, calls } = heldProvider();
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "inbox" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const first = await daemon.runLoop({ workspaceId, sessionId, prompt: "A", source: address("A"), messageAddress: address("A") });
        await waitForDb(async () => calls(), (count) => count >= 1);
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }), [], "the headline message is observed by the turn in flight");
        const second = await daemon.runLoop({ workspaceId, sessionId, prompt: "B", source: address("B"), messageAddress: address("B") });
        assert.equal(second.loopId, first.loopId, "{§message-arrival} the follow-up joins the live loop");
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }),
            [{ path: address("B"), source: address("B"), body: "B", loopId: first.loopId, lifecycle: "running" }],
            "accepted, durable, and not yet observed: in the inbox by its immutable address, source, words, loop and its lifecycle");
        assert.equal(await daemon.messageAdmission({ workspaceId, address: address("B"), body: "B" }), "accepted",
            "{§methods} the same address and words are already accepted");
        release();
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }), (loops) => loops.some(({ id, status }) => id === first.loopId && status === 200));
        assert.equal(calls(), 2, "the next turn boundary published B and the model answered it");
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }), [], "published: out of the inbox");
        const messages = await daemon.readMessages({ workspaceId, sessionId });
        assert.deepEqual(messages.filter(({ direction }) => direction === "inbound").map(({ body }) => body), ["A", "B"], "and durable as ever");
    });
});

test("{§methods} {§message-arrival} a loop cancelled before observing a message leaves it in the inbox with that terminal lifecycle", async () => {
    const { provider, release, calls } = heldProvider();
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "inbox-cancel" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const first = await daemon.runLoop({ workspaceId, sessionId, prompt: "A", source: address("A"), messageAddress: address("A") });
        await waitForDb(async () => calls(), (count) => count >= 1);
        await daemon.runLoop({ workspaceId, sessionId, prompt: "B", source: address("B"), messageAddress: address("B") });
        assert.equal((await daemon.readInbox({ workspaceId, sessionId })).length, 1);
        await daemon.cancelSession({ workspaceId, sessionId });
        release();
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }), (loops) => loops.some(({ id, terminatedAt }) => id === first.loopId && terminatedAt !== null));
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }),
            [{ path: address("B"), source: address("B"), body: "B", loopId: first.loopId, lifecycle: "cancelled" }],
            "the loop concluded without observing it: still unobserved, and its lifecycle says nothing will");
        assert.ok((await daemon.readMessages({ workspaceId, sessionId })).some(({ body }) => body === "B"), "{§message-arrival} acceptance is durable");
        assert.equal(await daemon.messageAdmission({ workspaceId, address: address("B"), body: "B" }), "accepted", "{§methods} and its address stays taken");
    });
});
});

describe("Daemon.loop-status-notice", () => {
type LoopStatusNotice = { sessionId: number; loopId: number; notice: { source: string; kind: string; level: string; status: number; waitUntil: number | null; packetCount: number; claimedAt: number | null } };

test("{§operation-results}: claim, park and wake each broadcast the loop's status as a lifecycle notice", async () => {
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("````WAIT\nWaiting on the child.\n````"),
            makeMockResponse("````NOTE\nWoken by the message.\n````\n````WAIT\n````"),
        ],
    });
    await withDaemon(provider, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const { workspaceId } = await daemon.createWorkspace({ name: "loop-status-notice" });
            await rpcAttach(ws, workspaceId);
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await holdChild(db, workspaceId, sessionId);
            const captured = subscribeNotifications(ws, "notice/event");
            const terminals = subscribeNotifications(ws, "loop/terminated");
            const lifecycle = (): LoopStatusNotice[] => (captured() as LoopStatusNotice[])
                .filter(({ notice }) => notice.source === "engine:lifecycle" && notice.kind === "loop_status");
            try {
                const accepted = await daemon.inject({
                    workspaceId, sessionId,
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    effort: "adaptive", systemPrompt: "test system", prompt: "Delegate and wait.",
                });
                await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId }), (row) => row?.status === 202);
                await waitForDb(async () => lifecycle(), (notices) => notices.length >= 2);
                assert.deepEqual(lifecycle().map(({ loopId, notice }) => [loopId, notice.status, notice.level]), [[accepted.loopId, 102, "info"], [accepted.loopId, 202, "info"]],
                    "running when claimed, parked when suspended, both naming the loop");
                const firstDeadline = lifecycle()[1].notice.waitUntil;
                assert.ok(typeof firstDeadline === "number" && firstDeadline > Date.now(), "the parked notice names a future wake deadline");
                assert.equal(lifecycle()[0].notice.waitUntil, null, "running has no countdown");
                assert.equal((await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)?.waitUntil,
                    firstDeadline, "reattachment and live updates describe the same durable deadline");
                // {§acp-status-descendants} — every beat carries its loop's own packet count and claim stamp, the ones a snapshot reads.
                const projected = (await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)!;
                assert.deepEqual(lifecycle().map(({ notice }) => [notice.packetCount, notice.claimedAt]), [[0, Date.parse(projected.claimedAt!)], [projected.packetCount, Date.parse(projected.claimedAt!)]],
                    "claimed with no packet yet, parked after its first, the same claim stamp throughout");

                const delivered = await daemon.runLoop({ workspaceId, sessionId, prompt: "A message wakes it." });
                assert.equal(delivered.loopId, accepted.loopId);
                await waitForDb(async () => lifecycle(), (notices) => notices.length >= 5);
                assert.deepEqual(lifecycle().slice(2).map(({ notice }) => notice.status), [100, 102, 202], "waking queues the loop, then claim and WAIT move it through running to parked");
                assert.deepEqual(lifecycle().slice(2, 4).map(({ notice }) => notice.waitUntil), [null, null], "the countdown clears before inference begins");
                const nextDeadline = lifecycle()[4].notice.waitUntil;
                assert.ok(typeof nextDeadline === "number" && nextDeadline > firstDeadline, "the next WAIT starts a fresh bounded park");
                assert.equal((await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)?.waitUntil, nextDeadline);
                assert.ok(lifecycle().every(({ sessionId: owner }) => owner === sessionId), "every beat names the owning session");
                const packets = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: accepted.loopId });
                assert.ok(packets.every(({ rx }) => !rx.includes("loop_status")), "the beat is transient: no log row, nothing for a packet");
                assert.ok(lifecycle().slice(2).every(({ notice }) => notice.claimedAt === Date.parse(projected.claimedAt!)), "a woken loop keeps its first claim stamp");
                // {§notifications} — the terminal carries the stamp a snapshot reads.
                await daemon.cancelSession({ workspaceId, sessionId });
                await waitForDb(async () => terminals(), (events) => events.length >= 1);
                const ended = (await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)!;
                assert.equal((terminals()[0] as { terminatedAt: number }).terminatedAt, Date.parse(ended.terminatedAt!));
            } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
        } finally { ws.close(); }
    });
});

const rpcAttach = async (ws: Awaited<ReturnType<typeof connect>>, workspaceId: number): Promise<void> => {
    const response = await rpcCall(ws, 1, "workspace.attach", { id: workspaceId });
    if ("error" in response && response.error !== undefined) throw new Error(`attach failed: ${JSON.stringify(response.error)}`);
};
});

describe("Daemon.notice-event", () => {
test("{§notifications} notifyNotice broadcasts to clients attached to the loop's workspace", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "notices-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "notice/event");

            daemon.notifyNotice(workspaceId, {
                sessionId: 7,
                loopId: 42,
                notice: {
                    source: "provider:local",
                    kind: "output_unaccounted",
                    level: "warn",
                    message: "transported grammar diverged from returned content",
                    position: { type: "content-offset", line: 3, column: 7 },
                },
            });

            const notices = (captured() as Array<{ sessionId: number; loopId: number; notice: { source: string; kind: string; message: string } }>)
                .filter((item) => item.loopId === 42);
            assert.equal(notices.length, 1);
            assert.equal(notices[0].sessionId, 7);
            assert.equal(notices[0].loopId, 42);
            assert.equal(notices[0].notice.source, "provider:local");
            assert.equal(notices[0].notice.kind, "output_unaccounted");
            assert.equal(notices[0].notice.message, "transported grammar diverged from returned content");
        } finally { ws.close(); }
    });
});

test("{§operation-results} notice/event is workspace-scoped — other workspaces don't see it", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "workspace.create", { name: "notices-A" });
            const bResp = await rpcCall(wsB, 1, "workspace.create", { name: "notices-B" });
            const workspaceA = (aResp.result as { id: number }).id;
            const workspaceB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "notice/event");
            const bEvents = subscribeNotifications(wsB, "notice/event");

            daemon.notifyNotice(workspaceA, { sessionId: 11, loopId: 1, notice: { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" } });
            daemon.notifyNotice(workspaceB, { sessionId: 12, loopId: 2, notice: { source: "exec:sqlite", kind: "query_progress", level: "info", completed: 5, total: 10, percent: 50 } });


            const aCaptured = (aEvents() as Array<{ notice: { kind: string } }>).filter((item) => item.notice.kind === "turn_awaiting_model");
            const bCaptured = (bEvents() as Array<{ notice: { kind: string } }>).filter((item) => item.notice.kind === "query_progress");
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].notice.kind, "turn_awaiting_model");
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].notice.kind, "query_progress");
        } finally { wsA.close(); wsB.close(); }
    });
});
});

describe("Daemon.ops", () => {
test("{§methods} op.edit creates an entry via engine.dispatch (origin=client)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ops-test" });
            const response = await rpcCall(ws, 2, "op.edit", {
                target: "workspace:///france/capital", content: "Paris",
            });
            assert.equal((response.result as { status: number }).status, 201);

            const entry = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string; pathname: string }>({ pathname: "/france/capital", scheme: "workspace" });
            assert.equal(entry?.scheme, "workspace");
            assert.equal(entry?.pathname, "/france/capital");
            const body = (await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/france/capital" }))?.content;
            assert.equal(body, "Paris");
            const log = await db.test_first_log_entry.get<{ id: number; session_id: number; origin: string; op: string }>();
            assert.ok(log !== undefined);
            assert.equal(log?.origin, "client");
            assert.equal(log?.op, "EDIT");
        } finally { ws.close(); }
    });
});

test("{§methods}: op.edit log/entry notification precedes the action response", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "notify-order" });
            // Record inbound messages in arrival order, after the workspace is up — so we capture
            // only the op.edit exchange: the log/entry notification must land before response#2.
            const order: string[] = [];
            ws.on("message", (data) => {
                const m = JSON.parse(typeof data === "string" ? data : (data as Buffer).toString("utf8")) as { method?: string; id?: number };
                order.push(m.method ?? `response#${m.id}`);
            });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "hi" });
            const notifyIdx = order.indexOf("log/entry");
            const respIdx = order.indexOf("response#2");
            assert.ok(notifyIdx !== -1, `log/entry should have fired (order: ${order.join(", ")})`);
            assert.ok(respIdx !== -1 && notifyIdx < respIdx, `{§methods}: log/entry must precede the op response (order: ${order.join(", ")})`);
        } finally { ws.close(); }
    });
});

test("{§methods} op.read fetches an entry's body", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "hello" });
            const response = await rpcCall(ws, 3, "op.read", { target: "workspace:///x" });
            const result = response.result as { status: number; content: string };
            assert.equal(result.status, 200);
            assert.equal(result.content, "hello");
        } finally { ws.close(); }
    });
});

test("{§methods} op.read on nonexistent entry returns 404", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "404-test" });
            const response = await rpcCall(ws, 2, "op.read", { target: "workspace:///nope" });
            assert.equal((response.result as { status: number }).status, 404);
        } finally { ws.close(); }
    });
});

test("{§methods} op.dispatch accepts a raw PlurnkStatement AST and dispatches it", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "dispatch-test" });
            const statement = {
                op: "EDIT" as const,
                aside: null,
                metadata: null,
                target: {
                    kind: "url" as const, raw: "workspace:///hello",
                    scheme: "workspace", username: null, password: null,
                    hostname: null, port: null, pathname: "/hello",
                    query: null, fragment: null,
                },
                lineMarker: null,
                matcher: null,
                body: "world",
                position: { line: 1, column: 1 },
            };
            const response = await rpcCall(ws, 2, "op.dispatch", { statement });
            assert.equal((response.result as { status: number }).status, 201);

            const body = (await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/hello" }))?.content;
            assert.equal(body, "world");
        } finally { ws.close(); }
    });
});

test("{§notifications} op.* fires log/entry notification with the entry shape", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "notif-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "test" });

            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { entry: { op: string; origin: string; status_rx: number } };
            assert.equal(params.entry.op, "EDIT");
            assert.equal(params.entry.origin, "client");
            assert.equal(params.entry.status_rx, 201);
        } finally { ws.close(); }
    });
});

test("{§notifications} log/entry notification is scoped to workspace", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aNotifs = subscribeNotifications(wsA, "log/entry");
            const bNotifs = subscribeNotifications(wsB, "log/entry");

            await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });

            await rpcCall(wsA, 2, "op.edit", { target: "workspace:///x", content: "from A" });

            assert.equal(aNotifs().length, 1);
            assert.equal(bNotifs().length, 0);
        } finally { wsA.close(); wsB.close(); }
    });
});
test("{§find-result-projection} op.find on empty scope returns 200 with empty results", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "find-test" });
            const response = await rpcCall(ws, 2, "op.find", { scope: "workspace:///empty/" });
            const result = response.result as { status: number; results: string[]; content: string };
            assert.equal(result.status, 200);
            assert.deepEqual(result.results, []);
            assert.equal(result.content, "[]", "FIND content is a JSON catalog array — empty here");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} a completed client operation concludes its administrative loop", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "note-test" });
            const workspaceId = (workspace.result as { id: number }).id;

            // The operation opens its own loop in the workspace's runtime session.
            const response = await rpcCall(ws, 2, "op.dispatch", { statement: Dsl.parseSingleStatement("````NOTE\nClient observation.\n````") });
            assert.equal((response.result as { status: number }).status, 200);

            const runtime = await daemon.ensureRuntimeSession(workspaceId);
            const operations = (await daemon.listSessionLoops({ workspaceId, sessionId: runtime }))
                .filter(({ promptSource }) => promptSource === SeamSocket.owner);
            assert.deepEqual(operations.map(({ status }) => status), [200], "the one operation's loop concluded 200");
        } finally { ws.close(); }
    });
});
});

describe("Daemon.outside-event", () => {
test("{§notifications} notifyOutsideEvent broadcasts the exact payload to the loop's workspace only", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const workspaceA = ((await rpcCall(wsA, 1, "workspace.create", { name: "outside-A" })).result as { id: number }).id;
            await rpcCall(wsB, 1, "workspace.create", { name: "outside-B" });
            const aEvents = subscribeNotifications(wsA, "outside/event");
            const bEvents = subscribeNotifications(wsB, "outside/event");
            const event = { sessionId: 7, loopId: 42, turnId: 9, coordinate: "alice-1-3", text: "Thinking out loud.", tokens: 9 };
            daemon.notifyOutsideEvent(workspaceA, event);
            // {§notifications}: the envelope stamps the scope; the payload is otherwise exact.
            assert.deepEqual(aEvents(), [{ ...event, workspaceId: workspaceA }], "the payload arrives once, exactly as emitted");
            assert.deepEqual(bEvents(), [], "another workspace's client sees nothing");
        } finally { wsA.close(); wsB.close(); }
    });
});
});

describe("Daemon.session-gauge", () => {
const NONE: ApplicationGauge = { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null };

// Each packet's gauge in arrival order, and each terminal's, by loop.
const observe = (daemon: Daemon) => {
    const packets: Array<{ loopId: number; gauge: ApplicationGauge }> = [];
    const terminals = new Map<number, ApplicationGauge>();
    const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
        if (method === "loop/packet") packets.push(params as { loopId: number; gauge: ApplicationGauge });
        if (method !== "loop/terminated") return;
        const { loopId, usage: { curationWeight, curationBudget, contextTokens, contextCapacity } } = params as {
            loopId: number; usage: ApplicationGauge;
        };
        terminals.set(loopId, { curationWeight, curationBudget, contextTokens, contextCapacity });
    });
    const terminal = (loopId: number) => waitForDb(async () => terminals.get(loopId), (value) => value !== undefined);
    const latest = (): ApplicationGauge => packets.at(-1)?.gauge ?? NONE;
    const lastOf = (loopId: number): ApplicationGauge | undefined => packets.findLast((packet) => packet.loopId === loopId)?.gauge;
    return { packets, terminal, latest, lastOf, off };
};

test("{§methods-workspace-create}: the gauge the Session's latest packet reported, moving with each model turn", async (t) => {
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````SEND [200]\nThe first answer.\n````"),
        makeMockResponse("````NOTE\nWorking on the second.\n````"),
        makeMockResponse("````SEND [200]\nThe second answer.\n````"),
        makeMockResponse("````SEND [200]\nThe third answer.\n````"),
    ] });
    // The second loop's second call is held while the gauge is read, then cancelled.
    const generate = provider.generate.bind(provider);
    let calls = 0;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (++calls === 3) {
            held.resolve();
            await release.promise;
        }
        return generate(...args);
    });
    t.after(() => release.resolve());
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-gauge" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { packets, terminal, latest, lastOf, off } = observe(daemon);
        try {
            const gauge = () => daemon.sessionGauge({ workspaceId, sessionId });
            assert.deepEqual(await gauge(), NONE, "a Session without a packet reports no gauge");

            const { loopId: first } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer once." });
            const concluded = await terminal(first);
            assert.deepEqual(lastOf(first), concluded, "a loop's last packet and its terminal report one gauge");
            assert.deepEqual(await gauge(), latest(), "the gauge the latest packet reported");

            const { loopId: second } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer again." });
            await held.promise;
            const working = lastOf(second);
            assert.ok(working !== undefined, "the working loop's first turn reported its gauge before the loop ends");
            assert.notDeepEqual(working, concluded, "that turn's gauge is its own");
            assert.deepEqual(await gauge(), working, "the gauge moves with the working loop's turn");
            await daemon.cancelSession({ workspaceId, sessionId, reason: "user_escape" });
            release.resolve();
            await terminal(second);
            assert.deepEqual(await gauge(), latest(), "a cancelled loop leaves the gauge its latest packet reported");

            const { loopId: third } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer a third time." });
            const ended = await terminal(third);
            assert.deepEqual(lastOf(third), ended, "each loop's last packet and terminal agree");
            assert.deepEqual(await gauge(), latest(), "the gauge follows the packet that came last");
            assert.ok(packets.length >= 4, "every model turn reported a packet");

            const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "session-gauge-elsewhere" });
            await assert.rejects(daemon.sessionGauge({ workspaceId: elsewhere, sessionId }), (error: unknown) =>
                error instanceof OperationFailureError
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
        } finally {
            off();
        }
    });
});

test("{§methods-workspace-create}: absent capacity evidence stays absent, as the packet reported it", async () => {
    const provider = new Mock({ contextWindow: null, responses: [makeMockResponse("````SEND [200]\nThe answer.\n````")] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-gauge-uncalibrated" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { terminal, latest, off } = observe(daemon);
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer once." });
            await terminal(loopId);
            const gauge = await daemon.sessionGauge({ workspaceId, sessionId });
            assert.deepEqual(gauge, latest(), "the gauge the packet reported");
            assert.equal(gauge.contextCapacity, null, "no capacity evidence, no capacity");
            assert.equal(gauge.curationBudget, null, "no capacity, no curation budget");
            assert.notEqual(gauge.curationWeight, null, "the packet's own weight is still known");
        } finally {
            off();
        }
    });
});
});


describe("Engine.session-accounting", () => {
const spend = async (db: Db, loopId: number, sequence: number, inputTokens: number, costUsd: string): Promise<void> => {
    const turnId = await insertTurn(db, loopId, sequence, 200);
    const call = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind: "emission", attributions: "[]", model: "mock" });
    if (call === undefined) throw new Error("fixture model call did not open");
    const request = await db.engine_open_provider_request.get<{ id: number }>({ inference_call_id: call.id, sequence: 1, provider: "provider:mock", model: "mock" });
    if (request === undefined) throw new Error("fixture provider request did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock", model: "mock", outcome: "response",
        usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
        cost: { kind: "estimated", amount: { amount: costUsd, currency: "USD" }, source: "fixture" },
    };
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
};

test("{§methods-workspace-create}: the session's own and its descendants' settled spend since it began, and nothing else", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "session-spend");
        const parent = await insertSession(db, workspaceId, null, "parent", "model");
        const child = await insertSession(db, workspaceId, parent, "child", "model");
        const grandchild = await insertSession(db, workspaceId, child, "grandchild", "model");
        const stranger = await insertSession(db, workspaceId, null, "stranger", "model");
        const idle = await insertSession(db, workspaceId, null, "idle", "model");
        // An earlier delegation of the same child: still this session's tree, still its spend.
        const earlier = await insertLoop(db, child, 1, "earlier");
        await spend(db, earlier, 1, 1000, "1.00");
        const parentLoop = await insertLoop(db, parent, 1, "delegate");
        await spend(db, parentLoop, 1, 500, "0.50");
        const childLoop = await insertLoop(db, child, 2, "child work");
        await spend(db, childLoop, 1, 100, "0.10");
        await spend(db, childLoop, 2, 200, "0.20");
        const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild work");
        await spend(db, grandchildLoop, 1, 40, "0.04");
        const strangerLoop = await insertLoop(db, stranger, 1, "unrelated");
        await spend(db, strangerLoop, 1, 7000, "7.00");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const accounting = await engine.sessionAccounting(parent);
        assert.equal(accounting.requests.length, 5, "its own request and every descendant's, the older delegation included");
        assert.equal(accounting.usage?.inputTokens, 1840, "the stranger's 7000 never counts");
        assert.equal(accounting.costUsd, "1.84");

        const own = await engine.loopUsage(parentLoop);
        assert.equal(own.accounting.usage?.inputTokens, 500, "one loop's own accounting keeps its meaning");

        const leaf = await engine.sessionAccounting(grandchild);
        assert.equal(leaf.usage?.inputTokens, 40, "a session without descendants reports its own");
        const none = await engine.sessionAccounting(idle);
        assert.equal(none.requests.length, 0);
        assert.equal(none.costUsd, "0", "nothing spent projects explicit zero");
    } finally { await db.close(); }
});
});

describe("place-hiding", () => {
const refusal = async (attempt: Promise<unknown>): Promise<ProblemDetails> => {
    try {
        await attempt;
    } catch (error) {
        assert.ok(error instanceof OperationFailureError, `a Problem, not ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("the call was not refused");
};

const sorted = (ids: readonly number[]): number[] => ids.toSorted((a, b) => a - b);

type Mark = { place: "workspace" | "session"; id: number; hidden_at: string | null; hidden_by: number | null };
const marks = async (db: Db, workspaceId: number): Promise<Mark[]> => db.test_place_marks.all<Mark>({ workspace_id: workspaceId });
const groups = async (db: Db, workspaceId: number): Promise<Record<number, number | null>> =>
    Object.fromEntries((await marks(db, workspaceId)).filter(({ place }) => place === "session").map(({ id, hidden_by }) => [id, hidden_by]));

const NO_GATES: PlaceGates = async () => ({ proposals: [], questions: [] });

// The work a place can hold, and what of it is live: a loop queued, running or parked ({§session-loop-lifecycle}), an
// open stream, detached or not, and a gate the engine reports.
const WORK = ["none", "queued", "running", "parked", "concluded", "stream", "detached stream", "closed stream", "proposal", "question"] as const;
type Work = typeof WORK[number];
const COUNTS: Readonly<Record<Work, { loops: number; streams: number; proposals: number; questions: number } | null>> = {
    none: null, concluded: null, "closed stream": null,
    queued: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    running: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    parked: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    stream: { loops: 0, streams: 1, proposals: 0, questions: 0 },
    "detached stream": { loops: 0, streams: 1, proposals: 0, questions: 0 },
    proposal: { loops: 0, streams: 0, proposals: 1, questions: 0 },
    question: { loops: 0, streams: 0, proposals: 0, questions: 1 },
};

const seedWork = async (db: Db, workspaceId: number, sessionId: number, work: Work): Promise<void> => {
    if (work === "queued" || work === "running" || work === "parked") {
        const status = { queued: 100, running: 102, parked: 202 }[work];
        await db.test_loops_insert_with_status.run({ session_id: sessionId, sequence: 1, status, prompt: "work", terminal_result: null });
    } else if (work === "concluded") {
        await db.test_loops_insert_with_status.run({ session_id: sessionId, sequence: 1, status: 200, prompt: "work", terminal_result: JSON.stringify({ status: 200 }) });
    } else if (work === "stream" || work === "detached stream" || work === "closed stream") {
        const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: `/${sessionId}/1/1/sh`, channel: "stdout", content: "", state: "active" });
        const stream = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: entryId, detached: work === "detached stream" ? 1 : 0 });
        assert.ok(stream !== undefined);
        if (work === "closed stream") await db.test_close_subscription.run({ id: stream.id });
    }
};

// Where the work sits: on the place (the session, or a root of the workspace), beneath it (a grandchild of the session,
// or a child in the workspace), or outside it (a sibling of the session, or a session of another workspace).
const POSITIONS = ["at", "beneath", "outside"] as const;

for (const target of ["workspace", "session"] as const) {
    test(`{§machine-processes} a ${target}'s hide is refused, naming what is live, exactly while live work sits on it or beneath it; nothing is marked by a refusal`, async () => {
        const db = await openMigrated();
        try {
            for (const position of POSITIONS) {
                for (const work of WORK) {
                    const label = `${work} ${position} the ${target}`;
                    const workspaceId = await insertWorkspace(db, `matrix-${crypto.randomUUID()}`);
                    const other = await insertWorkspace(db, `matrix-other-${crypto.randomUUID()}`);
                    const root = await insertSession(db, workspaceId, null, "root");
                    const child = await insertSession(db, workspaceId, root, "child");
                    const grandchild = await insertSession(db, workspaceId, child, "grandchild");
                    const sibling = await insertSession(db, workspaceId, null, "sibling");
                    const stranger = await insertSession(db, other, null, "stranger");
                    const holder = target === "workspace"
                        ? { at: root, beneath: child, outside: stranger }[position]
                        : { at: root, beneath: grandchild, outside: sibling }[position];
                    const holderWorkspace = holder === stranger ? other : workspaceId;
                    await seedWork(db, holderWorkspace, holder, work);
                    const gates: PlaceGates = async (id) => ({
                        proposals: work === "proposal" && id === holderWorkspace ? [{ sessionId: holder }] : [],
                        questions: work === "question" && id === holderWorkspace ? [{ sessionId: holder }] : [],
                    });
                    const before = await marks(db, workspaceId);
                    const hide = target === "workspace"
                        ? Places.setWorkspaceHidden(db, gates, workspaceId, true).then(({ hiding }) => hiding)
                        : Places.setSessionHidden(db, gates, workspaceId, root, true);
                    const live = position === "outside" ? null : COUNTS[work];
                    if (live === null) {
                        assert.equal(typeof (await hide).hidden_at, "string", `${label}: hidden`);
                        continue;
                    }
                    const problem = await refusal(hide);
                    assert.equal(problem.status, 409, label);
                    assert.ok(problem.type.endsWith("/live-work"), `${label}: ${problem.type}`);
                    assert.deepEqual({ loops: problem.loops, streams: problem.streams, proposals: problem.proposals, questions: problem.questions }, live, label);
                    assert.deepEqual(await marks(db, workspaceId), before, `${label}: a refused hide marks nothing`);
                }
            }
        } finally { await db.close(); }
    });
}

test("{§machine-processes} a session's hide marks its subtree as one group: a group inside joins it, a session created beneath joins it, a second hide changes nothing, and showing any member shows the group", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `groups-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const a = await insertSession(db, workspaceId, root, "a");
        const a1 = await insertSession(db, workspaceId, a, "a1");
        const b = await insertSession(db, workspaceId, root, "b");
        const sibling = await insertSession(db, workspaceId, null, "sibling");

        const inner = await Places.setSessionHidden(db, NO_GATES, workspaceId, a, true);
        assert.deepEqual(sorted(inner.sessionIds), sorted([a, a1]));
        assert.deepEqual(await groups(db, workspaceId), { [root]: null, [a]: a, [a1]: a, [b]: null, [sibling]: null }, "a hide marks the session and every session beneath it");
        const outer = await Places.setSessionHidden(db, NO_GATES, workspaceId, root, true);
        assert.deepEqual(sorted(outer.sessionIds), sorted([root, a, a1, b]));
        assert.deepEqual(await groups(db, workspaceId), { [root]: root, [a]: root, [a1]: root, [b]: root, [sibling]: null }, "a group hidden inside joins the outer one");
        assert.deepEqual(await Places.setSessionHidden(db, NO_GATES, workspaceId, a1, true), { id: a1, hidden_at: outer.hidden_at, sessionIds: [] }, "hiding a hidden session changes nothing");
        const late = await insertSession(db, workspaceId, a, "late");
        assert.equal((await groups(db, workspaceId))[late], root, "a session created beneath a hidden session joins its group");

        const shown = await Places.setSessionHidden(db, NO_GATES, workspaceId, a1, false);
        assert.deepEqual(shown, { id: a1, hidden_at: null, sessionIds: sorted([root, a, a1, b, late]) });
        assert.ok((await marks(db, workspaceId)).every(({ hidden_at }) => hidden_at === null), "showing any member shows the whole group");
        assert.deepEqual(await Places.setSessionHidden(db, NO_GATES, workspaceId, sibling, false), { id: sibling, hidden_at: null, sessionIds: [] }, "showing a shown session changes nothing");

        const hiddenWorkspace = await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true);
        assert.equal(hiddenWorkspace.changed, true);
        assert.ok((await marks(db, workspaceId)).every(({ place, hidden_at }) => (place === "workspace") === (hidden_at !== null)), "a workspace's mark is its own");
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true), { hiding: hiddenWorkspace.hiding, changed: false }, "a second hide keeps the first mark");
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, false), { hiding: { id: workspaceId, hidden_at: null }, changed: true });
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, false), { hiding: { id: workspaceId, hidden_at: null }, changed: false });

        const other = await insertWorkspace(db, `groups-other-${crypto.randomUUID()}`);
        for (const hidden of [true, false]) {
            assert.equal((await refusal(Places.setSessionHidden(db, NO_GATES, other, root, hidden))).status, 404, "a session of another workspace is not found");
            assert.equal((await refusal(Places.setWorkspaceHidden(db, NO_GATES, Number.MAX_SAFE_INTEGER, hidden))).status, 404, "a workspace that does not exist is not found");
        }
    } finally { await db.close(); }
});

test("{§machine-processes} a live loop starting on a hidden session brings back its group and its workspace; concluded history brings nothing back", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `return-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const child = await insertSession(db, workspaceId, root, "child");
        const sibling = await insertSession(db, workspaceId, null, "sibling");
        await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true);
        await Places.setSessionHidden(db, NO_GATES, workspaceId, root, true);
        await Places.setSessionHidden(db, NO_GATES, workspaceId, sibling, true);
        const hidden = await marks(db, workspaceId);

        await db.test_loops_insert_with_status.run({ session_id: child, sequence: 1, status: 200, prompt: "history", terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await marks(db, workspaceId), hidden, "a concluded loop is history, never work");

        await db.test_insert_queued_loop.get({ session_id: child, sequence: 2, prompt: "work" });
        assert.deepEqual((await marks(db, workspaceId)).map(({ place, id, hidden_at }) => [place, id, hidden_at !== null]), [
            ["session", root, false], ["session", child, false], ["session", sibling, true], ["workspace", workspaceId, false],
        ], "the loop's group and workspace are shown; another group stays hidden");
    } finally { await db.close(); }
});

test("{§machine-processes} {§methods-workspace-create} listings filter by the mark only when asked; the overview leaves out hidden sessions and, in the daemon's scope, every session of a hidden workspace", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const shownWorkspace = await daemon.createWorkspace({ name: `shown-${crypto.randomUUID()}` });
        const hiddenWorkspace = await daemon.createWorkspace({ name: `hidden-${crypto.randomUUID()}` });
        const shown = await daemon.createSession({ workspaceId: shownWorkspace.workspaceId, name: "shown" });
        const hidden = await daemon.createSession({ workspaceId: shownWorkspace.workspaceId, name: "hidden" });
        const inside = await daemon.createSession({ workspaceId: hiddenWorkspace.workspaceId, name: "inside" });
        await daemon.setSessionHidden({ workspaceId: shownWorkspace.workspaceId, sessionId: hidden.sessionId, hidden: true });
        await daemon.setWorkspaceHidden({ workspaceId: hiddenWorkspace.workspaceId, hidden: true });

        const names = async (hiddenFilter?: boolean): Promise<string[]> => (await daemon.listSessions(shownWorkspace.workspaceId, {
            origin: "model", ...(hiddenFilter === undefined ? {} : { hidden: hiddenFilter }),
        })).map(({ name }) => name).toSorted();
        assert.deepEqual(await names(), ["hidden", "shown"], "an unfiltered listing holds every session");
        assert.deepEqual(await names(false), ["shown"]);
        assert.deepEqual(await names(true), ["hidden"]);
        const ids = async (hiddenFilter?: boolean): Promise<number[]> => (await daemon.listWorkspaces(hiddenFilter === undefined ? {} : { hidden: hiddenFilter }))
            .map(({ id }) => id).filter((id) => id === shownWorkspace.workspaceId || id === hiddenWorkspace.workspaceId).toSorted((a, b) => a - b);
        assert.deepEqual(await ids(), sorted([shownWorkspace.workspaceId, hiddenWorkspace.workspaceId]));
        assert.deepEqual(await ids(false), [shownWorkspace.workspaceId]);
        assert.deepEqual(await ids(true), [hiddenWorkspace.workspaceId]);
        assert.equal(typeof (await daemon.readSession({ workspaceId: shownWorkspace.workspaceId, identity: { name: "hidden" } }))?.hidden_at, "string", "a direct read finds a hidden session");
        assert.equal((await daemon.attachWorkspace({ name: hiddenWorkspace.workspaceName })).workspaceId, hiddenWorkspace.workspaceId, "an attach finds a hidden workspace");
        assert.deepEqual(await ids(true), [hiddenWorkspace.workspaceId], "and leaves it hidden");

        const overview = async (workspaceId?: number) => {
            const read = await daemon.readSessionOverview({ ...(workspaceId === undefined ? {} : { workspaceId }), limit: 100, excerptChars: 40 });
            return { sessions: read.sessions.map(({ id }) => id).filter((id) => [shown.sessionId, hidden.sessionId, inside.sessionId].includes(id)), workspaces: read.workspaces.map(({ id }) => id) };
        };
        assert.deepEqual(await overview(), { sessions: [shown.sessionId], workspaces: [shownWorkspace.workspaceId] }, "the daemon's overview");
        assert.deepEqual(await overview(shownWorkspace.workspaceId), { sessions: [shown.sessionId], workspaces: [shownWorkspace.workspaceId] }, "a workspace's overview");
        assert.deepEqual(await overview(hiddenWorkspace.workspaceId), { sessions: [inside.sessionId], workspaces: [hiddenWorkspace.workspaceId] }, "a hidden workspace's own overview holds its shown sessions");

        for (const attempt of [
            () => daemon.setWorkspaceHidden({ workspaceId: shownWorkspace.workspaceId, hidden: "yes" as unknown as boolean }),
            () => daemon.setSessionHidden({ workspaceId: shownWorkspace.workspaceId, sessionId: shown.sessionId, hidden: 1 as unknown as boolean }),
            () => daemon.listSessions(shownWorkspace.workspaceId, { hidden: "no" as unknown as boolean }),
            () => daemon.listWorkspaces({ hidden: null as unknown as boolean }),
        ]) {
            const problem = await refusal(attempt());
            assert.equal(problem.status, 400);
            assert.ok(problem.type.endsWith("/flag-invalid"), problem.type);
        }
    });
});

test("{§methods-workspace-create} {§methods-workspace-create} {§notifications} {§notifications} {§execution-output-identity} each change is announced once in its workspace; creating by the folder selects and shows a hidden workspace; an explicit name it holds conflicts", async () => {
    const folder = await mkdtemp(join(tmpdir(), "plurnk-hidden-"));
    try {
        await withDaemon(null, async (_db, daemon) => {
            const events: Array<[number | null, string, unknown]> = [];
            const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => {
                if (method === "workspace/hidden" || method === "session/hidden") events.push([workspaceId, method, params]);
            });
            const created = await daemon.createWorkspace({ projectRoot: folder });
            const hidden = await daemon.setWorkspaceHidden({ workspaceId: created.workspaceId, hidden: true });
            assert.equal(typeof hidden.hidden_at, "string");
            assert.deepEqual(await daemon.setWorkspaceHidden({ workspaceId: created.workspaceId, hidden: true }), hidden, "a second hide keeps the first mark");
            const selected = await daemon.createWorkspace({ projectRoot: folder });
            assert.equal(selected.workspaceId, created.workspaceId, "creating by the folder selects the hidden workspace");
            assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === created.workspaceId)?.hidden_at, null, "and shows it");

            const named = await daemon.createWorkspace({ name: `named-${crypto.randomUUID()}` });
            const namedHidden = await daemon.setWorkspaceHidden({ workspaceId: named.workspaceId, hidden: true });
            const conflict = await refusal(daemon.createWorkspace({ name: named.workspaceName }));
            assert.equal(conflict.status, 409);
            assert.ok(conflict.type.endsWith("/name-conflict"), conflict.type);
            assert.match(conflict.detail ?? "", /by a hidden workspace/u, "the conflict says the name's holder is hidden");

            const session = await daemon.createSession({ workspaceId: created.workspaceId, name: "quiet" });
            const sessionHidden = await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: true });
            assert.deepEqual(sessionHidden.sessionIds, [session.sessionId]);
            await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: true });
            const sessionShown = await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: false });
            await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: false });
            unsubscribe();
            assert.deepEqual(events, [
                [created.workspaceId, "workspace/hidden", hidden],
                [created.workspaceId, "workspace/hidden", { id: created.workspaceId, hidden_at: null }],
                [named.workspaceId, "workspace/hidden", namedHidden],
                [created.workspaceId, "session/hidden", sessionHidden],
                [created.workspaceId, "session/hidden", { id: session.sessionId, hidden_at: null, sessionIds: [session.sessionId] }],
            ], "a call that changes nothing announces nothing");
            assert.deepEqual(sessionShown, { id: session.sessionId, hidden_at: null, sessionIds: [session.sessionId] });
        });
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test("{§machine-processes} a hide is refused over a gate the daemon holds; a loop run on a hidden session brings it and its workspace back", async () => {
    const gated = new Mock({ contextWindow: 16384, responses: [
        // A host execution the server reviews: the loop waits on its proposal.
        makeMockResponse("\n````sh\necho pending\n````\n\n````NOTE\nproposed\n````", 10),
    ] });
    await withDaemon(gated, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: `gated-${crypto.randomUUID()}` })).result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const { modelSessionId } = (await rpcCall(ws, 2, "loop.run", { prompt: "go" })).result as { modelSessionId: number };
            await waitFor(() => proposals(), (seen) => seen.length >= 1, { timeoutMs: 10_000 });
            for (const attempt of [
                () => daemon.setSessionHidden({ workspaceId, sessionId: modelSessionId, hidden: true }),
                () => daemon.setWorkspaceHidden({ workspaceId, hidden: true }),
            ]) {
                const problem = await refusal(attempt());
                assert.equal(problem.status, 409);
                assert.equal(problem.proposals, 1, "the pending proposal is named");
                assert.equal(problem.loops, 1, "with the loop that waits on it");
            }
        } finally { ws.close(); }
    });

    const answering = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(answering, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: `returning-${crypto.randomUUID()}` })).result as { id: number }).id;
            const { sessionId } = await daemon.createSession({ workspaceId, name: "returning" });
            await daemon.setSessionHidden({ workspaceId, sessionId, hidden: true });
            await daemon.setWorkspaceHidden({ workspaceId, hidden: true });
            const run = await runLoopToTerminal(ws, 2, { prompt: "go", sessionId });
            assert.equal(run.finalStatus, 200);
            assert.ok((await daemon.listWorkspaces({ hidden: false })).some(({ id }) => id === workspaceId), "the workspace is shown");
            assert.ok((await daemon.listSessions(workspaceId, { hidden: false })).some(({ id }) => id === sessionId), "the session is shown");
        } finally { ws.close(); }
    });
});
});


describe("session-references", () => {
test("{§session-external-reference} concurrent allocation is durable, folderless and independent of names and owners", async () => {
    const path = join(await testArtifactDirectory("session-references"), `identity-${crypto.randomUUID()}.db`);
    const reference = { namespace: "fixture", reference: "customer/分析 #blue?100%" };
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null });
    let identity: { workspaceId: number; sessionId: number };
    try {
        assert.equal(await daemon.readSessionReference(reference), null);
        assert.deepEqual(await daemon.listWorkspaces(), []);
        const created: unknown[] = [];
        const off = daemon.subscribeToEvents((_scope, event, payload) => {
            if (event === "workspace/created") created.push(payload);
        });
        const identities = await Promise.all(Array.from({ length: 12 }, () => daemon.ensureSessionReference(reference)));
        identity = identities[0]!;
        assert.ok(identities.every((item) => item.workspaceId === identity.workspaceId && item.sessionId === identity.sessionId));
        assert.equal(created.length, 1, "only the allocator publishes workspace creation");
        off();
        const [workspace] = await daemon.listWorkspaces();
        assert.equal((await daemon.listWorkspaces()).length, 1);
        assert.equal(workspace?.project_root, null);
        assert.match(workspace.name, /^(?=.*[A-Za-z])[A-Za-z0-9]{5}$/u);
        const [session] = await daemon.listSessions(identity.workspaceId);
        assert.equal((await daemon.listSessions(identity.workspaceId)).length, 1);
        assert.equal(session?.id, identity.sessionId);
        assert.equal(session?.origin, "model");
        assert.equal(session?.owner, "_plurnk");
        assert.equal(session?.parentSessionId, null);
        assert.match(session.name, /^[0-9a-f]{8}$/u);
        await daemon.renameWorkspace(identity.workspaceId, "Renamed # workspace");
        await daemon.registerSessionOwner(identity.workspaceId, { address: "fixture://owner", tools: [], interactive: false });
        await daemon.claimSessionOwner({ ...identity, owner: "fixture://owner" });
        assert.deepEqual(await daemon.ensureSessionReference(reference), identity);
        assert.deepEqual(await daemon.listSessionReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.deepEqual(await daemon.listSessionReferences({ ...identity, namespace: "another" }), []);
        assert.deepEqual(await daemon.listSessionLoops(identity), [], "binding does not start work");
    } finally { await daemon.stop(); await db.close(); }
    const reopened = await openMigrated(path);
    const next = new Daemon({ db: reopened, provider: null });
    try {
        assert.deepEqual(await next.readSessionReference(reference), identity);
        assert.deepEqual(await next.ensureSessionReference(reference), identity);
        assert.deepEqual(await next.listSessionReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.equal((await next.listWorkspaces())[0]?.name, "Renamed # workspace");
    } finally { await next.stop(); await reopened.close(); }
});

test("{§session-external-reference} namespaces and exact reference bytes isolate identities", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const inputs = [
            { namespace: "one", reference: "" },
            { namespace: "two", reference: "" },
            { namespace: "one", reference: "é" },
            { namespace: "one", reference: "e\u0301" },
            { namespace: "one", reference: "quote'\"; --" },
        ];
        const identities = await Promise.all(inputs.map((input) => daemon.ensureSessionReference(input)));
        assert.equal(new Set(identities.map(({ sessionId }) => sessionId)).size, inputs.length);
        assert.equal((await daemon.listWorkspaces()).length, inputs.length);
        for (const [i, input] of inputs.entries()) assert.deepEqual(await daemon.readSessionReference(input), identities[i]);
    } finally { await daemon.stop(); await db.close(); }
});

test("{§session-external-reference} independent database connections converge without process-local serialization", async () => {
    const path = join(await testArtifactDirectory("session-references"), `concurrent-${crypto.randomUUID()}.db`);
    const firstDb = await openMigrated(path);
    const secondDb = await openMigrated(path);
    const first = new Daemon({ db: firstDb, provider: null });
    const second = new Daemon({ db: secondDb, provider: null });
    const reference = { namespace: "fixture", reference: "parallel" };
    try {
        const [a, b] = await Promise.all([first.ensureSessionReference(reference), second.ensureSessionReference(reference)]);
        assert.deepEqual(a, b);
        assert.equal((await first.listWorkspaces()).length, 1);
        assert.equal((await second.listSessions(a.workspaceId)).length, 1);
    } finally {
        await first.stop(); await second.stop();
        await firstDb.close(); await secondDb.close();
    }
});

test("{§session-external-reference} allocation rolls back on failure and leaves existing names untouched", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const input = { namespace: "fixture", reference: "rollback", workspace_name: "NewWs", session_name: "" };
        await assert.rejects(db.session_reference_allocate.get(input), /CHECK constraint failed/u);
        assert.deepEqual(await daemon.listWorkspaces(), [], "failure at session creation rolls back the workspace too");
        assert.equal(await daemon.readSessionReference(input), null);
        const existing = await daemon.createWorkspace({ name: "NewWs" });
        assert.equal(await db.session_reference_allocate.get({ ...input, session_name: "valid" }), undefined);
        assert.deepEqual(await daemon.listSessions(existing.workspaceId), [], "a random name collision never adopts an existing workspace");
        const allocated = await daemon.ensureSessionReference(input);
        assert.notEqual(allocated.workspaceId, existing.workspaceId);
        await db.test_session_reference_delete_session.run({ session_id: allocated.sessionId });
        assert.equal(await daemon.readSessionReference(input), null, "deletion cascades through the association");
    } finally { await daemon.stop(); await db.close(); }
});
});

describe("session-streams", () => {
const held = (release: string, writes: boolean): string =>
    `${writes ? "printf 'live stdout\\n'; " : ""}while [ ! -e ${release} ]; do sleep 0.05; done`;

test("{§methods} a session's open streams: each lifetime, every channel written or not, its opening row, until it ends", { timeout: 120_000 }, async (t) => {
    serverProposals(t, "accept");
    const dir = await mkdtemp(join(tmpdir(), "session-streams-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const release = join(dir, "release");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse([
            `\`\`\`\`sh\n${held(release, true)}\n\`\`\`\``,
            `\`\`\`\`sh [{"lifetime": "turn"}]\n${held(release, false)}\n\`\`\`\``,
            `\`\`\`\`sh [{"lifetime": "detached"}]\n${held(release, false)}\n\`\`\`\``,
            "````WAIT [60]\nWaiting on them.\n````",
        ].join("\n\n"), 10),
        makeRawMockResponse("````SEND [200]\nDone.\n````", 10),
    ] });
    await withDaemon(mock, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-streams" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const bystander = await namedModelSession(daemon, workspaceId, "bystander");
        const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "session-streams-elsewhere" });
        await daemon.runLoop({ workspaceId, sessionId, prompt: "Hold three commands open." });
        const streams = await waitForDb(() => daemon.readStreams({ workspaceId, sessionId }), (open: ApplicationStream[]) => open.length === 3,
            { timeoutMs: 30_000 });

        assert.deepEqual(streams.map(({ lifetime }) => lifetime), ["loop", "turn", "detached"], "in opening order, each as its fence declared it");
        const rows = (await daemon.readLog({ workspaceId, sessionId })).filter(({ op }) => op === "sh");
        for (const stream of streams) {
            assert.match(stream.target, /^sh:\/\/\/[0-9a-f]{8}$/u, "the execution's workspace claim");
            assert.equal(stream.sessionId, sessionId);
            const opened = rows.find(({ attrs }) => (attrs as { stream?: string } | null)?.stream === stream.target);
            assert.ok(opened, `a row announced ${stream.target}`);
            assert.deepEqual([stream.loop_seq, stream.turn_seq, stream.sequence], [opened.loop_seq, opened.turn_seq, opened.sequence],
                "named by the row that opened it");
            assert.deepEqual(stream.channels.map(({ channel, state }) => ({ channel, state })),
                [{ channel: "stderr", state: "active" }, { channel: "stdout", state: "active" }], "every channel, stderr never written");
            for (const { mimetype } of stream.channels) assert.equal(typeof mimetype, "string");
        }

        assert.deepEqual(await daemon.readStreams({ workspaceId, sessionId: bystander }), [], "another session holds none of them");
        await assert.rejects(daemon.readStreams({ workspaceId: elsewhere, sessionId }), (error: unknown) =>
            error instanceof OperationFailureError && error.result.problem.type.endsWith("/workspace-mismatch"), "a session is read in its own workspace");

        await writeFile(release, "");
        await waitForDb(() => daemon.readStreams({ workspaceId, sessionId }), (open: ApplicationStream[]) => open.length === 0,
            { timeoutMs: 30_000 });
    });
});
});

