import test, { describe } from "node:test";
import assert from "node:assert/strict";
import ChannelWrite, { type WakeSessionPayload } from "../../src/core/ChannelWrite.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import Results from "../../src/core/results.ts";
import StreamMock from "./_stream-mock.ts";
import Daemon from "../../src/server/Daemon.ts";
import Http from "@plurnk/plurnk-schemes-http";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import { serverProposals } from "./_approval.ts";
import { Mock, chatMessageText, type MockResponse } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitFor } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { isExecutionOp, type KillStatement, InvalidNoticeError, type Notice } from "@plurnk/plurnk-contracts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { sendStmt, urlPath, noteStmt, completeStmt, execStmt, dispositionStmt, readStmt } from "./_dsl.ts";
import { type Executor } from "@plurnk/plurnk-execs";
import { testExecutors } from "./_execs.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";

describe("Engine.exec-surfaces", () => {
// An execution's result surfaces in the next turn's log (the execution log row links its output
// via stream=<runtime>:///<coord>), driven by a Mock model through the real loop via the daemon.









test("{§log-history-projection}: executor receipts keep one identity through packets, errors, retrieval, search, and curation", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const runtime = "search-api2";
    const path = `log:///1/2/2/${runtime}`;
    const task = "````NOTE\nInspect the failed invocation.\n````";
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse(`\`\`\`\`${runtime}\nidentityneedle\n\`\`\`\`\n${task}`, 10),
        makeMockResponse(`\`\`\`\`READ (${path})\`\`\`\`\n\`\`\`\`FIND (log:///**/${runtime}) ~identityneedle\`\`\`\`\n${task}`, 10),
        makeMockResponse(`\`\`\`\`KILL (log:///**/${runtime})\`\`\`\`\n${task}`, 10),
        makeMockResponse("````SEND [200]\nReviewed.\n````", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "executor-receipt-identity" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect an unavailable executor." });
            assert.equal(finalStatus, 200);
            assert.equal(turnIds?.length, 5);
            const packets = await Promise.all(turnIds.slice(2).map(async (id) => {
                const row = await db.test_get_packet.get<{ packet: string }>({ id });
                return JSON.parse(row!.packet);
            }));
            const invocation = logEntries(packets[0]).find((entry) => entry.logPath === path);
            assert.ok(invocation, "the failure is recorded under its invoked executor, including digits and hyphens");
            assert.equal(invocation.status, 400);
            assert.equal(invocation.stream, undefined, "an unknown executor did not allocate an output resource");
            assert.match(packetSection(packets[0], "errors"), /log:\/\/\/1\/2\/2\/search-api2/);
            const dispatched = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turnIds[1] });
            assert.equal(JSON.parse(dispatched.find((row) => isExecutionOp(row.op))!.rx).problem.instance, path,
                "the durable Problem and model-facing pointer address the same receipt");
            const retrievals = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: turnIds[2] });
            assert.equal(retrievals.find((row) => row.op === "READ")?.status_rx, 200);
            assert.equal(retrievals.find((row) => row.op === "FIND")?.status_rx, 200);
            assert.match(JSON.stringify(logEntries(packets[1]).filter((entry) => entry.logPath.endsWith("/FIND"))), /log:\/\/\/1\/2\/2\/search-api2/,
                "full-text search and path-glob selection return the same canonical leaf");
            assert.equal(logEntries(packets[2]).some((entry) => entry.logPath === path), false,
                "KILL selects that exact runtime's receipts and retires them from context");
        } finally { ws.close(); }
    });
});

test("{§log-history-projection}: rejected executor proposals use the same receipt identity as immediate failures", async (approvalContext) => {
    serverProposals(approvalContext, "reject");
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````sh\nprintf rejected\n````\n````NOTE\nInspect the decision.\n````", 10),
        makeMockResponse("````SEND [200]\nThe command was not run.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "executor-rejection-identity" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect the proposal decision." });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turnIds![1] });
            const problem = JSON.parse(rows.find((row) => isExecutionOp(row.op))!.rx).problem;
            assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/rejected");
            assert.equal(problem.instance, "log:///1/2/2/sh");
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds![2] });
            const packet = JSON.parse(row!.packet);
            assert.ok(logEntries(packet).some((entry) => entry.logPath === problem.instance));
        } finally { ws.close(); }
    });
});

test("{§exec-stream} a model's execution result surfaces visibly in the next turn without an explicit READ", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // {§exec-stream}: waiting joins the command; its result is visible before completion.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````sh\necho plurnk-index-probe\n````\n\n````WAIT\nwaiting\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run a command" });
            assert.equal(finalStatus, 200, "loop terminates on the turn-2 completed inventory");
            assert.ok((turnIds?.length ?? 0) >= 3, `expected initialization plus at least 2 model turns; got ${turnIds?.length}`);

            const turn2 = turnIds![2];
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(row?.packet ?? "{}");
            const entries = logEntries(packet);
            assert.ok(
                entries.some((e) => (e.stream ?? "").startsWith("sh:///")),
                `turn-2 log must link the exec result via stream=; got ${JSON.stringify(entries.map((e) => e.stream))}`,
            );
            // {§exec-stream} — the environment-observation machine foists a READ of the exec stream
            // into the next turn (origin=_plurnk), visible because the channel closed: the model SEES
            // its output, it never has to find+pull it. This is the loop the live demo exposed.
            assert.ok(
                entries.some((e) => e.logPath.endsWith("/READ") && e.origin === "_plurnk" && (e.path ?? "").includes("stdout")),
                `turn-2 must foist a READ of the exec stdout; got ${JSON.stringify(entries.map((e) => ({ logPath: e.logPath, path: e.path, origin: e.origin })))}`,
            );
            assert.match(packetSection(packet, "log"), /plurnk-index-probe/, "the foisted delta surfaces the actual stdout, open");
        } finally { ws.close(); }
    });
});

