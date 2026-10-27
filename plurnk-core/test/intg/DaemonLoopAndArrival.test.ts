import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { type LoopUsage } from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { Validator } from "@plurnk/plurnk-contracts";
import { seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, readLog } from "./_scheme.ts";
import { readStmt, urlPath } from "./_dsl.ts";
import { serverProposals } from "./_approval.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, runLoopToTerminal, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";
import { viableWindow } from "./_provider.ts";

describe("Daemon.loop", () => {
test("{§loop-completion} loop.run accepts immediately (100); the loop's outcome arrives via loop/terminated", async () => {
    const dsl = "````EDIT (workspace:///france/capital)\nParis\n````\n\n````SEND\nParis is the capital.\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 142), makeMockResponse("````SEND [200]\nParis is the capital.\n````", 0)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-test" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "what is the capital of france?" });
            assert.equal(result.accepted, 100, "loop.run returns immediately — accepted, not the terminal");
            assert.equal(result.result.status, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds?.length, 3, "packetless initialization and both model turns are durable chronology (the edit receipt forced the second)");
            assert.equal(result.usage?.accounting.usage?.outputTokens, 142, "output tokens sum the physical request evidence");
            assert.equal(result.usage?.accounting.usage?.inputTokens, 0);
            assert.equal(result.usage?.accounting.usage?.outputTokenDetails?.reasoningTokens, 0);
            assert.equal(result.usage?.accounting.usage?.inputTokenDetails?.cacheReadTokens, 0);
            assert.equal(result.usage?.accounting.costUsd, "0");
            assert.deepEqual(result.attributions, [], "attribution remains a top-level terminal projection, separate from usage");

            const read = await rpcCall(ws, 3, "entry.read", { target: "workspace:///france/capital" });
            const materialized = Validator.assertEntryReadResult(read.result);
            assert.equal(materialized.status, 200);
            assert.equal(materialized.entry?.channels.body?.content, "Paris");
        } finally { ws.close(); }
    });
});