// {§exec-stream} {§tokenomics} — a 30-line structured result closes as a markerless READ: whole,
// because it fits, with the extent; the channel itself stays complete and typed.
test("{§exec-stream} a generated JSON result publishes whole with the extent through the next-turn packet", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const program = "process.stdout.write(Array.from({ length: 30 }, (_, i) => JSON.stringify({ n: i + 1, payload: String(i + 1).padStart(100, '0') })).join('\\n'))";
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````js\n" + program + "\n````\n````WAIT\nwaiting\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "structured-exec-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, {
                prompt: "run the query",

            });
            assert.equal(finalStatus, 200);

            const turn2 = turnIds![2];
            const rows = await db.test_log_entries_by_turn.all<{
                scheme: string;
                op: string;
                origin: string;
                rx: string;
                weight: number;
            }>({ turn_id: turn2 });
            const observation = rows.find((row) =>
                row.scheme === "js" && row.op === "READ" && row.origin === "_plurnk");
            assert.ok(observation, "the structured executor result reaches the ambient READ path");

            const result = JSON.parse(observation.rx) as { content: string; mimetype: string; startLine: number; range: { total: number; returned: [number, number] } };
            assert.equal(result.mimetype, "text/stream", "a markerless READ keeps the channel's mimetype");
            assert.equal(result.content.split("\n").length, 30, "the 30-line document is published whole: it fits");
            assert.equal(result.startLine, 1);
            assert.deepEqual([result.range.total, result.range.returned], [30, [1, 30]], "the extent names the whole document");
            assert.equal(observation.weight, contentWeight(result.content), "the stream delta stores its published body's weight");

            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow!.packet);
            const entry = logEntries(packet).find((candidate) =>
                candidate.logPath.endsWith("/READ") && (candidate.path ?? "").startsWith("js:///"));
            assert.ok(entry, "the model-facing packet contains the structured observation");
            assert.equal(entry.preview, undefined, "nothing is previewed on the model's behalf");
            assert.match(packetSection(packet, "log"), /1:\{"n":1,/, "the document's head is what the model sees");
            assert.match(packetSection(packet, "log"), /30:\{"n":30,/, "and so is its tail: whole when it fits");
        } finally {
            ws.close();
        }
    });
});

test("{§exec-stream} a failed execution with output on both channels is one failure and one Errors pointer", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````sh\nprintf 'partial output\\n'; printf 'last words\\n' >&2; kill -KILL $$\n````\n\n````WAIT\nwaiting\n````", 10),
        makeMockResponse("````SEND [200]\nfailure observed\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-one-failure" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run a command" });
            assert.equal(finalStatus, 200);
            const turn2 = turnIds![2];
            const rows = (await db.test_log_entries_by_turn.all<{ sequence: number; status_rx: number; scheme: string; fragment: string | null; op: string; origin: string; rx: string }>({ turn_id: turn2 }))
                .filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.equal(rows.length, 2, "one terminal READ per channel that holds content");
            const failed = rows.filter((row) => row.status_rx >= 400);
            assert.equal(failed.length, 1, "the execution's failure rides one row");
            assert.equal(failed[0].fragment, "stdout", "the default channel's row carries it");
            assert.equal(JSON.parse(failed[0].rx).problem?.type, "https://problems.plurnk.xyz/executor/subprocess/terminated-by-signal");
            const sibling = rows.find((row) => row.status_rx < 400)!;
            assert.equal(sibling.status_rx, 200);
            assert.equal(JSON.parse(sibling.rx).problem, undefined, "the sibling row is a plain read of its channel");
            assert.equal(JSON.parse(sibling.rx).content, "last words\n");
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn2 }))?.packet ?? "{}");
            assert.equal(JSON.parse(packetSection(packet, "errors")).length, 1, "one Errors pointer for one failed execution");
        } finally { ws.close(); }
    });
});

test("{§executor-results} {§exec-stream} a nonzero exit reaches the model as the command's answer on its terminal READs", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````sh\nprintf 'partial output\\n'; printf 'compile diagnostic\\n' >&2; exit 3\n````\n\n````WAIT\nwaiting\n````", 10),
        makeMockResponse("````SEND [200]\nfailure observed\n````", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-failure-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, {
                prompt: "run a command",

            });
            assert.equal(finalStatus, 200);
            assert.ok((turnIds?.length ?? 0) >= 3, `expected initialization plus at least 2 model turns; got ${turnIds?.length}`);

            const turn2 = turnIds![2];
            const rows = await db.test_log_entries_by_turn.all<{
                sequence: number;
                status_rx: number;
                pathname: string;
                scheme: string;
                fragment: string | null;
                op: string;
                origin: string;
                source: string | null;
                rx: string;
            }>({ turn_id: turn2 });
            const terminals = rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.equal(terminals.length, 2, "one terminal READ per channel that holds content");
            for (const terminal of terminals) {
                assert.equal(terminal.status_rx, 200);
                assert.equal(terminal.source, null);
                const result = JSON.parse(terminal.rx) as { status: number; exitCode?: number; problem?: unknown; content?: string };
                assert.equal(result.exitCode, 3);
                assert.equal(result.problem, undefined, "an exit code carries no Problem");
                assert.equal(result.content, terminal.fragment === "stderr" ? "compile diagnostic\n" : "partial output\n");
            }

            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow?.packet ?? "{}");
            const rendered = packetSection(packet, "log");
            const renderedTerminals = logEntries(packet).filter((entry) => /^sh:\/\/\/[a-f0-9]{8}#(?:stdout|stderr)$/.test(String(entry.path)));
            assert.equal(renderedTerminals.length, 2);
            assert.ok(renderedTerminals.every((entry) => entry.terminal === true && entry.exitCode === 3), "each row states the conclusion and its exit code");
            assert.equal(packetSection(packet, "errors"), "", "the command's answer brings nothing into Errors");
            assert.match(rendered, /compile diagnostic/);
            assert.match(rendered, /partial output/);
        } finally { ws.close(); }
    });
});

test("{§exec-stream} the cursor-terminal race: a one-burst stream consumed before its close still gets a visible terminal delta", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // A channel written in one final burst can be complete while its process is still active; the
    // close then arrives with no new content. The model must still see the stream conclude. Turn 1:
    // a slow-close command executes and the turn continues. Turn 2: the stream is active and represented
    // only by Child Streams. Turn 3: the terminal marker MUST land visibly despite no new bytes — never a silent skip.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````sh\necho burst-payload && sleep 2\n````\n\n````NOTE\nspawned\n````", 10),
        makeMockResponse("````NOTE\nwaiting\n````", 10),
        makeMockResponse("````NOTE\nchecking\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cursor-terminal" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run it" });
            assert.equal(finalStatus, 200);
            const last = turnIds![turnIds!.length - 1];
            const row = await db.test_get_packet.get<{ packet: string }>({ id: last });
            const packet = JSON.parse(row?.packet ?? "{}");
            const entries = logEntries(packet);
            const deltas = entries.filter((e) => e.logPath.endsWith("/READ") && e.origin === "_plurnk" && (e.path ?? "").includes("stdout"));
            assert.ok(deltas.length >= 1, "the stream's deltas surfaced");
            const log = packetSection(packet, "log");
            assert.match(log, /burst-payload/, "the burst content was delivered visibly as the terminal observation");
            // {§exec-stream} — the empty stderr channel is a fact on the stdout conclusion, never a row.
            const stderrConclusion = entries.filter((e) => e.origin === "_plurnk" && (e.path ?? "").includes("stderr"));
            assert.equal(stderrConclusion.length, 0, "an empty sibling channel lands no row of its own");
            assert.deepEqual(deltas[0]?.channels, { "#stderr": 0 }, "the surviving conclusion names the empty sibling");
        } finally { ws.close(); }
    });
});

// {§exec-stream} — a silent command still concludes visibly: one bodyless row on its default channel.
test("{§exec-stream} a command that prints nothing on any channel lands exactly one bodyless conclusion row", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````sh\ntrue\n````\n\n````NOTE\nspawned\n````", 10),
        makeMockResponse("````NOTE\nchecking\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "silent-command" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run it" });
            assert.equal(finalStatus, 200, "completion was never blocked by an undelivered termination");
            const last = turnIds![turnIds!.length - 1];
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: last }))?.packet ?? "{}");
            const conclusions = logEntries(packet).filter((e) => e.origin === "_plurnk" && (e.path ?? "").startsWith("sh:///"));
            assert.equal(conclusions.length, 1, "one bodyless conclusion row for a silent stream");
            assert.equal(conclusions[0]?.terminal, true);
            assert.deepEqual(conclusions[0]?.channels, { "#stderr": 0 });
            assert.equal("body" in conclusions[0], false);
        } finally { ws.close(); }
    });
});
});

describe("Engine.structured-stream", () => {
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

class StructuredFixture {
    static manifest = {
        name: "structured-fixture",
        channels: { results: "application/json" },
        defaultChannel: "results",
        category: "data",
        writableBy: ["_plurnk"],
        volatile: true,
        modelVisible: false,
    } as const;
}

const response = (op: "NOTE" | "SEND") => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [op === "NOTE" ? noteStmt("continue") : sendStmt(null, "done")],
    },
});