test("{§message-arrival}: a trusted adapter source survives message publication", async () => {
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)],
    });

    await withDaemon(mock, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({
            name: `prompt-source-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        const terminated: Array<{ loopId: number }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number });
        });
        try {
            const accepted = await daemon.runLoop({
                workspaceId: workspace.workspaceId,
                sessionId,
                prompt: "external work",
                source: "acp://session42",
            });
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId }) => loopId === accepted.loopId),
            );
            const prompt = (await daemon.readLog({
                workspaceId: workspace.workspaceId,
                sessionId,
                loopId: accepted.loopId,
            })).find((entry) => entry.op === "SEND" && entry.origin === "_plurnk");
            assert.equal(prompt?.origin, "_plurnk", "the harness remains the arrival-row producer");
            assert.equal(prompt?.source, "acp://session42", "the external actor remains its causal source");
        } finally {
            unsubscribe();
        }
    });
});

test("{§operation-results} loop.inject speaks into an existing session; errors when there's none", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND [200]\nfirst done\n````", 10),
        makeMockResponse("````SEND [200]\ninjected done\n````", 10),
    ] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-inject" });

            const noSession = await rpcCall(ws, 2, "loop.inject", { prompt: "too early" });
            const noSessionResult = noSession.result as { status: number; problem: { type: string; detail: string } };
            assert.equal(noSessionResult.status, 409);
            assert.equal(noSessionResult.problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(noSessionResult.problem.detail, "No model session exists for prompt injection.");

            await runLoopToTerminal(ws, 3, { prompt: "first" });

            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW, the config is TOML" });
            const result = injected.result as { action: string; loopId: number; modelSessionId: number };
            assert.equal(result.action, "enqueued_new_loop", "idle session → a fresh enqueued loop");
            assert.ok(typeof result.loopId === "number", "returns the loopId");
            assert.ok(typeof result.modelSessionId === "number", "returns the session it spoke into");

            const empty = await rpcCall(ws, 5, "loop.inject", { prompt: "" });
            const emptyResult = empty.result as { status: number; problem: { type: string } };
            assert.equal(emptyResult.status, 400);
            assert.equal(emptyResult.problem.type, "https://problems.plurnk.xyz/daemon/input/prompt-invalid");
        } finally { ws.close(); }
    });
});

test("{§operation-results} run.fork branches the model session into a named session; errors with no session", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````EDIT (workspace:///x)\nhi\n````\n\n````SEND\ndone\n````", 10), makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "fork-test" });

            const noSession = await rpcCall(ws, 2, "run.fork", {});
            const noSessionResult = noSession.result as { status: number; problem: { type: string; detail: string } };
            assert.equal(noSessionResult.status, 409);
            assert.equal(noSessionResult.problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(noSessionResult.problem.detail, "No model session exists to fork.");

            await runLoopToTerminal(ws, 3, { prompt: "do a thing" });
            const fork = await rpcCall(ws, 4, "run.fork", {});
            const r = fork.result as { sessionId: number; sessionName: string | null; parentSessionId: number };
            assert.ok(typeof r.sessionId === "number" && typeof r.parentSessionId === "number", "returns new and parent session ids");
            assert.notEqual(r.sessionId, r.parentSessionId, "the fork is a distinct session");
            assert.match(r.sessionName ?? "", /^[a-f0-9]{8}$/, "an unnamed fork gets the ordinary opaque session identity");

            const named = await rpcCall(ws, 5, "run.fork", { name: "harvest" });
            assert.equal((named.result as { sessionName: string | null }).sessionName, "harvest", "an explicit name names the branch");

            const runtimeName = await rpcCall(ws, 6, "run.fork", { name: "_plurnk" });
            const runtimeNameResult = runtimeName.result as { status: number; problem: { type: string } };
            assert.equal(runtimeNameResult.status, 400);
            assert.equal(runtimeNameResult.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");

            const taken = await rpcCall(ws, 7, "run.fork", { name: "harvest" });
            const takenResult = taken.result as { status: number; problem: { type: string } };
            assert.equal(takenResult.status, 409);
            assert.equal(takenResult.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict");

            const empty = await rpcCall(ws, 8, "run.fork", { name: "" });
            const emptyResult = empty.result as { status: number; problem: { type: string } };
            assert.equal(emptyResult.status, 400);
            assert.equal(emptyResult.problem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
        } finally { ws.close(); }
    });
});

test("{§turn-source-resources} loop.run streams log/entry notifications during execution", async () => {
    const dsl = "````EDIT (workspace:///x)\nhello\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50), makeMockResponse("````SEND [200]\ndone\n````", 0)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logNotifs = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "stream-test" });
            const terminal = await runLoopToTerminal(ws, 2, { prompt: "test" });

            const captured = logNotifs().filter((event) => (event as { entry?: { loop_id?: unknown } }).entry?.loop_id === terminal.loopId);
            const harness = captured
                .map((event) => (event as { entry: { id: number; op: string | null; origin: string; status_rx: number; attrs: unknown } }).entry)
                .filter((entry) => entry.origin === "_plurnk" && entry.op !== "SEND");
            assert.equal(harness.some(LogEntryProjection.isEmission), false, "`_plurnk` initialization announces no content emission ({§turn-source-resources})");
            const initialization = harness;
            assert.equal(
                captured.some((event) => (event as { entry: { op: string | null } }).entry.op === null),
                false,
                "initialization has no synthetic actionless receipt",
            );
            assert.equal(new Set(initialization.map(({ id }) => id)).size, initialization.length, "initialization rows are ordinary settled operations, not later updates");
            assert.ok(initialization.filter(({ op }) => op === "READ").every(({ status_rx }) => status_rx === 200));
            const authored = captured.filter((event) => {
                const entry = (event as { entry: { op: string | null; origin: string } }).entry;
                return (entry.op === "SEND" && entry.origin === "_plurnk") || entry.origin === "model";
            });
            assert.deepEqual(authored.map((event) => (event as { entry: { op: string } }).entry.op), ["SEND", "EDIT", "SEND", "SEND"], "each authored message and operation streams independently of initialization");
            const prompt = authored[0] as { entry: { op: string; origin: string } };
            assert.equal(prompt.entry.op, "SEND");
            assert.equal(prompt.entry.origin, "_plurnk");
            const first = authored[1] as { entry: { op: string; origin: string } };
            assert.equal(first.entry.op, "EDIT");
            assert.equal(first.entry.origin, "model");
            const firstReply = authored[2] as { entry: { op: string; status_rx: number } };
            assert.equal(firstReply.entry.op, "SEND");
            assert.equal(firstReply.entry.status_rx, 200, "delivery succeeds before the EDIT is observed");
            const observedReply = authored[3] as { entry: { op: string; status_rx: number } };
            assert.equal(observedReply.entry.op, "SEND");
            assert.equal(observedReply.entry.status_rx, 200, "the observation turn's reply is also delivered");
            assert.equal(terminal.finalStatus, 200);
        } finally { ws.close(); }
    });
});

test("{§notifications} loop.run fires loop/terminated notification on completion", async () => {
    const dsl = "````EDIT (workspace:///x)\nbody\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50), makeMockResponse("````SEND [200]\ndone\n````", 0)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "term-test" });
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            const ack = accept.result as { loopId: number; status: number };
            assert.equal(ack.status, 100, "loop.run accepts immediately, not the terminal");
            const captured = await waitFor(
                () => terminated() as Array<{ sessionId: number; loopId: number; result: { status: number }; hitMaxTurns: boolean; attributions: string[]; usage: LoopUsage }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1);
            const params = captured[0];
            assert.ok(params.sessionId > 0, "terminal carries its owning sessionId with the loopId");
            assert.equal(params.loopId, ack.loopId, "terminal coordinate matches the acknowledged loop");
            assert.equal(params.result.status, 200);
            assert.equal(params.hitMaxTurns, false);
            assert.deepEqual(params.attributions, []);
            assert.equal(params.usage.accounting.usage?.outputTokens, 50);
            assert.equal(params.usage.accounting.usage?.outputTokenDetails?.reasoningTokens, 0);
            assert.equal(params.usage.accounting.usage?.inputTokenDetails?.cacheReadTokens, 0);
        } finally { ws.close(); }
    });
});

test("{§engine-rails} loop.run still fires loop/terminated when the loop throws — no client hang", async () => {
    const dsl = "````EDIT (workspace:///x)\niter\n````\n\n````NOTE\ncontinue\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 10)] });
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map((x) => x instanceof Error ? x.stack ?? x.message : String(x)).join(" ")); };

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "errored-loop" });
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "go", maxTurns: 5 });
            assert.equal((accept.result as { status: number }).status, 100, "loop.run accepts immediately (100)");

            const captured = await waitFor(
                () => terminated() as Array<{ result: { status: number }; turnIds: number[]; hitMaxTurns: boolean; loopId: number }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1, "the errored loop fired loop/terminated — the client is not left hanging");
            assert.equal(captured[0].result.status, 500, "three provider-contract strikes terminate through the rail");
            assert.ok(captured[0].turnIds.length > 0, "every durable turn completed before the failure is accounted for");
            assert.equal(captured[0].hitMaxTurns, false);
            const exact = captured[0].result as { status: number; problem?: { type?: string; detail?: string } };
            assert.match(exact.problem?.type ?? "", /strike-threshold/, "the rail's verdict is the terminal");
            assert.match(exact.problem?.detail ?? "", /consecutive turns failed/, "the verdict names the streak, not one call");
            const loopRow = await _db.test_get_loop_status.get<{ status: number }>({ id: (captured[0] as { loopId: number }).loopId });
            assert.equal(loopRow?.status, 500, "the compact scheduler projection is terminal, never a live 102");
            assert.deepEqual(
                await new LoopLifecycle(_db).result((captured[0] as { loopId: number }).loopId),
                captured[0].result,
                "the durable loop result and emitted product result are identical",
            );
            const turns = await _db.test_list_turns_in_loop.all<{
                status: number;
                packet: string;
            }>({ loop_id: captured[0].loopId });
            const failedTurn = turns.at(-1);
            assert.equal(failedTurn?.status, 502, "the attempted provider turn is closed with the exact failure status");
            const failedPacket = JSON.parse(failedTurn?.packet ?? "{}") as {
                sections?: unknown;
                assistant?: unknown;
            };
            assert.ok(Array.isArray(failedPacket.sections), "the exact request packet survives forensics");
            assert.equal(failedPacket.assistant, undefined, "no empty assistant response is fabricated");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.equal(logged.some((l) => /drain error/.test(l)), false, "a rail termination is clean — no swallowed-throw diagnostics needed");
});

test("{§operation-results} loop.run without a model selection returns 501", async (t) => {
    const selected = process.env.PLURNK_MODEL;
    delete process.env.PLURNK_MODEL;
    t.after(() => {
        if (selected === undefined) delete process.env.PLURNK_MODEL;
        else process.env.PLURNK_MODEL = selected;
    });
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; problem?: { type?: string; detail?: string } };
            assert.equal(result.status, 501);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/daemon/provider/not-configured");
            assert.equal(result.problem?.detail, "No provider is configured for this session.");
        } finally { ws.close(); }
    });
});

test("{§operation-results} loop.run requires non-empty prompt", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "empty-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "" });
            const result = response.result as { status: number; problem?: { type?: string; detail?: string; field?: string } };
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/daemon/input/prompt-invalid");
            assert.equal(result.problem?.detail, "prompt is not a non-empty string.");
            assert.equal(result.problem?.field, "prompt");
        } finally { ws.close(); }
    });
});

test("{§tokenomics} loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    const dsl = "````EDIT (workspace:///x)\niter\n````\n\n````NOTE\ncontinue\n````";
    const responses = Array.from({ length: 5 }, () => makeMockResponse(dsl, 10));
    const mock = new Mock({ contextWindow: 32768, responses });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "maxturns-test" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "iterate", maxTurns: 3 });
            assert.equal(result.accepted, 100, "loop.run accepts immediately");
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.result.status, 429, "max_turns exhausts the turn ceiling → 429");
            assert.equal(result.turnIds?.length, 4, "packetless initialization does not consume the three-model-turn cap");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a fresh loop foists one turn-zero READ per path", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logNotifs = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "openpaths" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "look at these", openPaths: ["src/foo.ts", "README.md"] });
            const reads = (logNotifs() as Array<{ entry: { op: string; origin: string; scheme: string | null; pathname: string } }>)
                .map((c) => c.entry)
                .filter((e) => e.op === "READ" && e.origin === "_plurnk" && e.scheme === null);
            assert.deepEqual(reads.map((r) => r.pathname).toSorted(), ["README.md", "src/foo.ts"], "a plurnk-origin file READ foisted per openPath at turn 0 — columns in wire canon ({§fs-namespace})");
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number;
            }>({ loop_id: result.loopId });
            const frame = rows.find((row) => row.op === "SEND" && row.origin === "_plurnk");
            assert.ok(frame, "the initial message row exists");
            assert.ok(rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === null)
                .every((row) => row.turn_id === frame.turn_id),
            "every selected path is read in the same turn that publishes the initial message");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: initial reads preserve file paths, scheme addresses and channels", async () => {
    const mock = new Mock({ contextWindow: 32_768, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "openpaths-resources" });
            const { id: workspaceId } = created.result as { id: number };
            await seedEntryWithChannel(db, { workspaceId, scheme: "file", pathname: "literal (file).txt", content: "local-file-evidence" });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/reference.txt", content: "scheme-channel-evidence" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "Inspect the selected evidence.", openPaths: ["literal (file).txt", "workspace:///reference.txt#body"],
            });
            assert.equal(result.result.status, 200);
            const reads = (await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; status_rx: number;
            }>({ loop_id: result.loopId })).filter(({ op, origin }) => op === "READ" && origin === "_plurnk");
            assert.ok(reads.some(({ scheme, pathname, status_rx }) => scheme === null && pathname === "literal (file).txt" && status_rx === 200));
            assert.ok(reads.some(({ scheme, pathname, status_rx }) => scheme === "workspace" && pathname === "/reference.txt" && status_rx === 200), JSON.stringify(reads));
            const packet = mock.received[0].map(chatMessageText).join("\n");
            assert.match(packet, /local-file-evidence/u);
            assert.match(packet, /scheme-channel-evidence/u);
        } finally { ws.close(); }
    });
});

test("{§methods} a throwing seam subscriber never kills the loop — the transport's failure is its own", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            daemon.subscribeToEvents(() => { throw new Error("transport socket died mid-send"); });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "sub-throws" });
            await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            const t = await waitFor(() => terminated() as Array<{ result: { status: number } }>, (ts) => ts.length >= 1, { timeoutMs: 8000 });
            assert.equal(t[0].result.status, 200, "the loop concluded normally through a burst of throwing broadcasts");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.ok(logged.some((l) => l.includes("seam subscriber failed")), "every subscriber failure logged loudly — never silent, never fatal");
});
});

describe("arrival-fold", () => {
type LogRow = { origin: string; op: string; pathname: string; scheme: string; folded: string; turn_id: number };
const mock = () => new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });

test("{§message-arrival} the arrival row and a normal same-turn op are both born open", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompt-fold" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "hello there" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt !== undefined, "the message is logged once as an inbound SEND row");
            assert.equal(prompt.folded, "[]", "new message delivery is visible");
            const send = rows.find((r) => r.op === "SEND" && r.origin === "model" && r.turn_id === prompt.turn_id);
            assert.ok(send !== undefined, "the model's own op shares the turn");
            assert.equal(send.folded, "[]", "a normal op in the same turn stays visible");
        } finally { ws.close(); }
    });
});
});

describe("arrival-preview", () => {
const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("````SEND [200]\ndone\n````", 40)] });

type LogRow = { op: string; origin: string; scheme: string | null; pathname: string | null; lineMarker: string | null; tx: string | null; rx: string | null; status_rx: number };

test("{§tokenomics} a short message lands as one inbound SEND row", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-short" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "three\nshort\nlines" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt, "the arrival row exists");
            assert.equal(prompt.lineMarker, null, "message delivery is not a synthetic scoped retrieval");
            assert.match(prompt.tx ?? "", /three/, "the complete durable body belongs to the arrival row's sent side");
            assert.equal(rows.filter((r) => r.op === "SEND" && r.origin === "_plurnk").length, 1, "initialization does not duplicate message delivery");
        } finally { ws.close(); }
    });
});

test("{§tokenomics}: a jumbo message lands folded with its size; Open Messages points to its complete log body", async () => {
    await withDaemon(mock(), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-long" });
            const fat = Array.from({ length: 4_000 }, (_, i) => `prompt line ${i + 1}: ${"x".repeat(72)}`).join("\n");
            const resp = await runLoopToTerminal(ws, 2, { prompt: fat });
            const { loopId, turnIds } = resp as { loopId: number; turnIds: number[] };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt, "the arrival row exists");
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[turnIds.length - 1] });
            const packet = JSON.parse(row!.packet) as { weight: number; sections?: Array<{ name: string; slot: string; header: string | null; content: string }> };
            const log = packetSection(packet, "log");
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "messages");
            assert.doesNotMatch(log, /prompt line 1:/, "a body that does not fit is not shown in part");
            const projectedPrompt = logEntries(packet).find((entry) => typeof entry.logPath === "string" && entry.logPath.endsWith("/SEND"));
            assert.ok(projectedPrompt, "the arrival row is in the packet");
            assert.equal(projectedPrompt.body, undefined, "folded: the row is its size and its address");
            assert.equal(projectedPrompt.preview, undefined, "nothing is previewed on the model's behalf");
            const size = projectedPrompt.size as { lines: number; tokens: number };
            assert.equal(size.lines, 4000, "the size names the lines the model can READ");
            const budgetSection = (packet.sections ?? []).find((sec) => sec.name === "budget")?.content ?? "";
            const budget = Number(/"budget":\s*(\d+)/.exec(budgetSection)?.[1]);
            assert.ok(Number.isFinite(budget) && size.tokens > budget - packet.weight, "it did not fit the remaining budget");
            assert.ok(packet.weight <= budget, "the packet itself fits");
            const bodyTarget = typeof projectedPrompt.logPath === "string" ? projectedPrompt.logPath : undefined;
            assert.match(bodyTarget ?? "", /^log:\/\/\/1\/2\/\d+\/SEND$/, "the message body is addressed in the first packet-bearing turn");
            const session = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId });
            assert.ok(session, "the model session exists");
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace, "the model workspace exists");
            const recovered = await readLog(
                readStmt(urlPath("log", new URL(bodyTarget!).pathname), { marks: [1, -1] }),
                makeSchemeCtx({ db, workspaceId: workspace.id, sessionId: session.session_id, mimetypes: DEFAULT_MIMETYPES }),
            );
            assert.equal(recovered.status, 200);
            assert.equal(recovered.content, fat, "the advertised log READ returns the exact canonical prompt body");
            assert.ok(promptSection, "the messages section exists");
            assert.equal(promptSection.slot, "user", "the open-message pointers close the user-slot status clump");
            assert.equal(promptSection.header, "Open Messages");
            assert.match(promptSection.content, /^\[\{"path":"message:\/\/[^/]+\/[0-9a-f]{8}","origin":"user"\}\]$/, "an immutable message address, named as the operator's own request");
            assert.doesNotMatch(promptSection.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});

test("{§tokenomics}: a single-line jumbo prompt lands folded with its size, and its body stays READable", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-bomb" });
            const bomb = `find the needle: ${"hay ".repeat(50_000)}needle`;
            const resp = await runLoopToTerminal(ws, 2, { prompt: bomb });
            const { turnIds } = resp as { loopId: number; turnIds: number[] };
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds.at(-1)! });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; content: string }> };
            const log = packetSection(packet, "log");
            assert.doesNotMatch(log, /hay hay/u, "the jumbo line is not stuffed into the packet, nor cut into it");
            const arrival = logEntries(packet).find((entry) => typeof entry.logPath === "string" && entry.logPath.endsWith("/SEND"));
            assert.ok(arrival);
            assert.deepEqual(Object.keys(arrival.size as object).toSorted(), ["lines", "tokens"], "the row states its size");
            assert.equal((arrival.size as { lines: number }).lines, 1);
            assert.equal(arrival.preview, undefined);
        } finally { ws.close(); }
    });
});
});