const setup = async (
    mimetype: string,
    content: string,
    responses: ConstructorParameters<typeof Mock>[0]["responses"] = [response("NOTE"), response("SEND")],
) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `structured-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "observe structured output");
    const schemes = new SchemeRegistry();
    schemes.register("structured-fixture", new StructuredFixture());
    const engine = new Engine({ db, schemes });
    const entryId = await seedEntryWithChannel(db, {
        workspaceId,
        scheme: "structured-fixture",
        pathname: "/1/0/1",
        channel: "results",
        content,
        mimetype,
        state: "active",
    });
    const subscriptionId = await ChannelWrite.openSubscription(db, {
        sessionId,
        entryId,
        scheme: "structured-fixture",
        handle: "fixture",
        publishedChannel: "results",
    });
    const provider = new Mock({ contextWindow: 100000, responses });
    const runTurn = () => engine.runTurn({
        provider,
        workspaceId,
        sessionId,
        loopId,
        messages: [
            { role: "system" as const, content: "Observe the result." },
            { role: "user" as const, content: "Continue." },
        ],
    });
    return { db, sessionId, loopId, entryId, subscriptionId, runTurn };
};

const structuredRows = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) =>
    db.test_log_entries_by_turn.all<{
        id: number;
        sequence: number;
        scheme: string;
        op: string;
        origin: string;
        rx: string;
        attrs: string;
        active: 0 | 1;
    }>({ turn_id: turnId }).then((rows) => rows.filter((row) =>
        row.scheme === "structured-fixture" && row.op === "READ" && row.origin === "_plurnk"));

type Fixture = Awaited<ReturnType<typeof setup>>;

const structuredRow = async (fixture: Fixture, turnId: number) => {
    const rows = await structuredRows(fixture.db, turnId);
    assert.equal(rows.length, 1);
    return rows[0];
};

const close = async (fixture: Fixture, chunk?: string): Promise<void> => {
    if (chunk !== undefined) {
        await ChannelWrite.appendToChannel(fixture.db, {
            entryId: fixture.entryId,
            producerSessionId: fixture.sessionId,
            channel: "results",
            chunk,
        });
    }
    await ChannelWrite.setChannelState(fixture.db, {
        entryId: fixture.entryId,
        producerSessionId: fixture.sessionId,
        channel: "results",
        state: "closed",
    });
    await ChannelWrite.closeSubscription(fixture.db, {
        subscriptionId: fixture.subscriptionId,
        result: { status: 200 },
    });
};

test("{§exec-stream} an atomic application/json channel remains hidden until its complete terminal document exists", async () => {
    const fixture = await setup("application/json", '[{"n":1},');
    try {
        const active = await fixture.runTurn();
        assert.deepEqual(
            await structuredRows(fixture.db, active.turnId),
            [],
            "an active fragment is not surfaced as malformed JSON",
        );

        await close(fixture, '{"n":2}]');

        const terminal = await fixture.runTurn();
        const row = await structuredRow(fixture, terminal.turnId);
        const result = JSON.parse(row.rx) as { content: string; mimetype: string; startLine?: number };
        // {§exec-stream} {§packet} — the conclusion is a markerless READ: its first page, with its extent.
        assert.deepEqual(result, {
            status: 200,
            terminal: true,
            content: '[{"n":1},{"n":2}]',
            mimetype: "application/json",
            startLine: 1,
            range: { unit: "line", total: 1, requested: [1, PAGE], returned: [1, 1] },
        });
        assert.deepEqual(JSON.parse(row.attrs), { streamEnd: 17 });
    } finally {
        await fixture.db.close();
    }
});

test("{§packet} application/jsonl publishes nothing while active; its records arrive once, at close", async () => {
    const fixture = await setup("application/jsonl", '{"n":1}\n{"n":');
    try {
        const active = await fixture.runTurn();
        assert.deepEqual(await structuredRows(fixture.db, active.turnId), [], "an active stream enters the Log only as its Open Work stream pointer");

        await close(fixture, "2}\n");

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            terminal: true,
            content: '{"n":1}\n{"n":2}\n',
            mimetype: "application/jsonl",
            startLine: 1,
            range: { unit: "line", total: 2, requested: [1, PAGE], returned: [1, 2] },
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 16 });
    } finally {
        await fixture.db.close();
    }
});

test("{§packet} an active text channel publishes nothing; its content arrives once, at close", async () => {
    const fixture = await setup("text/plain; charset=utf-8", "event one\n");
    try {
        const active = await fixture.runTurn();
        assert.deepEqual(await structuredRows(fixture.db, active.turnId), [], "an active stream enters the Log only as its Open Work stream pointer");

        await close(fixture, "event two\n");

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            terminal: true,
            content: "event one\nevent two\n",
            mimetype: "text/plain; charset=utf-8",
            startLine: 1,
            range: { unit: "line", total: 2, requested: [1, PAGE], returned: [1, 2] },
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 20 });
    } finally {
        await fixture.db.close();
    }
});

test("{§packet} a stream that closes with no new content still emits exactly one conclusion", async () => {
    const fixture = await setup("application/jsonl", '{"n":1}\n');
    try {
        const active = await fixture.runTurn();
        assert.equal((await structuredRows(fixture.db, active.turnId)).length, 0);

        await close(fixture);

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            terminal: true,
            content: '{"n":1}\n',
            mimetype: "application/jsonl",
            startLine: 1,
            range: { unit: "line", total: 1, requested: [1, PAGE], returned: [1, 1] },
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 8 });
    } finally {
        await fixture.db.close();
    }
});

test("{§packet} a published channel materializes its exact terminal result override", async () => {
    const fixture = await setup("application/json", '{"ok":false}');
    const channelFailure = Results.failure(
        "scheme:structured-fixture",
        "channel-failed",
        500,
        "The selected representation failed.",
    );
    try {
        await ChannelWrite.closeSubscription(fixture.db, {
            subscriptionId: fixture.subscriptionId,
            result: { status: 200 },
            channelResults: { results: channelFailure },
        });

        const terminal = await fixture.runTurn();
        const row = await structuredRow(fixture, terminal.turnId);
        const result = JSON.parse(row.rx) as {
            status: number;
            content: string;
            mimetype: string;
            problem?: { detail?: string };
        };
        assert.equal(result.status, 500, "the channel override, not the universal success, reaches the model");
        assert.equal(result.problem?.detail, "The selected representation failed.");
        assert.equal(result.content, '{"ok":false}');
        assert.equal(result.mimetype, "application/json");
    } finally {
        await fixture.db.close();
    }
});

test("{§exec-stream}: invalid result liveness cannot advance publication or leave a log row", async () => {
    const fixture = await setup("text/plain", "output");
    try {
        const turn = await fixture.runTurn();
        const channels = await fixture.db.engine_session_stream_channels.all<{ publication_id: number }>({ session_id: fixture.sessionId });
        assert.equal(channels.length, 1);
        const before = await structuredRows(fixture.db, turn.turnId);
        const publication = await fixture.db.test_subscription_publications.all({ id: fixture.subscriptionId });
        for (const terminal of [undefined, null, "true", 1]) {
            await assert.rejects(fixture.db.engine_insert_stream_delta.get({
                session_id: fixture.sessionId, loop_id: fixture.loopId, turn_id: turn.turnId,
                sequence: 100, subscription_publication_id: channels[0].publication_id,
                scheme: "structured-fixture", hostname: null, port: null,
                pathname: "/1/0/1", fragment: "results",
                rx: JSON.stringify({ status: 200, content: "output", terminal }),
                status: 200, weight: 3, attrs: JSON.stringify({ streamEnd: 6 }), folded: "[]",
            }), /subscription publication requires one canonical stream observation/);
            assert.deepEqual(await structuredRows(fixture.db, turn.turnId), before, "the invalid observation is rolled back");
            assert.deepEqual(await fixture.db.test_subscription_publications.all({ id: fixture.subscriptionId }), publication,
                "the invalid observation cannot consume a delivery");
        }
    } finally {
        await fixture.db.close();
    }
});

test("{§packet} KILLing a terminal observation cannot erase its subscription delivery transition", async () => {
    const kill: KillStatement = {
        metadata: null,
        op: "KILL",
        aside: null,
        target: urlPath("log", "/1/2/2"),
        lineMarker: null,
        matcher: null, body: null,
        position: { line: 1, column: 1 },
    };
    const fixture = await setup("application/json", "", [
        response("NOTE"),
        {
            assistant: {
                content: "",
                reasoning: null,
                ops: [kill, noteStmt("failure observed")],
            },
        },
        response("SEND"),
    ]);
    try {
        await ChannelWrite.setChannelState(fixture.db, {
            entryId: fixture.entryId,
            producerSessionId: fixture.sessionId,
            channel: "results",
            state: "errored",
        });
        await ChannelWrite.closeSubscription(fixture.db, {
            subscriptionId: fixture.subscriptionId,
            result: Results.failure(
                "scheme:structured-fixture",
                "expected-failure",
                500,
                "The fixture failed as expected.",
                {},
                { retryable: false },
            ),
        });

        const observed = await fixture.runTurn();
        const terminal = await structuredRow(fixture, observed.turnId);
        assert.equal(terminal.sequence, 2, "the terminal observation is the pre-model row addressed by the curation turn");
        assert.equal((JSON.parse(terminal.rx) as { status: number }).status, 500);
        assert.deepEqual(
            await fixture.db.test_subscription_publications.all({ id: fixture.subscriptionId }),
            [{ channel: "results", published_end: 0, terminal_published: 1 }],
            "the terminal READ advances the subscription-owned channel cursor",
        );

        const curated = await fixture.runTurn();
        assert.deepEqual(curated.outcomes, [
            { op: "KILL", status: 200, problemType: null },
            { op: "NOTE", status: 200, problemType: null },
        ]);
        const durableObservations = await structuredRows(fixture.db, observed.turnId);
        assert.equal(durableObservations.length, 1, "the terminal observation remains durable evidence");
        assert.equal(durableObservations[0]?.active, 0, "KILL retires its model-facing projection");
        assert.equal(
            (await fixture.db.engine_render_log.all<{ id: number }>({ session_id: fixture.sessionId }))
                .some(({ id }) => id === durableObservations[0]?.id),
            false,
            "the killed observation no longer renders",
        );
        assert.deepEqual(
            await fixture.db.test_subscription_publications.all({ id: fixture.subscriptionId }),
            [{ channel: "results", published_end: 0, terminal_published: 1 }],
            "KILLing the log row leaves the subscription-owned transition intact",
        );

        const completed = await fixture.runTurn();
        assert.deepEqual(
            await structuredRows(fixture.db, completed.turnId),
            [],
            "the terminal result is not published again after its observation row is curated away",
        );
        assert.deepEqual(completed.outcomes, [{ op: "SEND", status: 200, problemType: null }],
            "log curation cannot make an already-published terminal result pending again");
        const source = await fixture.db.test_get_subscription.get<{ close_result: string }>({
            id: fixture.subscriptionId,
        });
        assert.equal(
            (JSON.parse(source?.close_result ?? "null") as { status?: number } | null)?.status,
            500,
            "curating the observation leaves the durable source failure intact",
        );
    } finally {
        await fixture.db.close();
    }
});
});

describe("exec-conclude-honesty", () => {
// {§capability-ctx} {§exec-stream} A rejecting executor must still conclude
// its stream, and cancellation outranks an executor's later 2xx claim. A stub
// runtime drives the real dispatch path; nothing below the executor is mocked.

















let wireN = 0;
const wire = async (run: Executor["run"]) => {
    const tag = `honesty${++wireN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const wakes: WakeSessionPayload[] = [];
    const notices: Notice[] = [];
    const engine = new Engine({
        db,
        schemes,
        mimetypes: DEFAULT_MIMETYPES,
        wakeSessionNotify: (p) => { wakes.push(p); },
        noticeNotify: (_workspaceId, payload) => { notices.push(payload.notice); },
    });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag, glyph: "?",
            get manifest() { return { name: tag, channels: { results: "text/stream" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/stream", defaultState: "active" as const } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run,
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "?", summary: "Conclude fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } }, details: "", available: true, detail: undefined,
    } as never);
    const workspaceId = await insertWorkspace(db, `honesty-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "honesty test");
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "```NOTE\nInspect execution results.\n```", reasoning: null } }] }),
        workspaceId, sessionId, loopId, messages: [],
    });
    notices.length = 0;
    const { id: turnId } = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
    return { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes, notices };
};

test("{§executor-results} a rejecting driver still concludes its stream with an exact Problem, never an open corpse", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes } = await wire(async () => {
        throw new Error("Invalid URL");
    });
    try {
        const result = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, `the spawn started; got ${result.status}`);
        const concluded = await waitFor(() => wakes, (w) => w.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 500, "the rejected execution concluded as a FAILURE, not an open subscription");
        assert.equal(concluded[0].result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-threw");
    } finally { await db.close(); }
});

for (const reported of [{ status: 500, exitCode: 1 }, { status: 102 }, { status: 202 }, { status: 200, content: "not a producer field" }]) {
    test(`{§executor-results} invalid executor result ${JSON.stringify(reported)} becomes a durable terminal failure`, async () => {
        const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes } = await wire(async () => reported as never);
        try {
            const started = await engine.dispatch({
                statement: execStmt(tag, "go"),
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence: 1,
                origin: "model",
            });
            assert.equal(started.status, 200);
            const concluded = await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
            assert.equal(concluded[0].result.status, 500);
            assert.equal(
                concluded[0].result.problem?.type,
                "https://problems.plurnk.xyz/scheme/exec/executor-invalid-result",
            );
            assert.equal(concluded[0].result.problem?.stage, "result-validation");
            assert.equal(concluded[0].result.problem?.runtime, tag);
            assert.equal(concluded[0].result.problem?.retryable, false);
            assert.equal(await ChannelWrite.findActiveSubscription(db, { entryId: concluded[0].entryId }), null,
                "a rejected result cannot strand an open subscription");
        } finally { await db.close(); }
    });
}

test("{§operation-results} an executor notice with explicit severity crosses the extension boundary unchanged", async () => {
    const notice = {
        source: "exec:honesty",
        kind: "progress",
        level: "warn",
        message: "still working",
        completed: 1,
        total: 2,
    } as const satisfies Notice;
    const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes, notices } = await wire(async ({ emit }) => {
        emit(notice);
        return { status: 200 };
    });
    try {
        const started = await engine.dispatch({
            statement: execStmt(tag, "go"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(started.status, 200);
        const concluded = await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 200);
        assert.equal(notices.length, 1);
        assert.equal(notices[0], notice, "the executor's Notice object is forwarded without rewriting severity or payload");
    } finally { await db.close(); }
});

test("{§operation-results} a runtime-JavaScript notice without severity fails at the extension boundary with its cause", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes, notices } = await wire(async ({ emit }) => {
        emit({
            source: "exec:honesty",
            kind: "progress",
            message: "missing producer severity",
        } as never);
        return { status: 200 };
    });
    try {
        const started = await engine.dispatch({
            statement: execStmt(tag, "go"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(started.status, 200);
        const concluded = await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 500);
        assert.equal(
            concluded[0].result.problem?.type,
            "https://problems.plurnk.xyz/scheme/exec/executor-threw",
        );
        assert.deepEqual(notices, [], "invalid third-party output is rejected before fan-out");
        assert.equal(diagnostics.length, 1, "the boundary reports the contract failure once");
        assert.match(String(diagnostics[0]?.[0]), new RegExp(`Executor '${tag}' threw outside its operation result contract`));
        assert.ok(diagnostics[0]?.[1] instanceof InvalidNoticeError, "the contracts validator error remains the reported cause");
    } finally { await db.close(); }
});

test("{§executor-results} a driver resolving 200 under abort is replaced by a 499 Problem — service truth outranks the claim", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes } = await wire((args) => new Promise((res) => {
        // The 0.3.3-class liar: hangs until aborted, then claims success.
        args.signal.addEventListener("abort", () => res({ status: 200, exitCode: 0 }), { once: true });
    }));
    try {
        const result = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, `the spawn started; got ${result.status}`);
        const sub = await db.test_open_subscription_for_session.get<{ id: number }>({ session_id: sessionId });
        assert.ok(sub !== undefined, "the spawn's subscription is open");
        await engine.cancelSubscription(sub.id);
        const concluded = await waitFor(() => wakes.filter((w) => w.result !== undefined), (w) => w.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 499, "the reaped execution concluded 499, not the driver's claimed 200");
        assert.equal(concluded[0].result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/execution-cancelled");
    } finally { await db.close(); }
});

for (const rejection of ["signal reason", "AbortError", "unrelated error"] as const) {
    test(`{§executor-results}: an executor rejecting with ${rejection} during cancellation is classified by its cause`, async (t) => {
        const diagnostics: unknown[][] = [];
        t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
        // The classification under test is of a rejection the executor raises on abort, so the
        // cancellation waits for the run to begin: an earlier one concludes before any run.
        const running = Promise.withResolvers<void>();
        const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes } = await wire(({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(rejection === "signal reason"
                ? signal.reason
                : rejection === "AbortError"
                    ? new DOMException("The operation was aborted", "AbortError")
                    : new Error("Unrelated executor defect")), { once: true });
            running.resolve();
        }));
        try {
            const started = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
            assert.equal(started.status, 200);
            const sub = await db.test_open_subscription_for_session.get<{ id: number }>({ session_id: sessionId });
            assert.ok(sub);
            await running.promise;
            await engine.cancelSubscription(sub.id);
            const [concluded] = await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
            const cancelled = rejection !== "unrelated error";
            assert.equal(concluded.result.status, cancelled ? 499 : 500);
            assert.equal(concluded.result.problem?.type, `https://problems.plurnk.xyz/scheme/exec/${cancelled ? "execution-cancelled" : "executor-threw"}`);
            assert.equal(diagnostics.length, cancelled ? 0 : 1, "cancellation is expected, while genuine failures retain their diagnostic");
        } finally { await db.close(); }
    });
}

for (const specimen of [
    { label: "non-empty success", content: "Alice\n", status: 200 },
    { label: "empty success", content: "", status: 200 },
    { label: "non-empty failure", content: "driver failed\n", status: 500 },
    { label: "empty failure", content: "", status: 500 },
] as const) {
    test(`{§exec-stream} a completed but unobserved ${specimen.label} keeps a same-turn wait alive for its next-packet terminal observation`, async () => {
        const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes } = await wire(async (args) => {
            if (specimen.content !== "") args.write("results", specimen.content);
            return specimen.status === 200
                ? { status: 200, exitCode: 0 }
                : Results.failure(
                    "executor:honesty",
                    "expected-failure",
                    500,
                    "The executor reported the test failure.",
                    { exitCode: 1 },
                    { runtime: tag, retryable: false },
                );
        });
        try {
            const started = await engine.dispatch({
                statement: execStmt(tag, "go"),
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            });
            assert.equal(started.status, 200);
            await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
            assert.equal(wakes[0].result.status, specimen.status);

            const waited = await engine.dispatch({
                statement: dispositionStmt("WAIT", "waiting"),
                workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
            });
            assert.equal(
                waited.status,
                102,
                "closed is not observed: the loop continues so the terminal stream observation can land next packet",
            );
            const completed = await engine.executeAdmittedTurn({
                statements: [completeStmt()], source: null, emission: null,
                workspaceId, sessionId, loopId, turnId, fromSequence: 3, origin: "model",
            });
            assert.equal(completed.status, 102, "closed but unobserved: the completion defers to the next packet");
            assert.deepEqual(completed.outcomes, [{ op: "SEND", status: 200, problemType: null }], "message completion is delivered while the loop still observes results");
            const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: {
                content: "", reasoning: null,
            } }] });
            const observed = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
            assert.equal(observed.status, 200);
            const packet = JSON.stringify(provider.received[0]);
            assert.match(packet, /terminal/, "even an empty stream has an observable terminal result");
            if (specimen.content.length > 0) assert.ok(packet.includes(specimen.content.trim()));
            if (specimen.status === 500) assert.ok(packet.includes("expected-failure"));
        } finally { await db.close(); }
    });
}

test("{§loop-completion}: an earlier turn's completed stream is identified without inventing a current operation", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId, tag, wakes } = await wire(async () => ({ status: 200 }));
    try {
        assert.equal((await engine.dispatch({
            statement: execStmt(tag, "go"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        })).status, 200);
        await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
        await Turn.complete(db, turnId, 102);
        const { id: nextTurnId } = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const completed = await engine.executeAdmittedTurn({
            statements: [completeStmt()], source: null, emission: null,
            workspaceId, sessionId, loopId, turnId: nextTurnId, fromSequence: 1, origin: "model",
        });
        assert.equal(completed.status, 102);
        assert.deepEqual(completed.outcomes, [{ op: "SEND", status: 200, problemType: null }], "the earlier execution is not invented in this program");
    } finally { await db.close(); }
});
});

describe("exec-stream-page", () => {
// {§exec-stream} {§exec-stream} — an active stream reaches the model only as an Open Work stream
// pointer with its size and growth; at close, ONE foisted READ that is exactly a markerless READ: the
// first page of the output ({§packet}), the extent, the terminal status. The channel
// keeps every line for a scoped READ.








const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is
const PAGE_CHARS = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);

const withSettlement = async (ms: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = ms;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
};

test("{§exec-stream} a 40-line stream closes as its first page with the extent; a scoped READ still reaches line 40", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new StreamMock({
        contextWindow: 100_000,
        responses: [
            makeRawMockResponse("````sh\nseq 1 40\n````\n\n````NOTE\nlaunched the count\n````\n\n````WAIT\nwaiting\n````", 10),
            makeMockResponse("````READ ($STREAM#stdout) <38,40>````\n````NOTE\nreading the tail\n````", 10),
            makeMockResponse("````SEND [200]\ndone\n````", 10),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-page" });
            const { finalStatus, turnIds, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "count" });
            const turn2 = turnIds![2];
            const rows = await db.test_log_entries_by_turn.all<{ id: number; scheme: string; op: string; origin: string; source: string | null; fragment: string | null; rx: string }>({ turn_id: turn2 });
            const foisted = rows.find((r) => r.scheme === "sh" && r.op === "READ" && r.origin === "_plurnk" && r.fragment === "stdout");
            assert.ok(foisted, "the stream's terminal observation was foisted");
            assert.equal(foisted.source, null, "invocation correlation is not copied into actor attribution");
            assert.equal((await db.test_stream_observation_source.get<{ source: string }>({ id: foisted.id }))?.source,
                "log:///1/2/3/sh", "publication identity retains the exact durable invocation relationship");
            const rx = JSON.parse(foisted.rx) as { exitCode: number; content: string; mimetype: string; startLine: number; range: { unit: string; total: number; returned: [number, number] } };
            assert.equal(rx.exitCode, 0, "the exact subprocess conclusion remains durable");
            assert.equal(rx.content.split("\n").filter((l) => l !== "").length, 40, "the whole output: 40 lines fit the first page");
            assert.equal(rx.content.startsWith("1\n2\n"), true, "from the first line — a markerless READ");
            assert.equal(rx.startLine, 1);
            assert.deepEqual(rx.range, { unit: "line", total: 40, requested: [1, PAGE], returned: [1, 40] });
            assert.equal(rx.mimetype, "text/stream", "the channel's own mimetype, as a markerless READ keeps it");
            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow!.packet);
            const log = packetSection(packet, "log");
            assert.match(log, /\s1:1\n/, "line 1 is delivered");
            assert.match(log, /\n40:40(?:\n|$)/, "and so is line 40: the first page holds them all");
            const terminal = logEntries(packet).find((e) => e.logPath.endsWith("/READ") && (e.path ?? "").includes("stdout"));
            assert.ok(terminal, "the terminal observation names the read resource under path");
            assert.equal(terminal.target, undefined);
            assert.equal(terminal.stream, undefined);
            assert.equal(terminal.source, undefined);
            assert.equal(terminal.terminal, true);
            assert.equal(terminal.exitCode, 0);
            assert.equal(terminal.range, "40 lines");
            // {§exec-stream} — the empty stderr channel is a fact on the stdout conclusion, never a row of its own.
            const emptyTerminal = logEntries(packet).find((e) => e.logPath.endsWith("/READ") && (e.path ?? "").includes("stderr"));
            assert.equal(emptyTerminal, undefined, "an empty sibling channel lands no row");
            assert.deepEqual(terminal.channels, { "#stderr": 0 }, "the surviving conclusion names the empty sibling");
            assert.equal(finalStatus, 200, "the scoped READ turn concluded");
            const read = await db.test_get_log_rx_by_session_op.get<{ rx: string }>({ session_id: modelSessionId, op: "READ" });
            const asked = JSON.parse(read!.rx) as { content: string; startLine: number };
            assert.equal(asked.content, "38\n39\n40", "the channel keeps every line for a scoped READ");
            assert.equal(asked.startLine, 38);
            const nextPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnIds![3] }))!.packet);
            const explicit = logEntries(nextPacket).find((row) => /^log:\/\/\/1\/3\/\d+\/READ$/u.test(row.logPath) && row.origin === undefined);
            assert.ok(explicit, "the requested tail reaches the next model request");
            assert.equal(explicit.terminal, true, "a deliberate stream READ conveys the same liveness as the automatic observation");
            assert.equal(explicit.exitCode, 0, "the subprocess exit code survives deliberate READ projection");
            assert.equal(explicit.range, "<38,40> of 40 lines");
            const request = provider.received.at(-1)!;
            const launch = request.findIndex((message) => message.role === "assistant" && chatMessageText(message).includes("seq 1 40"));
            const observed = request.findIndex((message) => message.role === "user" && chatMessageText(message).includes(`### ${terminal.logPath}`));
            const tailRead = request.findIndex((message) => message.role === "assistant" && chatMessageText(message).includes(`READ (${String(terminal.path)}) <38,40>`));
            assert.ok(launch >= 0 && observed > launch && tailRead > observed,
                `{§emission-history}: launch ${launch}, asynchronous observation ${observed}, subsequent program ${tailRead} must remain in causal order`);
        } finally {
            ws.close();
        }
    }));
});

test("{§exec-stream} an active stream reaches the model only as an Open Work stream pointer with its size and growth", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new StreamMock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nseq 1 5; sleep 2\n````\n\n````NOTE\nlet it run\n````", 10),
            // the stream is still running when this packet is built: only the pointer shows it
            makeMockResponse("````WAIT\nwait for it\n````", 10),
            makeMockResponse("````SEND [200]\ndone\n````", 10),
        ],
    });
    await withSettlement("200", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-ambient" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run" }, { timeoutMs: 20_000 });
            assert.equal(finalStatus, 200);
            const turn2 = turnIds![2];
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn2 }))!.packet);
            const pointers = packetSection(packet, "work");
            assert.match(pointers, /"status":"active","path":"sh:\/\/\/[a-f0-9]{8}","detail":"[^"]*stdout 5 lines \(\+\d+ bytes\)/, "the pointer carries size and growth");
            assert.match(JSON.parse(pointers).streams[0].detail, /^elapsed \d+s; output unchanged \d+s;/u,
                "a real running subprocess carries timing through the assembled provider packet");
            const log = packetSection(packet, "log");
            assert.doesNotMatch(log, /"path":"sh:\/\/\/[a-f0-9]{8}#stdout"/, "nothing of the stream enters the Log while it is active");
        } finally {
            ws.close();
        }
    }));
});

const RECORDS = Array.from({ length: 10 }, (_, index) => JSON.stringify({ index, text: "x".repeat(1900) }));
const RECORD_PAGE = Math.floor(PAGE_CHARS / (RECORDS[0].length + 1)); // complete records within the character bound
for (const specimen of [
    {
        name: "long JSON records",
        content: RECORDS.join("\n"),
        page: RECORDS.slice(0, RECORD_PAGE).join("\n"),
        pageLines: RECORD_PAGE,
        range: { unit: "line", total: 10, requested: [1, RECORD_PAGE], returned: [1, RECORD_PAGE] },
        packetRange: `<1,${RECORD_PAGE}> of 10 lines`,
    },
    {
        name: "a long Unicode line",
        content: "😀".repeat(3000),
        page: "😀".repeat(3000),
        pageLines: 1,
        range: { unit: "line", total: 1, requested: [1, PAGE], returned: [1, 1] },
        packetRange: "1 line",
    },
]) test(`{§exec-stream} {§packet}: automatic ${specimen.name} arrives as its first page; explicit READ <1,-1> retains the full stream`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const { content } = specimen;
    const provider = new StreamMock({ contextWindow: 100_000, responses: [
        makeMockResponse(`\`\`\`\`js
process.stdout.write(${JSON.stringify(content)});
\`\`\`\`
\`\`\`\`WAIT
waiting
\`\`\`\``, 10),
        makeMockResponse("````READ ($STREAM#stdout) <1,-1>````\n````NOTE\nRead the full result.\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "long-stream-preview" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect the result." });
            assert.equal(finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnIds![2] }))!.packet);
            const delivery = logEntries(packet).find((row) => row.terminal === true && String(row.path).endsWith("#stdout"));
            assert.ok(delivery, "the model receives the automatic terminal observation");
            assert.equal(delivery.range, specimen.packetRange);
            assert.equal(delivery.region, undefined);
            assert.match(String(delivery.body), new RegExp(`${specimen.pageLines}:`), "the packet carries the page, line-numbered");
            assert.doesNotMatch(String(delivery.body), new RegExp(`${specimen.pageLines + 1}:`), "and nothing past it");
            const delivered = await db.test_log_entries_by_turn.all<{ origin: string; op: string; rx: string }>({ turn_id: turnIds![2] });
            const automatic = delivered.find((row) => row.origin === "_plurnk" && row.op === "READ" && JSON.parse(row.rx).content === specimen.page);
            assert.ok(automatic, "the page is what was delivered and stored");
            assert.deepEqual(JSON.parse(automatic.rx).range, specimen.range, "the durable range keeps requested and returned coordinates");
            const rows = await db.test_log_entries_by_turn.all<{ origin: string; op: string; rx: string }>({ turn_id: turnIds![2] });
            const explicit = rows.find((row) => row.origin === "model" && row.op === "READ");
            assert.equal(JSON.parse(explicit?.rx ?? "null")?.content, content, "the full source remains available on deliberate READ");
        } finally {
            ws.close();
        }
    }));
});
});

describe("find-over-stream", () => {
// {§exec-stream} — a FIND over an exec stream's channel resolves the runtime's own default channel
// (stdout), never the entry-manifest fallback `body`; it answers with the match, not a 500.





test("{§exec-stream} FIND over an exec stream channel answers the match instead of throwing on the default channel", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new StreamMock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nprintf 'alpha\\nbeta\\n'\n````\n\n````WAIT\nwaiting\n````", 10),
        makeMockResponse("````FIND ($STREAM#stdout) /beta/````\n\n````NOTE\nlooking\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "find-over-stream" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const find = rows.find((r) => r.op === "FIND" && r.origin === "model");
            assert.ok(find, "the model's FIND was dispatched");
            assert.equal(find.status_rx, 200, `FIND over the stream channel answers 200, got ${find.status_rx}: ${find.rx.slice(0, 200)}`);
            assert.match(find.rx, /"matched":"beta"/, "the regex row carries its match");
            assert.equal(finalStatus, 200);
        } finally { ws.close(); }
    });
});
});

describe("mcp-receipt-recovery", () => {
// {§exec-stream} {§exec-stream} — the complete MCP transport →
// execution → invocation receipt → automatic observation → explicit recovery path.
for (const body of [null, '{"query":"fixture"}']) {
    test(`{§exec-stream} MCP ${body === null ? "bodyless" : "one-line JSON"} invocation and output retain distinct readable extents`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
        const output = Array.from({ length: 40 }, (_, index) => `result ${index + 1}`).join("\n");
        let calls = 0;
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "receipt-fixture", version: "1.0.0" });
            server.registerTool("inspect", {
                description: "Return forty result lines.",
                inputSchema: fromJsonSchema({ type: "object", properties: { query: { type: "string" } }, additionalProperties: false }),
            }, async (args) => {
                calls += 1;
                assert.deepEqual(args, body === null ? {} : JSON.parse(body));
                return { content: [{ type: "text", text: output }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
        const frame = PlurnkParser.frame;
        const provider = new StreamMock({ contextWindow: 100_000, responses: [
            frame("fixture (inspect)", body),
            frame("READ ($INVOCATION) <17,40>", null),
            frame("READ ($STREAM) <17,40>", null),
            frame("SEND [200]", "The output's tail is result 40."),
        ].map((content) => ({ assistant: { content, reasoning: null } })) });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, hostPaths });
        daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        } }), "@plurnk/plurnk-mcp");
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const ws = await connect({ daemon });
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: "mcp-receipt-recovery" });
        const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect the tool result." });
        assert.equal(result.finalStatus, 200);
        assert.equal(calls, 1, "READs retrieve retained output without repeating the MCP tool call");
        const packet = async (index: number) => {
            const stored = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds![index] });
            assert.ok(stored);
            return logEntries(JSON.parse(stored.packet));
        };
        const observed = await packet(2);
        const invocation = observed.find((row) => row.logPath.endsWith("/fixture"));
        assert.ok(invocation);
        assert.equal(invocation.lines, undefined);
        assert.equal(invocation.path, "inspect", "the receipt names the invoked tool, as its paired operation does");
        assert.ok(provider.received[1].some((message) => message.role === "assistant" && chatMessageText(message) === frame("fixture (inspect)", body)),
            "the complete invocation remains distinct from its output");
        const automatic = observed.find((row) => row.path === invocation.stream && row.logPath.endsWith("/READ"));
        assert.ok(automatic);
        assert.equal(automatic.source, undefined);
        assert.equal(automatic.stream, undefined);
        assert.equal(automatic.range, "40 lines", "the automatic observation is a markerless READ: whole, because it fits ({§tokenomics})");
        const failed = (await packet(3)).find((row) => /^log:\/\/\/1\/3\/\d+\/READ$/u.test(row.logPath) && row.status === 416);
        assert.ok(failed);
        assert.ok(provider.received[2].some((message) => message.role === "assistant" && chatMessageText(message) === frame(`READ (${invocation.logPath}) <17,40>`, null)));
        assert.equal((failed.problem as { range: { total: number } }).range.total, body === null ? 0 : 1);
        if (body === null) assert.equal((failed.problem as { stream: string }).stream, invocation.stream);
        const explicit = (await packet(4)).find((row) => /^log:\/\/\/1\/4\/\d+\/READ$/u.test(row.logPath) && row.origin === undefined);
        assert.ok(explicit, "the actual MCP output is read at the address advertised in the packet");
        assert.ok(provider.received[3].some((message) => message.role === "assistant" && chatMessageText(message) === frame(`READ (${String(invocation.stream)}) <17,40>`, null)));
        assert.equal(explicit.terminal, true, "MCP's JSON channel declaration does not hide its lifecycle");
        assert.equal(explicit.range, "<17,40> of 40 lines");
        assert.match(String(explicit.body), /40:result 40\n$/u);
    });
}
});

describe("stream-channel-deletion", () => {
// {§exec-stream} (#1209): a request whose response leaves no readable projection deletes the `readable`
// channel its subscription seeded; the loop that sent it still concludes in its reply's turn.










const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });

// Text responses keep the seeded `readable`; a binary response without a projection drops it ({§channel-selection}).
const RESPONSES: ReadonlyArray<{ readonly label: string; readonly status: number; readonly body: string | Uint8Array<ArrayBuffer> | null; readonly type: string | null }> = [
    { label: "an empty JSON 401", status: 401, body: "", type: "application/json" },
    { label: "a 204 without a body", status: 204, body: null, type: "application/json" },
    { label: "plain text", status: 200, body: "accepted", type: "text/plain" },
    { label: "JSON", status: 200, body: "{\"ok\":true}", type: "application/json" },
    { label: "an empty 401 without a content type", status: 401, body: new Uint8Array(0), type: null },
    { label: "unreadable bytes", status: 200, body: new Uint8Array([0, 1, 2, 255]), type: "application/octet-stream" },
];

for (const shape of RESPONSES) {
    test(`{§exec-stream} {§loop-completion} a request answered with ${shape.label} concludes its loop in the reply's turn`, async (t) => {
        serverProposals(t, "accept");
        t.mock.method(globalThis, "fetch", async () => new Response(shape.body, { status: shape.status, headers: shape.type === null ? {} : { "content-type": shape.type } }));
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `stream-channel-deletion-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "probe");
        const loopId = await insertLoop(db, sessionId, 1);
        const schemes = new SchemeRegistry();
        schemes.register("https", new Http());
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        await engine.injectIntoLoop(loopId, "Probe the endpoint.", [], "acp://operator/threads/probe/messages/question");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response(frame("SEND (https://93.184.216.34/mcp)", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}")),
            response(frame("SEND [200]", "Probed.")),
            response(frame("NOTE", "Nothing remains.")),
            response(frame("NOTE", "Nothing remains.")),
        ] });
        const statuses: number[] = [];
        while (statuses.length < 4 && ![200, 499].includes(statuses.at(-1) ?? 0)) {
            statuses.push((await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] })).status);
        }
        assert.deepEqual(statuses, [102, 200], "the request's turn continues; the reply's turn, with the response observed, concludes");
    });
}
});

describe("stream-liveness", () => {
// {§exec-stream} — a READ of a stream channel says whether the stream has concluded, so an empty
// page on a live command is never mistaken for a finished command that printed nothing.












test("{§exec-stream}: a stream READ carries terminal: false while the command runs and terminal: true once it concluded", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, turnId } = await seedEnvelope(db, `stream-liveness-${crypto.randomUUID()}`, { producer: "client" });
        const seed = async (pathname: string, content: string, close: boolean): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname, channel: "stdout", content, mimetype: "text/stream", state: "active" });
            const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sh", handle: `sh: ${pathname}` });
            if (close) await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200, exitCode: 0 } });
        };
        await seed("/1/1/1/sh", "", false);
        await seed("/1/1/2/sh", "all done\n", true);
        const schemes = new SchemeRegistry();
        const executors = await testExecutors();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        let sequence = 0;
        const read = (pathname: string) => engine.dispatch({ statement: readStmt(urlPath("sh", pathname), { marks: [1, -1] }), workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "client" });
        const live = await read("/1/1/1/sh");
        assert.equal(live.status, 204, JSON.stringify(live));
        assert.equal(live.terminal, false, "an empty page on a live stream says the stream is still running");
        const done = await read("/1/1/2/sh");
        assert.equal(done.status, 200, JSON.stringify(done));
        assert.equal(done.terminal, true, "a concluded stream says so on every READ");
        assert.equal(done.content, "all done");
        const packets = new PacketBuilder({ db, schemes, executors: () => executors });
        const packet = await packets.buildRequestPacket({
            workspaceId, sessionId, loopId, currentTurnSeq: 2,
            provider: new Mock({ contextWindow: 100_000, responses: [] }),
            initialMessages: [], gitStatus: null,
        });
        const rows = logEntries(packet);
        const liveRow = rows.find((row) => row.path === "sh:///1/1/1/sh");
        const doneRow = rows.find((row) => row.path === "sh:///1/1/2/sh");
        assert.ok(liveRow, "the dispatched live READ reaches the assembled packet");
        assert.ok(doneRow, "the dispatched completed READ reaches the assembled packet");
        assert.equal(liveRow.terminal, false, "the packet preserves the empty stream's active state");
        assert.equal(liveRow.exitCode, undefined, "an active stream has no invented exit code");
        assert.equal(doneRow.terminal, true, "the packet preserves the completed stream's state");
        assert.equal(doneRow.exitCode, 0, "the packet preserves the completed stream's exact exit code");
    } finally { await db.close(); }
});
});
