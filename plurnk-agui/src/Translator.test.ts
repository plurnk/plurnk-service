import test from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
// AG-UI 1.0 ships its runtime validators on the schemas subpath; the root export is types only.
import {
    MessagesSnapshotEventSchema,
    RunErrorEventSchema,
    RunFinishedEventSchema,
    ReasoningEndEventSchema,
    ReasoningMessageContentEventSchema,
    ReasoningMessageEndEventSchema,
    ReasoningMessageStartEventSchema,
    ReasoningStartEventSchema,
} from "@ag-ui/core/schemas";
import Translator from "./Translator.ts";
import type { AguiEvent, LogEntryNotification, TerminatedNotification } from "./types.ts";
import { loopUsage } from "../test/accounting-fixture.ts";
import { wireRow } from "../test/log-fixture.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

// One authored operation, parsed as the service parses it.
const authored = (source: string): Record<string, unknown> => {
    const item = PlurnkParser.parseStatements(source).items[0];
    if (item?.kind !== "statement") throw new Error(`no statement in ${source}`);
    return item.statement as unknown as Record<string, unknown>;
};

const t = (): Translator => new Translator({ threadId: "th-1", runId: "run-1" });
const entry = (over: Partial<LogEntryNotification["entry"]>): LogEntryNotification => {
    const tx = over.op === "SEND" && typeof over.tx === "string" ? JSON.parse(over.tx) : over.tx;
    const rx = over.op === "SEND" && (tx as { target?: unknown } | undefined)?.target == null ? { answers: ["agui://anonymous/threads/th-1/messages/m1"] } : { status: 200 };
    return { entry: wireRow({ id: 7, sequence: 3, tx: { target: null, body: { raw: "message" } }, rx, ...over }) };
};

// What a snapshot's messages say, without the row facts their metadata carries ({§agui-plurnk-metadata}).
const said = <T extends object>(messages: readonly T[]): Array<Omit<T, "metadata">> =>
    messages.map((message) => { const { metadata: _metadata, ...rest } = message as T & { metadata?: unknown }; return rest; });

// What a reader sees of a snapshot: its speech, and its operations as their calls.
type Replayed = { role: string; content?: unknown; toolCalls?: ReadonlyArray<{ id: string; function: { name: string } }> };
const speech = (messages: readonly Replayed[]): unknown[] =>
    messages.filter(({ role, content }) => role === "assistant" && typeof content === "string").map(({ content }) => content);
const calls = (messages: readonly Replayed[]): Array<[string, string]> =>
    messages.flatMap(({ toolCalls }) => (toolCalls ?? []).map((call): [string, string] => [call.id, call.function.name]));

test("{§agui-replay} successful replies to the thread are assistant responses in live and replay", () => {
    const tr = t();
    const messages = [
        entry({ id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", status_rx: 200, tx: { target: null, body: { raw: "First." } } }),
        entry({ id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "SEND", status_rx: 200, tx: { target: { kind: "url", raw: "worker://child" }, body: { raw: "Private instructions." } } }),
        entry({ id: 3, loop_seq: 1, turn_seq: 1, sequence: 3, op: "SEND", status_rx: 400, tx: { target: null, body: { raw: "Unsent." } }, rx: { status: 400 } }),
        entry({ id: 4, loop_seq: 1, turn_seq: 1, sequence: 4, op: "SEND", status_rx: 200, tx: { target: null, body: { raw: "Second." } } }),
        entry({ id: 5, loop_seq: 1, turn_seq: 1, sequence: 5, op: "WAIT", status_rx: 200, tx: { body: [{ content: "Answer delivered.", status: "completed" }] } }),
    ];
    const live = messages.flatMap((message) => tr.logEntry(message));
    assert.deepEqual(live.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta), ["First.", "Second."]);
    const [snapshot] = tr.replay(messages.map(({ entry }) => entry));
    assert.equal(snapshot.type, EventType.MESSAGES_SNAPSHOT);
    if (snapshot.type !== EventType.MESSAGES_SNAPSHOT) throw new Error("missing snapshot");
    assert.deepEqual(speech(snapshot.messages), ["First.", "Second."]);
    assert.ok(live.some((event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === "1/1/2"), "directed messages remain real operations, not missing events");
    assert.deepEqual(calls(snapshot.messages), [["1/1/2", "SEND"], ["1/1/3", "SEND"], ["1/1/5", "WAIT"]], "and replay as the operations they were live, a bodiless WAIT among them");
});

test("{§agui-replay} a SEND without a delivered recipient is an operation in live and replay", () => {
    const message = entry({ op: "SEND", rx: { answers: [] }, tx: { body: "Unaddressed text." } });
    const translator = t();
    const live = translator.logEntry(message);
    assert.equal(live.some(({ type }) => type === EventType.TEXT_MESSAGE_CONTENT), false);
    assert.ok(live.some(({ type }) => type === EventType.TOOL_CALL_RESULT));
    const [snapshot] = translator.replay([message.entry]);
    assert.equal(snapshot.type, EventType.MESSAGES_SNAPSHOT);
    if (snapshot.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(speech(snapshot.messages), []);
    assert.deepEqual(calls(snapshot.messages), [["1/1/3", "SEND"]]);
    assert.ok(snapshot.messages.some((replayed) => replayed.role === "tool" && replayed.toolCallId === "1/1/3"), "its receipt replays as the call's result");
});

test("a model op row is a TOOL_CALL triple with its rx as the RESULT", () => {
    const tr = t();
    tr.logEntry(entry({ op: "WAIT", tx: JSON.stringify({ body: "orient" }) })); // consume the turn boundary
    const events = tr.logEntry(entry({ op: "READ", scheme: "worker", pathname: "/notes.md", tx: authored("````READ (worker:///notes.md)\n````"), rx: JSON.stringify({ status: 200, content: "hi" }), status_rx: 200 }));
    assert.deepEqual(events.map((e) => e.type), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"], "the row is its call and receipt, nothing beside them");
    const start = events[0] as { toolCallId: string; toolCallName: string };
    assert.equal(start.toolCallId, "1/1/3", "the coordinate IS the toolCallId");
    assert.equal(start.toolCallName, "READ");
    const args = events[1] as { delta: string };
    assert.equal(JSON.parse(args.delta).target.raw, "worker:///notes.md", "the target rides the args");
});

test("{§agui-call-result} {§methods-invocation} a started execution is answered by its stream's observations, live and on replay", () => {
    const command = authored("````sh\nprintf 'hi\\n'; printf 'warn\\n' >&2\n````");
    const rows = [
        entry({ id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "sh", tx: command, attrs: { stream: "sh:///ab3d5678" }, rx: { status: 200, outcome: "started" } }),
        entry({ id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "NOTE", tx: authored("````NOTE\nrunning\n````"), rx: { status: 200 } }),
        entry({ id: 3, loop_seq: 1, turn_seq: 1, sequence: 3, op: "sh", tx: command, attrs: { stream: "sh:///c0ffee00" }, status_rx: 404,
            rx: { status: 404, problem: { type: "https://problems.plurnk.xyz/scheme/exec/source", title: "Source", status: 404, detail: "No source." } } }),
        entry({ id: 4, loop_seq: 1, turn_seq: 2, sequence: 1, turn_id: 2, origin: "_plurnk", op: "READ", tx: null, scheme: "sh", pathname: "/ab3d5678",
            fragment: "stdout", invocation: "log:///1/1/1/sh", rx: { status: 200, exitCode: 0, terminal: true, content: "hi\n" } }),
        entry({ id: 5, loop_seq: 1, turn_seq: 2, sequence: 2, turn_id: 2, origin: "_plurnk", op: "READ", tx: null, scheme: "sh", pathname: "/ab3d5678",
            fragment: "stderr", invocation: "log:///1/1/1/sh", rx: { status: 200, terminal: true, content: "warn\n" } }),
    ];
    const tr = t();
    const live = rows.flatMap((row) => tr.logEntry(row));
    const results = live.filter((event) => event.type === EventType.TOOL_CALL_RESULT) as Array<{ toolCallId: string; messageId: string; content: string }>;
    assert.deepEqual(results.map(({ toolCallId, messageId }) => [toolCallId, messageId]),
        [["1/1/2", "1/1/2/result"], ["1/1/3", "1/1/3/result"], ["1/1/1", "1/2/1"], ["1/1/1", "1/2/2"]],
        "the started command's receipt is no result; each observation answers it under its own coordinate, and a failed command's receipt is its result");
    assert.equal(JSON.parse(results[2].content).content, "hi\n", "the observation carries the output");
    assert.ok(!live.some((event) => event.type === EventType.CUSTOM && event.name === "plurnk.ambient"), "an observation that answers a call is not ambient");

    const [snapshot] = tr.replay(rows.map(({ entry: row }) => row));
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(snapshot.messages.map((message) => [message.id, message.role, "toolCallId" in message ? message.toolCallId : undefined]), [
        ["1/1/1", "assistant", undefined], ["1/2/1", "tool", "1/1/1"], ["1/2/2", "tool", "1/1/1"],
        ["1/1/2", "assistant", undefined], ["1/1/2/result", "tool", "1/1/2"],
        ["1/1/3", "assistant", undefined], ["1/1/3/result", "tool", "1/1/3"],
    ], "each result sits after its call, where the official reducer puts one that arrives live");
    assert.throws(() => t().logEntry(entry({ origin: "_plurnk", op: "READ", invocation: "sh:///ab3d5678" })), /log address/u,
        "an observation names its execution by log address");
});

test("{§agui-call-result} {§worker-obligations} {§agui-progress-reply} a delegation and a message are answered by what discharges them, and progress is a message from its source", () => {
    const rows = [
        entry({ id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "WORK", tx: authored("````WORK (worker://helper)\nSay hello.\n````"),
            attrs: { worker: "worker://helper", message: "message://helper/ab12" }, rx: { status: 200, body: "helper" } }),
        entry({ id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "SEND", tx: authored("````SEND (worker://peer)\nWhat is the answer?\n````"),
            attrs: { message: "message://peer/cd34" }, rx: { status: 200 } }),
        entry({ id: 3, loop_seq: 1, turn_seq: 2, sequence: 1, turn_id: 2, origin: "_plurnk", op: "SEND", source: "worker://peer", attrs: { kind: "reply" },
            answering: "log:///1/1/2/SEND", tx: { target: null, body: { raw: "Still looking." } }, rx: { status: 200, answers: ["message://peer/cd34"] } }),
        entry({ id: 4, loop_seq: 1, turn_seq: 2, sequence: 2, turn_id: 2, origin: "_plurnk", op: "READ", source: "worker://helper", tx: null,
            attrs: { kind: "loop_termination" }, invocation: "log:///1/1/1/WORK", rx: { status: 200, resource: "ops://helper/1", content: "hello" } }),
        entry({ id: 5, loop_seq: 1, turn_seq: 2, sequence: 3, turn_id: 2, origin: "_plurnk", op: "SEND", source: "worker://peer", attrs: { kind: "reply" },
            invocation: "log:///1/1/2/SEND", tx: { target: null, body: { raw: "forty-two" } }, rx: { status: 200, answers: ["message://peer/cd34"], completion: 200 } }),
    ];
    const tr = t();
    const live = rows.flatMap((row) => tr.logEntry(row));
    assert.deepEqual(live.filter((event) => event.type === EventType.TOOL_CALL_RESULT).map((event) => [event.toolCallId, event.messageId, event.content]),
        [["1/1/1", "1/2/2", JSON.stringify({ status: 200, resource: "ops://helper/1", content: "hello" })], ["1/1/2", "1/2/3", "forty-two"]],
        "neither receipt is a result; the child's conclusion answers the WORK and the reply's words the SEND");
    assert.deepEqual(live.filter((event) => event.type === EventType.TEXT_MESSAGE_START).map((event) => [event.messageId, event.role, event.name]),
        [["1/2/1", "user", "worker://peer"]], "a progress reply is a message from the peer that reported it");
    const stray = t().logEntry(entry({ id: 6, loop_seq: 1, turn_seq: 2, sequence: 4, turn_id: 2, origin: "_plurnk", op: "SEND", source: "worker://peer",
        attrs: { kind: "reply" }, tx: { target: null, body: { raw: "To someone else." } }, rx: { status: 200, answers: ["agui://bob/threads/x/messages/m9"] } }));
    assert.deepEqual(stray.filter(({ type }) => type !== "STEP_STARTED").map((event) => event.type === EventType.CUSTOM ? event.name : event.type), ["plurnk.ambient"],
        "a reply to a message this worker did not send is no message of this thread");

    const [snapshot] = tr.replay(rows.map(({ entry: row }) => row));
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(snapshot.messages.map((message) => [message.id, message.role, "toolCallId" in message ? message.toolCallId : "name" in message ? message.name : undefined]), [
        ["1/1/1", "assistant", undefined], ["1/2/2", "tool", "1/1/1"],
        ["1/1/2", "assistant", undefined], ["1/2/3", "tool", "1/1/2"], ["1/2/1", "user", "worker://peer"],
    ], "replay answers each call beside it, and keeps the progress message");
});

test("{§agui-call-result} {§proposal-202-pauses} a gated call is answered by its own settlement, live and on replay", () => {
    const edit = (state: "proposed" | "resolved" | "cancelled", status: number) => entry({ id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "EDIT",
        tx: authored("````EDIT (notes.md)\nnew\n````"), pathname: "notes.md", attrs: { patch: "+new" }, status_rx: status, rx: { status }, state });
    const tr = t();
    const pending = tr.logEntry(edit("proposed", 202));
    assert.deepEqual(pending.filter(({ type }) => type.startsWith("TOOL_CALL")).map(({ type }) => type),
        [EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END], "awaiting its decision, the call has no result");
    assert.equal((pending.find(({ type }) => type === EventType.TOOL_CALL_START) as { metadata?: { plurnk?: { state?: string } } }).metadata?.plurnk?.state,
        "proposed", "its facts say it awaits its decision");
    for (const [state, status] of [["resolved", 200], ["cancelled", 499]] as const) {
        const settled = t().logEntry(edit(state, status));
        const [result] = settled.filter(({ type }) => type === EventType.TOOL_CALL_RESULT) as Array<{ toolCallId: string; content: string }>;
        assert.deepEqual([result?.toolCallId, JSON.parse(result?.content ?? "null")], ["1/1/1", { status }], `${state}, its receipt answers its call`);
    }
    for (const [state, status, answered] of [["proposed", 202, false], ["resolved", 200, true]] as const) {
        const [snapshot] = t().replay([edit(state, status).entry]);
        if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
        assert.deepEqual(snapshot.messages.map(({ id, role }) => [id, role]), answered ? [["1/1/1", "assistant"], ["1/1/1/result", "tool"]] : [["1/1/1", "assistant"]],
            answered ? "settled, the snapshot holds the call and its receipt" : "pending, the snapshot holds the call alone");
    }
});

test("{§agui-subagents} {§agui-snapshot} a subagent's conversation is its own: attributed to its run and identified in its worker's namespace, live and in one replay with its delegator's", () => {
    const helper = new Translator({ threadId: "th-1", runId: "run-1", modelWorkerId: 20, subagent: { runId: "ops://helper/1", worker: "helper" } });
    const own = [
        wireRow({ id: 1, op: "WORK", tx: authored("````WORK (worker://helper)\nSay hello.\n````"), attrs: { worker: "worker://helper", message: "message://helper/ab12" } }),
        wireRow({ id: 5, turn_id: 2, turn_seq: 2, sequence: 1, origin: "_plurnk", op: "READ", source: "worker://helper", attrs: { kind: "loop_termination" },
            invocation: "log:///1/1/1/WORK", rx: { status: 200, resource: "ops://helper/1", content: "hello" } }),
    ];
    const delegated = [
        wireRow({ id: 2, worker_id: 20, loop_id: 9, turn_id: 7, sequence: 1, origin: "_plurnk", op: "SEND", source: "worker://main", attrs: { kind: "message" }, tx: { body: { raw: "Say hello." } } }),
        wireRow({ id: 3, worker_id: 20, loop_id: 9, turn_id: 8, turn_seq: 2, sequence: 1, op: "sh", tx: authored("````sh\nprintf 'hello'\n````"),
            attrs: { stream: "sh:///ab3d5678" }, rx: { status: 200, outcome: "started" } }),
        wireRow({ id: 4, worker_id: 20, loop_id: 9, turn_id: 8, turn_seq: 2, sequence: 2, origin: "_plurnk", op: "READ", scheme: "sh", pathname: "/ab3d5678",
            fragment: "stdout", invocation: "log:///1/2/1/sh", rx: { status: 200, exitCode: 0, terminal: true, content: "hello" } }),
    ];
    const live = delegated.flatMap((row) => helper.logEntry({ entry: row }));
    assert.ok(live.length > 0 && live.every((event) => (event as { subagentRunId?: string }).subagentRunId === "ops://helper/1"),
        "every event of the delegation, its metadata included, belongs to its run");
    assert.deepEqual(live.filter((event) => event.type === EventType.TEXT_MESSAGE_START).map((event) => [event.messageId, event.role, event.name]),
        [["worker://helper#1/1/1", "user", "worker://main"]], "its task arrives from its delegator, identified in its own namespace");
    assert.deepEqual(live.filter((event) => event.type === EventType.TOOL_CALL_RESULT).map((event) => [event.toolCallId, event.messageId]),
        [["worker://helper#1/2/1", "worker://helper#1/2/2"]], "its command is answered by its own observation, in its own namespace");
    assert.deepEqual(helper.finish().map((event) => [event.type, (event as { subagentRunId?: string }).subagentRunId]), [[EventType.STEP_FINISHED, "ops://helper/1"]],
        "its step closes in its own lane");

    const [snapshot] = Translator.replayAll([{ translator: t(), entries: own }, { translator: helper, entries: delegated }]);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(snapshot.messages.map((message) => [message.id, message.role, (message as { subagentRunId?: string }).subagentRunId]), [
        ["1/1/1", "assistant", undefined], ["1/2/1", "tool", undefined],
        ["worker://helper#1/1/1", "user", "ops://helper/1"],
        ["worker://helper#1/2/1", "assistant", "ops://helper/1"], ["worker://helper#1/2/2", "tool", "ops://helper/1"],
    ], "two logs are one conversation in the order the workspace committed them, each result beside its call");
});

// {§agui-projection} The arguments are the operation as authored: every operand exactly as parsed, without the verb
// that is the tool's name or the position it was written at.
test("{§agui-projection} a tool call's arguments carry every authored operand: host, scope, pattern, aside and both COPY operands", () => {
    for (const [source, check] of [
        ["````READ (worker://user/identity.md) <1,2> /cobalt/ <!-- selected evidence -->\n````", (args: Record<string, unknown>) => {
            assert.equal((args.target as { raw: string }).raw, "worker://user/identity.md", "the host addresses the resource");
            assert.notEqual(args.lineMarker, null, "the scope survives");
            assert.notEqual(args.matcher, null, "the pattern survives");
            assert.equal(args.aside, "selected evidence");
        }],
        ["````COPY (a.txt) <1,2> (worker:///b.md)\n````", (args: Record<string, unknown>) => {
            assert.equal((args.source as { target: { raw: string } }).target.raw, "a.txt");
            assert.equal((args.destination as { target: { raw: string } }).target.raw, "worker:///b.md", "the destination survives");
        }],
    ] as const) {
        const statement = authored(source);
        const row = entry({ op: statement.op as string, tx: statement });
        const live = t().logEntry(row).find((event) => event.type === EventType.TOOL_CALL_ARGS) as { delta: string } | undefined;
        assert.ok(live, source);
        const { op: _op, position: _position, ...operands } = statement;
        assert.deepEqual(JSON.parse(live.delta), operands, `the live arguments are the statement: ${source}`);
        check(JSON.parse(live.delta) as Record<string, unknown>);
        const replayed = (t().replay([row.entry])[0] as { messages: Array<{ toolCalls?: Array<{ function: { arguments: string } }> }> })
            .messages.flatMap(({ toolCalls }) => toolCalls ?? []);
        assert.deepEqual(replayed.map(({ function: call }) => JSON.parse(call.arguments)), [operands], `replay carries the same arguments: ${source}`);
    }
});

test("{§message-completion}: delivered completion replies enter live and replay messages, independent of their outcome", () => {
    const messages = [
        entry({ id: 11, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", status_rx: 400,
            tx: { target: null, body: { raw: "Undelivered." } }, rx: { status: 400 } }),
        entry({ id: 12, loop_seq: 1, turn_seq: 2, sequence: 1, op: "SEND", status_rx: 200,
            tx: { target: null, body: { raw: "Cancelled this request." } }, rx: { status: 200, completion: 499, answers: ["agui://anonymous/threads/th-1/messages/m1"] } }),
        entry({ id: 13, loop_seq: 1, turn_seq: 3, sequence: 1, op: "SEND", status_rx: 200,
            tx: { target: null, body: { raw: "The answer is **42**." } }, rx: { status: 200, completion: 200, answers: ["agui://anonymous/threads/th-1/messages/m1"] } }),
        entry({ id: 14, loop_seq: 1, turn_seq: 4, sequence: 1, op: "SEND", status_rx: 200,
            tx: { target: null, body: null }, rx: { status: 200, completion: 200, answers: ["agui://anonymous/threads/th-1/messages/m1"] } }),
        entry({ id: 15, loop_seq: 1, turn_seq: 5, sequence: 1, op: "SEND", status_rx: 200,
            tx: { target: null, body: { raw: " \n\t" } }, rx: { status: 200, completion: 200, answers: ["agui://anonymous/threads/th-1/messages/m1"] } }),
    ];
    const tr = t();
    const live = messages.flatMap((message) => tr.logEntry(message));
    assert.deepEqual(live.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta), ["Cancelled this request.", "The answer is **42**."]);
    const [snapshot] = tr.replay(messages.map(({ entry }) => entry));
    assert.equal(snapshot.type, EventType.MESSAGES_SNAPSHOT);
    if (snapshot.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(speech(snapshot.messages), ["Cancelled this request.", "The answer is **42**."]);
});

test("{§agui-projection} a WAIT body is the model's speech to the user; a bodiless WAIT is an operation and speaks nothing", () => {
    const tr = t();
    const events = tr.logEntry(entry({ op: "WAIT", loop_seq: 1, turn_seq: 1, sequence: 3, tx: { body: "Pilot at 12 of 30, 9 passes; next read in ten minutes." } }));
    assert.deepEqual(events.map((e) => e.type), ["STEP_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    assert.equal((events[2] as { delta: string }).delta, "Pilot at 12 of 30, 9 passes; next read in ten minutes.", "the body is delivered as it was written");
    const silent = tr.logEntry(entry({ op: "WAIT", loop_seq: 1, turn_seq: 2, sequence: 3, turn_id: 2, tx: { body: null } }));
    assert.deepEqual(silent.filter((e) => e.type !== "STEP_FINISHED" && e.type !== "STEP_STARTED").map((e) => e.type),
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"], "no body, no speech: the WAIT and its receipt");
    assert.equal((silent.find((e) => e.type === "TOOL_CALL_START") as { toolCallName?: string } | undefined)?.toolCallName, "WAIT");
    const send = tr.logEntry(entry({ op: "SEND", signal: 200, status_rx: 200, tx: JSON.stringify({ body: "done and dusted" }) }));
    assert.deepEqual(send.map((e) => e.type), ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    assert.equal((send[0] as { metadata?: { plurnk?: { signal?: unknown } } }).metadata?.plurnk?.signal, 200,
        "{§agui-plurnk-metadata} the signal rides the speech's metadata, never lost, never masquerading");
});

test("{§agui-lifecycle-projection} NOTE remains literal in its call; no task inventory is invented", () => {
    const tr = t();
    const native = "Verify the root lockfile.\nRun the focused tests.";
    const events = tr.logEntry(entry({ op: "NOTE", tx: { body: native } }));
    const args = events.find((event) => event.type === "TOOL_CALL_ARGS") as { delta?: string } | undefined;
    assert.equal(JSON.parse(args?.delta ?? "{}").body, native, "the call's arguments carry the body as written");
    assert.equal(events.find((event) => event.type === "ACTIVITY_SNAPSHOT"), undefined);
    assert.ok(events.some((event) => event.type === "TOOL_CALL_START" && event.toolCallName === "NOTE"));
    assert.ok(!events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
    const ambient = tr.logEntry(entry({ op: "NOTE", origin: "_plurnk", tx: { body: native } }));
    assert.deepEqual(ambient.map((event) => event.type === "CUSTOM" ? event.name : event.type), ["plurnk.ambient"], "{§agui-ambient} a harness note rides whole");
    assert.equal((ambient[0] as { value?: { tx?: { body?: unknown } } }).value?.tx?.body, native);
});

test("{§agui-projection} addressed replies project by thread, including answers delivered by another worker", () => {
    for (const origin of ["model", "client", "_plurnk"] as const) for (const thread of ["th-1", "another-thread"]) {
        const native = "Verification.";
        const address = `agui://anonymous/threads/${thread}/messages/user-message`;
        const record = entry({ id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", origin,
            source: origin === "_plurnk" ? "worker://peer" : null,
            attrs: origin === "_plurnk" ? { kind: "reply" } : {},
            tx: { target: { raw: address }, body: { raw: native } }, status_rx: 200, rx: { answers: [address] } });
        const events = t().logEntry(record);
        const expected = thread === "th-1" ? [native] : [];
        assert.deepEqual(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta), expected);
        // A reply to another thread is no speech here: the model's is its call, carrying its words; another's rides whole.
        const operation = events.find((event) => event.type === "TOOL_CALL_ARGS") as { delta?: string } | undefined;
        const whole = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.ambient") as { value?: { tx: { body: { raw: string } } } } | undefined;
        if (thread !== "th-1") assert.equal(origin === "model" ? JSON.parse(operation?.delta ?? "{}").body?.raw : whole?.value?.tx.body.raw, native);
        const [snapshot] = t().replay([record.entry]);
        assert.equal(snapshot.type, "MESSAGES_SNAPSHOT");
        if (snapshot.type === "MESSAGES_SNAPSHOT") assert.deepEqual(speech(snapshot.messages), expected);
    }
});

test("{§agui-replay} an arrival retains the AG-UI message id across reconnects", () => {
    const source = "agui://anonymous/threads/th-1/messages/user%20one";
    const record = entry({ op: "SEND", origin: "_plurnk", source, attrs: { kind: "message" },
        tx: { body: { raw: "Question." } }, rx: { status: 200 }, loop_seq: 1, turn_seq: 1, sequence: 1 });
    const [snapshot] = t().replay([record.entry]);
    assert.equal(snapshot.type, "MESSAGES_SNAPSHOT");
    if (snapshot.type === "MESSAGES_SNAPSHOT") assert.deepEqual(said(snapshot.messages), [{ id: "user one", role: "user", content: "Question." }],
        "a thread client's message replays as that client sent it");
});

test("readable provider reasoning precedes SEND speech on the standard AG-UI channel", () => {
    const tr = t();
    const events = tr.logEntry(entry({
        op: "SEND",
        loop_seq: 1, turn_seq: 1, sequence: 8,
        tx: { body: "answer" },
        reasoning: "checked the evidence",
    }));
    assert.deepEqual(events.map((event) => event.type), [
        "STEP_STARTED",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
    ], "reasoning precedes the words it led to");
    const reasoning = events.slice(1, 6);
    assert.deepEqual(reasoning, [
        { type: "REASONING_START", messageId: "1/1/8/reasoning" },
        { type: "REASONING_MESSAGE_START", messageId: "1/1/8/reasoning", role: "reasoning" },
        { type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/8/reasoning", delta: "checked the evidence" },
        { type: "REASONING_MESSAGE_END", messageId: "1/1/8/reasoning" },
        { type: "REASONING_END", messageId: "1/1/8/reasoning" },
    ]);
    assert.doesNotThrow(() => ReasoningStartEventSchema.parse(reasoning[0]));
    assert.doesNotThrow(() => ReasoningMessageStartEventSchema.parse(reasoning[1]));
    assert.doesNotThrow(() => ReasoningMessageContentEventSchema.parse(reasoning[2]));
    assert.doesNotThrow(() => ReasoningMessageEndEventSchema.parse(reasoning[3]));
    assert.doesNotThrow(() => ReasoningEndEventSchema.parse(reasoning[4]));
});

test("live provider reasoning projects ordered deltas before SEND without duplicating the durable value", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    const start = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "start" });
    const first = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "content", delta: "checked " });
    const second = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "content", delta: "the evidence" });
    const end = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "end" });
    assert.deepEqual(start, [
        { type: "STEP_STARTED", stepName: "turn-7" },
        { type: "REASONING_START", messageId: "model-call-11/request-1/reasoning" },
        { type: "REASONING_MESSAGE_START", messageId: "model-call-11/request-1/reasoning", role: "reasoning" },
    ]);
    assert.deepEqual(first, [{ type: "REASONING_MESSAGE_CONTENT", messageId: "model-call-11/request-1/reasoning", delta: "checked " }]);
    assert.deepEqual(second, [{ type: "REASONING_MESSAGE_CONTENT", messageId: "model-call-11/request-1/reasoning", delta: "the evidence" }]);
    assert.deepEqual(end, [
        { type: "REASONING_MESSAGE_END", messageId: "model-call-11/request-1/reasoning" },
        { type: "REASONING_END", messageId: "model-call-11/request-1/reasoning" },
    ]);

    const send = tr.logEntry(entry({
        op: "SEND",
        turn_id: 7,
        loop_seq: 1, turn_seq: 7, sequence: 3,
        tx: { body: "answer" },
        reasoning: "checked the evidence",
        ...( { worker_id: 2 } as object),
    }));
    assert.ok(!send.some((event) => event.type.startsWith("REASONING_")), "the matching durable projection is replay authority, not a second live message");
});

for (const origin of ["model", "_plurnk"] as const) {
    test(`{§agui-projection}: late ${origin} receipts do not rewind a streaming or resumed turn`, () => {
        let tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 10 });
        const prior = entry({ id: 6, turn_id: 6, loop_seq: 1, turn_seq: 6, sequence: 1, origin, status_rx: 102 });
        tr.logEntry(prior);
        tr.reasoning({ workerId: 10, loopId: 1, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "start" });
        const events = tr.reasoning({ workerId: 10, loopId: 1, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "content", delta: "checked the evidence" });
        const settled = entry({ ...prior.entry, status_rx: 200, rx: { status: 200, content: "late result" } });
        const late = tr.logEntry(settled);
        assert.ok(late.some((event) => event.type === "TOOL_CALL_RESULT" || (event.type === "CUSTOM" && event.name === "plurnk.ambient")), "the old receipt still reaches clients");
        assert.ok(!late.some(({ type }) => type.startsWith("STEP_")), "late completion does not change the current execution step");
        events.push(...tr.reasoning({ workerId: 10, loopId: 1, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "end" }));
        const interrupted = tr.interrupt();
        assert.equal(interrupted.continuation.currentTurn, 7);
        tr = new Translator({ threadId: "th", runId: "resumed", continuation: interrupted.continuation });
        assert.deepEqual(tr.runStarted().at(-1), { type: "STEP_STARTED", stepName: "turn-7" });
        events.push(...tr.logEntry(settled));
        events.push(...tr.logEntry(entry({ op: "WAIT", turn_id: 7, tx: { body: "recorded" }, reasoning: "checked the evidence" })));
        assert.equal(events.filter(({ type }) => type === "REASONING_MESSAGE_CONTENT").length, 1,
            "receipt updates preserve delivered reasoning across the interruption");
        assert.deepEqual(tr.finish(), [{ type: "STEP_FINISHED", stepName: "turn-7" }]);
    });
}

for (const streamed of [false, true]) {
    test(`{§agui-readable-reasoning}: SEND and WAIT share one reasoning projection across interrupts (streamed=${streamed})`, () => {
        let tr = new Translator({ threadId: "th-1", runId: "run", modelWorkerId: 10 });
        const rows = [
            entry({ id: 10, op: "SEND", status_rx: 200, turn_id: 7, loop_seq: 1, turn_seq: 7, sequence: 1, tx: { body: "progress" }, reasoning: "checked the evidence" }),
            entry({ id: 11, op: "SEND", status_rx: 200, turn_id: 7, loop_seq: 1, turn_seq: 7, sequence: 2, tx: { body: "answer" }, reasoning: "checked the evidence" }),
            entry({ id: 12, op: "WAIT", turn_id: 7, loop_seq: 1, turn_seq: 7, sequence: 3, tx: { body: "recorded" }, reasoning: "checked the evidence" }),
            entry({ id: 13, op: "SEND", status_rx: 200, turn_id: 8, loop_seq: 1, turn_seq: 8, sequence: 1, tx: { body: "done" }, reasoning: "checked the evidence" }),
        ];
        const events = streamed ? [
            ...tr.reasoning({ workerId: 10, loopId: 1, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "start" }),
            ...tr.reasoning({ workerId: 10, loopId: 1, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "content", delta: "checked the evidence" }),
            ...tr.reasoning({ workerId: 10, loopId: 1, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "end" }),
        ] : [];
        events.push(...tr.logEntry(rows[0]));
        tr = new Translator({ threadId: "th-1", runId: "resumed", continuation: tr.interrupt().continuation });
        for (const row of rows.slice(1)) events.push(...tr.logEntry(row));
        assert.equal(events.filter(({ type }) => type === "REASONING_MESSAGE_CONTENT").length, 2,
            "one reasoning value per turn, including when a later turn repeats the same text");
        assert.equal(events.filter(({ type }) => type === "TEXT_MESSAGE_CONTENT").length, 4, "three reply SENDs and the WAIT body: a WAIT that carries words speaks them ({§agui-projection})");
        assert.equal(events.filter(({ type }) => type === "ACTIVITY_SNAPSHOT").length, 0);
        const snapshot = tr.replay(rows.map(({ entry }) => entry)).find(({ type }) => type === "MESSAGES_SNAPSHOT");
        assert.ok(snapshot?.type === "MESSAGES_SNAPSHOT");
        assert.equal(snapshot.messages.filter(({ role }) => role === "reasoning").length, 2,
            "replay also projects the admitted reasoning once per turn");
    });
}

test("a retried physical request receives a separate reasoning message instead of splicing attempts", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    const emit = (requestSequence: number, phase: "start" | "end" | "content", delta?: string) => tr.reasoning({
        workerId: 2,
        loopId: 4,
        turnId: 7,
        modelCallId: 11,
        requestSequence,
        ...(phase === "content" ? { phase, delta: delta ?? "" } : { phase }),
    });

    const failed = [
        ...emit(1, "start"),
        ...emit(1, "content", "abandoned reasoning"),
        ...emit(1, "end"),
    ];
    const accepted = [
        ...emit(2, "start"),
        ...emit(2, "content", "accepted reasoning"),
        ...emit(2, "end"),
    ];

    assert.ok(failed.some((event) => "messageId" in event
        && event.messageId === "model-call-11/request-1/reasoning"));
    assert.ok(accepted.some((event) => "messageId" in event
        && event.messageId === "model-call-11/request-2/reasoning"));
    assert.ok(!accepted.some((event) => event.type === "REASONING_MESSAGE_CONTENT"
        && event.delta.includes("abandoned")), "the retry never appends to the failed request's reasoning message");

    const send = tr.logEntry(entry({
        op: "SEND",
        turn_id: 7,
        loop_seq: 1, turn_seq: 7, sequence: 3,
        reasoning: "accepted reasoning",
        ...( { worker_id: 2 } as object),
    }));
    assert.ok(!send.some((event) => event.type.startsWith("REASONING_")), "the accepted request's durable reasoning is not replayed");
});

test("a prior rejected stream cannot suppress different durable reasoning, and foreign worker streams stay out", () => {
    const tr = new Translator({ threadId: "th-1", runId: "run", modelWorkerId: 2 });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 10, requestSequence: 1, phase: "start" });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 10, requestSequence: 1, phase: "content", delta: "rejected reasoning" });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 10, requestSequence: 1, phase: "end" });
    assert.deepEqual(
        tr.reasoning({ workerId: 9, loopId: 12, turnId: 13, modelCallId: 14, requestSequence: 1, phase: "start" }),
        [],
    );
    const send = tr.logEntry(entry({
        op: "SEND",
        turn_id: 7,
        loop_seq: 1, turn_seq: 7, sequence: 3,
        reasoning: "accepted reasoning",
        ...( { worker_id: 2 } as object),
    }));
    const content = send.find((event) => event.type === "REASONING_MESSAGE_CONTENT") as { delta?: string } | undefined;
    assert.equal(content?.delta, "accepted reasoning");
});

test("{§agui-readable-reasoning} a Run that joins mid-request presents none of it and receives the durable reasoning once, with its row", () => {
    const tr = new Translator({ threadId: "th-1", runId: "run", modelWorkerId: 2 });
    assert.deepEqual(tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "content", delta: "tail" }), []);
    assert.deepEqual(tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "end" }), []);
    const send = tr.logEntry(entry({
        op: "SEND",
        turn_id: 7,
        loop_seq: 1, turn_seq: 7, sequence: 3,
        reasoning: "whole reasoning",
        ...( { worker_id: 2 } as object),
    }));
    assert.deepEqual(
        send.filter((event) => event.type === "REASONING_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta),
        ["whole reasoning"],
    );
});

test("reasoning lifecycle violations fail at the projection boundary", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "start" });
    assert.throws(
        () => tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, requestSequence: 1, phase: "start" }),
        /already started/,
    );
});

test("readable reasoning identity is turn-specific and absent evidence invents nothing", () => {
    const tr = t();
    const first = tr.logEntry(entry({ op: "SEND", turn_id: 1, loop_seq: 1, turn_seq: 1, sequence: 8, reasoning: "first" }));
    const second = tr.logEntry(entry({ op: "SEND", turn_id: 2, loop_seq: 1, turn_seq: 2, sequence: 4, reasoning: "second" }));
    const absent = tr.logEntry(entry({ op: "SEND", turn_id: 3, loop_seq: 1, turn_seq: 3, sequence: 2 }));
    assert.deepEqual(
        [first, second].map((events) => events.find((event) => event.type === "REASONING_START")),
        [
            { type: "REASONING_START", messageId: "1/1/8/reasoning" },
            { type: "REASONING_START", messageId: "1/2/4/reasoning" },
        ],
    );
    assert.ok(!absent.some((event) => event.type.startsWith("REASONING_")));
});

test("{§agui-ambient} ambient (origin _plurnk) rows and rejected attempts ride plurnk.ambient, never speech", () => {
    const tr = t();
    tr.logEntry(entry({ op: "WAIT", tx: { body: "orient" } }));
    const ambient = tr.logEntry(entry({ op: "EDIT", origin: "_plurnk", pathname: "/prompt/1/1" }));
    assert.deepEqual(ambient.map((e) => e.type === "CUSTOM" ? e.name : e.type), ["plurnk.ambient"]);
    const rejected = tr.logEntry(entry({ op: null, loop_seq: 1, turn_seq: 1, sequence: 3, attrs: { kind: "emissionAttempt" }, tx: "an unparsed reply" }));
    assert.deepEqual(rejected.map((e) => e.type === "CUSTOM" ? e.name : e.type), ["plurnk.ambient"], "a rejected emission builds no part: it rides whole, forensic, never speech");
});

test("an actionless model row without an artifact discriminator is rejected", () => {
    assert.throws(
        () => t().logEntry(entry({ op: null, attrs: {} })),
        /attrs\.kind=emissionAttempt/,
    );
    assert.throws(
        () => t().replay([{ id: 1, op: null, origin: "model", attrs: {}, loop_seq: 1, turn_seq: 1, sequence: 1 }]),
        /attrs\.kind=emissionAttempt/,
    );
});

test("reasoning READs remain operation receipts without duplicating standard reasoning or speech", () => {
    const tr = t();
    const reasoning = entry({ op: "READ", origin: "_plurnk", scheme: "reasoning", pathname: "/1/1/1", rx: { content: "Working reasoning text." } });
    const live = tr.logEntry(reasoning);
    assert.deepEqual(live.map(({ type }) => type), ["STEP_STARTED", "CUSTOM"]);
    const ambient = live.at(-1);
    assert.equal(ambient?.type === "CUSTOM" && ambient.name, "plurnk.ambient");
    const replay = tr.replay([
        reasoning.entry,
        { id: 8, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/th-1/messages/m1"] }, loop_seq: 1, turn_seq: 1, turn_id: 1, sequence: 4, tx: { body: "Answer." }, reasoning: "Original provider text." },
    ]);
    const snapshot = replay.find(({ type }) => type === "MESSAGES_SNAPSHOT");
    assert.ok(snapshot?.type === "MESSAGES_SNAPSHOT");
    assert.deepEqual(snapshot.messages.filter(({ role }) => role === "reasoning"), [
        { id: "1/1/4/reasoning", role: "reasoning", content: "Original provider text." },
    ]);
    assert.equal(snapshot.messages.filter(({ role }) => role === "assistant").length, 1);
});

test("{§agui-encrypted-reasoning} the encrypted-reasoning interface is not implemented", () => {
    const tr = t();
    // Readable reasoning becomes a reasoning message; AG-UI's encrypted-reasoning events are
    // never emitted, because the service collects no encrypted reasoning to put in them.
    const events = tr.logEntry(entry({
        id: 9, op: "SEND", status_rx: 200, origin: "model", turn_id: 1,
        tx: { body: "Answer." }, reasoning: "Readable provider text.",
    }));
    assert.ok(events.some(({ type }) => type.startsWith("REASONING")), "readable reasoning still streams");
    assert.ok(
        events.every(({ type }) => !type.includes("ENCRYPTED")),
        JSON.stringify(events.map((e) => e.type)),
    );
});

test("turn boundaries are STEPs; termination closes the step and flags the outcome", () => {
    const tr = t();
    const first = tr.logEntry(entry({ op: "WAIT", turn_id: 1, tx: { body: "first" } }));
    assert.equal(first[0]?.type, "STEP_STARTED");
    const second = tr.logEntry(entry({ op: "WAIT", turn_id: 2, tx: { body: "second" } }));
    assert.deepEqual(second.slice(0, 2).map((e) => e.type), ["STEP_FINISHED", "STEP_STARTED"]);
    const term: TerminatedNotification = { terminatedAt: 1_792_008_205_250, workerId: 2, loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2], attributions: [], usage: loopUsage({ inputTokens: 10, outputTokens: 5, curationBudget: 6848 }) };
    const done = tr.terminated(term);
    assert.deepEqual(done.map((e) => e.type), ["STEP_FINISHED", "STATE_DELTA", "RUN_FINISHED"]);
});

test("{§agui-cost-evidence} {§agui-plurnk-metadata} a Run's end carries the full terminal record as metadata, including attribution outside usage", () => {
    const tr = new Translator({ threadId: "th-1", runId: "run-1", workspaceId: 512 });
    const term: TerminatedNotification = { terminatedAt: 1_792_008_205_250,
        workerId: 2,
        loopId: 77,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [1, 2, 3],
        attributions: ["creator:ada"],
        usage: loopUsage({
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            cacheReadTokens: 3,
            cost: { kind: "unknown", reason: "no provider rate" },
            curationBudget: 6848,
            meta: { balance: { amount: "0.99", currency: "XMR" } },
        }),
    };
    const end = tr.terminated(term).find(({ type }) => type === EventType.RUN_FINISHED) as { metadata?: { plurnk?: { terminal?: TerminatedNotification & { workspaceId: number | null } } } } | undefined;
    const terminal = end?.metadata?.plurnk?.terminal;
    assert.equal(terminal?.workspaceId, 512, "daemon workspaceId — one json schema across transports");
    assert.equal(terminal?.workerId, 2, "workerId stays paired with its owning loop");
    assert.equal(terminal?.loopId, 77, "loopId — absent from core events");
    assert.deepEqual(terminal?.turnIds, [1, 2, 3], "turn count for the record");
    assert.deepEqual(terminal?.attributions, ["creator:ada"], "opaque tags stay top-level rather than becoming usage or provider meta");
    assert.equal(terminal?.usage.accounting.costUsd, null, "unknown cost is not projected as zero");
    assert.deepEqual(terminal?.usage.accounting.requests[0]?.cost, { kind: "unknown", reason: "no provider rate" }, "cardinal monetary authority survives the Run's metadata");
    assert.equal(terminal?.usage.accounting.usage?.outputTokenDetails?.reasoningTokens, 2);
    assert.equal(terminal?.usage.accounting.usage?.inputTokenDetails?.cacheReadTokens, 3);
    assert.deepEqual(terminal?.usage.meta, { balance: { amount: "0.99", currency: "XMR" } }, "opaque provider meta, verbatim");
});

// {§agui-run-outcome} Every way a loop ends, as the official schema reads it.
test("{§agui-run-outcome} {§agui-plurnk-metadata} a loop's end is the Run's standard outcome: completed with its result, cancelled, or failed, with the requests' usage and the terminal record", () => {
    const unknown = { kind: "unknown", reason: "no provider rate" } as const;
    const requests = [
        { provider: "openai", model: "a", outcome: "response", cost: unknown, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120,
            inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 15, reasoningTokens: 5 } } },
        { provider: "openai", model: "a", outcome: "response", cost: unknown, usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } },
        { provider: "openai", model: "b", outcome: "error", status: 503, cost: unknown },
    ] as const;
    const loopEnd = (result: TerminatedNotification["result"], reported: ReadonlyArray<(typeof requests)[number]> = requests): TerminatedNotification => ({
        terminatedAt: 1_792_008_205_250, workerId: 2, loopId: 1, result, hitMaxTurns: false, turnIds: [1], attributions: [],
        usage: loopUsage({ accounting: { requests: [...reported], usage: null, knownUsage: null, costUsd: null, knownCostUsd: null } }),
    });
    const ended = (n: TerminatedNotification) => t().terminated(n).filter(({ type }) => type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR);
    const terminal = (n: TerminatedNotification) => ({ plurnk: { terminal: { ...n, workspaceId: null } } });
    const usage = [{ provider: "openai", model: "a", inputTokens: 150, outputTokens: 30, totalTokens: 180, reasoningTokens: 5, cachedInputTokens: 40, cacheWriteInputTokens: 0 }];

    const done = loopEnd({ status: 200 });
    const completed = ended(done);
    assert.deepEqual(completed, [{ type: EventType.RUN_FINISHED, threadId: "th-1", runId: "run-1", outcome: { type: "success" }, result: { status: 200 }, usage, metadata: terminal(done) }],
        "a completed loop finishes with its exact result, the tokens its requests reported per model, and its terminal record");
    const cancel = { type: "https://problems.plurnk.xyz/lifecycle/cancel/loop-cancelled", title: "Loop cancelled", status: 499, detail: "Cancelled by its owner." };
    const stopped = loopEnd({ status: 499, problem: cancel });
    const cancelled = ended(stopped);
    assert.deepEqual(cancelled, [{ type: EventType.RUN_FINISHED, threadId: "th-1", runId: "run-1", outcome: { type: "cancelled" }, usage, metadata: terminal(stopped) }],
        "a loop stopped without failing finishes cancelled, never as an error");
    for (const event of [...completed, ...cancelled]) RunFinishedEventSchema.parse(event);
    const failure = { type: "https://problems.plurnk.xyz/lifecycle/loop/runaway", title: "Runaway", status: 508, detail: "The loop repeated itself." };
    const failed = loopEnd({ status: 508, problem: failure });
    const error = ended(failed);
    assert.deepEqual(error, [{ type: EventType.RUN_ERROR, message: failure.detail, code: failure.type, usage, metadata: terminal(failed) }],
        "a failed loop is the Run's error, with the same usage and terminal record");
    RunErrorEventSchema.parse(error[0]);
    const unreported = loopEnd({ status: 200 }, [requests[2]]);
    assert.deepEqual(ended(unreported), [{ type: EventType.RUN_FINISHED, threadId: "th-1", runId: "run-1", outcome: { type: "success" }, result: { status: 200 }, metadata: terminal(unreported) }],
        "requests that reported no tokens report no usage, never zero");
});

test("the budget STATE_DELTA carries the daemon's numbers verbatim", () => {
    const tr = t();
    const term: TerminatedNotification = { terminatedAt: 1_792_008_205_250, workerId: 2, loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2, 3, 4], attributions: [], usage: loopUsage({ curationWeight: 7654, curationBudget: 40000, inputTokens: 4321, outputTokens: 99, contextCapacity: 35840 }) };
    const delta = tr.terminated(term).find((e) => e.type === "STATE_DELTA") as { delta: Array<{ path: string; value?: unknown }> };
    assert.equal(delta.delta.find((d) => d.path === "/budget/curationWeight")?.value, 7654);
    assert.equal(delta.delta.find((d) => d.path === "/budget/curationBudget")?.value, 40000);
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextTokens")?.value, 4321);
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextCapacity")?.value, 35840);
    assert.deepEqual(delta.delta.map(({ path }) => path).filter((path) => path.startsWith("/budget/")), [
        "/budget/curationWeight",
        "/budget/curationBudget",
        "/budget/contextTokens",
        "/budget/contextCapacity",
    ], "AG-UI keeps curation and physical occupancy as separate pairs");
});

test("a failed termination preserves its Problem and maps it to RUN_ERROR", () => {
    const tr = t();
    const problem = {
        type: "https://problems.plurnk.xyz/provider/openai/invalid-response",
        title: "Invalid response",
        status: 502,
        detail: "The provider returned an invalid response.",
        instance: "log:///1/2/3/error",
    };
    const term: TerminatedNotification = { terminatedAt: 1_792_008_205_250,
        workerId: 2,
        loopId: 1,
        result: { status: 502, problem },
        hitMaxTurns: false,
        turnIds: [],
        attributions: [],
        usage: loopUsage(),
    };
    const events = tr.terminated(term);
    const error = events.find((e) => e.type === "RUN_ERROR") as { code?: string; message?: string; metadata?: { plurnk?: { terminal?: unknown } } };
    assert.deepEqual(
        error?.metadata?.plurnk?.terminal,
        { ...term, workspaceId: null },
        "{§agui-plurnk-metadata} the Run's error carries the exact Problem in its terminal record, without translation loss",
    );
    assert.equal(error?.code, problem.type);
    assert.equal(error?.message, problem.detail);
});

test("a failed termination without a Problem is rejected instead of synthesized from status", () => {
    const tr = t();
    const term: TerminatedNotification = { terminatedAt: 1_792_008_205_250,
        workerId: 2,
        loopId: 1,
        result: { status: 502 },
        hitMaxTurns: false,
        turnIds: [],
        attributions: [],
        usage: loopUsage(),
    };
    assert.throws(
        () => tr.terminated(term),
        /invalid operation result/,
    );
});

test("{§agui-ambient} a FOREIGN worker's rows never enter the core stream — plurnk.ambient only", () => {
    const tr = new Translator({ threadId: "th", runId: "r", modelWorkerId: 2 });
    const own = tr.logEntry({ entry: wireRow({ id: 1, op: "WAIT", worker_id: 2, tx: JSON.stringify({ body: "mine" }) }) });
    assert.ok(own.some((e) => e.type === "TEXT_MESSAGE_CONTENT"), "the thread's own WAIT speaks its body");
    const worker = tr.logEntry({ entry: { id: 9, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/th/messages/m1"] }, turn_id: 7, tx: JSON.stringify({ body: "worker speech" }), reasoning: "worker reasoning", ...( { worker_id: 5 } as object) } as never });
    assert.deepEqual(worker.map((e) => e.type === "CUSTOM" ? e.name : e.type), ["plurnk.ambient"], "a worker's rows ride plurnk.ambient — visible topology, never the thread's messages");
    assert.ok(!worker.some((e) => e.type === "TEXT_MESSAGE_START"), "a worker's SEND never masquerades as the assistant speaking");
    assert.ok(!worker.some((e) => e.type.startsWith("REASONING_")), "a worker's reasoning never enters another thread's messages");
});

test("a rejected emission attempt remains forensic even if an invalid producer supplies readable text", () => {
    const events = t().logEntry(entry({
        op: null,
        attrs: { kind: "emissionAttempt" },
        reasoning: "rejected response reasoning",
    }));
    assert.deepEqual(events.map((event) => event.type === "CUSTOM" ? event.name : event.type), ["STEP_STARTED", "plurnk.ambient"], "{§agui-ambient} it rides whole");
    assert.ok(!events.some((event) => event.type.startsWith("REASONING_") || event.type.startsWith("TEXT_MESSAGE_")));
});

test("the newest-first workspace log replays user prompts, WAIT and SEND speech chronologically without rejected attempts", () => {
    const tr = new Translator({ threadId: "th", runId: "r" });
    const events = tr.replay([
        { id: 6, op: null, origin: "model", loop_seq: 1, turn_seq: 2, turn_id: 2, sequence: 3, attrs: { kind: "emissionAttempt" } },
        { id: 5, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/th/messages/m1"] }, loop_seq: 1, turn_seq: 2, sequence: 2, turn_id: 2, tx: { body: "And done." } },
        { id: 4, op: "WAIT", origin: "model", loop_seq: 1, turn_seq: 2, sequence: 1, turn_id: 2, tx: { body: "finish" } },
        { id: 3, op: null, origin: "model", loop_seq: 1, turn_seq: 1, sequence: 10, turn_id: 1, attrs: { kind: "emissionAttempt" } },
        { id: 2, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/th/messages/m1"] }, loop_seq: 1, turn_seq: 1, sequence: 9, turn_id: 1, tx: { body: "The answer is 42." }, reasoning: "considered the evidence" },
        { id: 1, op: "WAIT", origin: "model", loop_seq: 1, turn_seq: 1, sequence: 1, turn_id: 1, tx: { body: "orient" } },
        { id: 0, op: "SEND", status_rx: 200, origin: "_plurnk", attrs: { kind: "message" }, loop_seq: 1, turn_seq: 1, sequence: 0, tx: { body: { raw: "What is the answer?" } } },
    ], { id: "current-user", role: "user", content: "Continue." });
    assert.equal(events.length, 1);
    const snap = events[0] as { type: string; messages: Array<{ id: string; role: string; activityType?: string; content: unknown }> };
    assert.equal(snap.type, "MESSAGES_SNAPSHOT");
    assert.deepEqual(said(snap.messages), [
        { id: "1/1/0", role: "user", content: "What is the answer?" },
        { id: "1/1/1", role: "assistant", content: "orient" },
        { id: "1/1/9/reasoning", role: "reasoning", content: "considered the evidence" },
        { id: "1/1/9", role: "assistant", content: "The answer is 42." },
        { id: "1/2/1", role: "assistant", content: "finish" },
        { id: "1/2/2", role: "assistant", content: "And done." },
        { id: "current-user", role: "user", content: "Continue." },
    ]);
    assert.doesNotThrow(() => MessagesSnapshotEventSchema.parse(snap), "reattach uses the standard AG-UI message snapshot");
});

test("an interrupt closes the current AG-UI step and its resume Run reopens the continued Plurnk turn", () => {
    const interrupted = t();
    interrupted.logEntry(entry({ op: "WAIT", turn_id: 7, tx: { body: "wait for approval" } }));

    const paused = interrupted.interrupt();
    assert.deepEqual(paused.events, [{ type: "STEP_FINISHED", stepName: "turn-7" }]);

    const resumed = new Translator({ threadId: "th-1", runId: "run-2", continuation: paused.continuation });
    assert.deepEqual(resumed.runStarted({ type: EventType.STATE_SNAPSHOT, snapshot: { ready: true } }).map(({ type }) => type), [
        "RUN_STARTED",
        "STATE_SNAPSHOT",
        "STEP_STARTED",
    ]);
});

test("runtime protocol and family dependencies are declared explicitly", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    assert.ok(deps.includes("@ag-ui/core"), "the standard wire types and schemas are a direct runtime dependency");
    // Vacuous-pass guard: contracts is a runtime import (Module's op.parse) — it must
    // live in dependencies, not devDependencies (npm --save-exact updates an existing
    // devDep in place).
    assert.ok(deps.includes("@plurnk/plurnk-contracts"), "the contracts and grammar runtime import is declared in dependencies");
});

test("{§agui-outside-text}: outside text projects one plurnk.outside per admitted emission for the thread's worker, and nothing for a foreign one", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    const event = { workerId: 2, loopId: 4, turnId: 7, coordinate: "alice-4-7", text: "Thinking out loud.", tokens: 9 };
    assert.deepEqual(tr.outside(event), [
        { type: EventType.STEP_STARTED, stepName: "turn-7" },
        { type: EventType.CUSTOM, name: "plurnk.outside", value: { coordinate: "alice-4-7", text: "Thinking out loud.", tokens: 9 } },
    ], "the exact text and its weight ride the custom namespace, never assistant speech");
    assert.deepEqual(tr.outside({ ...event, workerId: 9, loopId: 12, turnId: 13 }), [], "a foreign worker's text never enters the thread");
    assert.equal(tr.outside({ ...event, turnId: 7 }).filter(({ type }) => type === EventType.STEP_STARTED).length, 0, "a second emission in the same turn opens no second step");
});

test("{§loop-status-notice} {§agui-status-timing} a lifecycle notice is its loop's gauge, identity, count and stamps together, and nothing else", () => {
    const tr = t();
    const beat = (status: number, waitUntil: number | null = null, facts: Record<string, unknown> = { packetCount: 3, claimedAt: 1_792_008_000_000 }, loopId: number | null = 50) =>
        tr.notice({ source: "engine:lifecycle", kind: "loop_status", level: "info", status, waitUntil, ...facts }, loopId);
    for (const [status, lifecycle, waitUntil] of [[202, "parked", 123_000], [202, "parked", null], [100, "queued", null], [102, "running", null]] as const) {
        assert.deepEqual(beat(status, waitUntil), [{ type: EventType.STATE_DELTA, delta: [
            { op: "replace", path: "/plurnk/status/lifecycle", value: lifecycle },
            { op: "replace", path: "/plurnk/status/loopId", value: 50 },
            { op: "replace", path: "/plurnk/status/packetCount", value: 3 },
            { op: "replace", path: "/plurnk/status/waitUntil", value: waitUntil },
            { op: "replace", path: "/plurnk/status/claimedAt", value: 1_792_008_000_000 },
            { op: "replace", path: "/plurnk/status/terminatedAt", value: null },
        ] }], "one delta: the loop it describes, never another loop's number beside its stamp, and no diagnostic duplication");
    }
    assert.throws(() => beat(200), /carries 100, 102 or 202/u, "a terminal is loop/terminated's, never a beat");
    assert.throws(() => beat(202, NaN), /nullable Unix-millisecond waitUntil/u);
    assert.throws(() => beat(102, null, { claimedAt: 1 }), /packet count/u);
    assert.throws(() => beat(102, null, { packetCount: 0, claimedAt: "now" }), /claimedAt/u);
    assert.throws(() => beat(102, null, undefined, null), /names its loop/u);
});

test("{§agui-snapshot} {§message-arrival} an arrival is the same user message live and on replay, and the Run that submitted it gets only its row's facts", () => {
    const own = "agui://alice/threads/th-1/messages/m-own";
    const other = "agui://bob/threads/th-1/messages/m-other";
    const arrival = (id: number, source: string, body: string) => wireRow({ id, origin: "_plurnk", op: "SEND", source, attrs: { kind: "message" }, tx: { body: { raw: body } } });
    const rows = [arrival(1, own, "From the submitter."), arrival(2, other, "From another client."), arrival(3, "worker://helper", "From a worker.")];
    const submitter = t();
    submitter.submitted("m-own");
    const live = (tr: Translator) => rows.flatMap((row) => tr.logEntry({ entry: row }))
        .filter((event) => event.type === EventType.TEXT_MESSAGE_START || event.type === EventType.TEXT_MESSAGE_CONTENT);
    const user = (events: readonly AguiEvent[]) => events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)
        .map((event) => { const start = event as { messageId: string; role: string; name?: string }; return { id: start.messageId, role: start.role, name: start.name }; });
    assert.deepEqual(user(live(t())), [
        { id: "m-own", role: "user", name: undefined },
        { id: "m-other", role: "user", name: undefined },
        { id: "1/1/3", role: "user", name: "worker://helper" },
    ], "an observer receives every arrival natively: a thread client's message as that client sent it, any other named by its source");
    const words = (events: readonly AguiEvent[]) => events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => (event as { messageId: string }).messageId);
    assert.deepEqual(words(live(submitter)), ["m-other", "1/1/3"], "the submitting Run's client already holds its own message's words");
    const ownFacts = (live(submitter).find((event) => event.type === EventType.TEXT_MESSAGE_START && event.messageId === "m-own") as { metadata?: { plurnk?: { id?: unknown; coordinate?: unknown } } } | undefined)?.metadata?.plurnk;
    assert.deepEqual([ownFacts?.id, ownFacts?.coordinate], [1, "1/1/1"],
        "{§agui-plurnk-metadata} and receives only its row's facts for it, its log coordinate among them");
    const snapshot = t().replay(rows)[0] as { messages: Array<{ id: string; role: string; content: unknown; name?: string }> };
    assert.deepEqual(said(snapshot.messages), [
        { id: "m-own", role: "user", content: "From the submitter." },
        { id: "m-other", role: "user", content: "From another client." },
        { id: "1/1/3", role: "user", content: "From a worker.", name: "worker://helper" },
    ], "the snapshot carries the same messages under the same identities");
});

test("{§agui-readable-reasoning} {§agui-snapshot} reasoning keeps the identity of the request that streamed it on replay; reasoning a FORK inherited keeps its row's", () => {
    const tr = t();
    const streamed = [
        ...tr.reasoning({ workerId: 10, loopId: 1, turnId: 1, modelCallId: 41, requestSequence: 2, phase: "start" }),
        ...tr.reasoning({ workerId: 10, loopId: 1, turnId: 1, modelCallId: 41, requestSequence: 2, phase: "content", delta: "Weighing it." }),
        ...tr.reasoning({ workerId: 10, loopId: 1, turnId: 1, modelCallId: 41, requestSequence: 2, phase: "end" }),
    ];
    const live = (streamed.find((event) => event.type === EventType.REASONING_START) as { messageId: string }).messageId;
    const accepted = wireRow({ id: 5, op: "READ", reasoning: "Weighing it.", reasoning_model_call_id: 41, reasoning_request_sequence: 2 });
    const inherited = wireRow({ id: 6, turn_id: 2, turn_seq: 2, sequence: 1, op: "READ", reasoning: "The parent's thought." });
    const snapshot = t().replay([accepted, inherited])[0] as { messages: Array<{ id: string; role: string }> };
    assert.deepEqual(snapshot.messages.filter(({ role }) => role === "reasoning").map(({ id }) => id), [live, "1/2/1/reasoning"]);
});

test("{§agui-plurnk-metadata} a row's facts ride the metadata of what it builds, the same live and on replay", () => {
    const facts = (row: LogEntryNotification["entry"]) => ({ plurnk: { id: row.id, coordinate: `${row.loop_seq}/${row.turn_seq}/${row.sequence}`,
        worker: row.worker_id, origin: row.origin, op: row.op, source: row.source, address: Translator.addressOf(row), signal: row.signal, status: row.status_rx,
        attrs: row.attrs, state: row.state } });
    const speech = (row: LogEntryNotification["entry"], aside: string | null) => ({ plurnk: { ...facts(row).plurnk, aside, receipt: row.rx } });
    const rows = [
        wireRow({ id: 1, sequence: 1, origin: "_plurnk", op: "SEND", source: "worker://helper", attrs: { kind: "message" }, tx: { body: { raw: "Look." } } }),
        wireRow({ id: 2, turn_id: 2, turn_seq: 2, sequence: 1, op: "READ", tx: authored("````READ (worker:///notes.md)\n````"), status_rx: 404,
            rx: { status: 404, problem: { type: "https://problems.plurnk.xyz/scheme/worker/missing", title: "Missing", status: 404, detail: "No such entry." } } }),
        wireRow({ id: 3, turn_id: 3, turn_seq: 3, sequence: 1, op: "SEND", tx: { target: null, aside: "the answer", body: { raw: "Done." } }, rx: { status: 200, answers: ["agui://anonymous/threads/th-1/messages/m1"] } }),
        wireRow({ id: 4, turn_id: 3, turn_seq: 3, sequence: 2, op: "WAIT", signal: 202, status_rx: 102, tx: authored("````WAIT\n````"), rx: { status: 102, detail: "Nothing is in flight. Continuing." } }),
        wireRow({ id: 5, turn_id: 3, turn_seq: 3, sequence: 3, op: "WAIT", signal: 202, status_rx: 202, tx: authored("````WAIT <!-- parked -->\nBack soon.\n````"), rx: { status: 202, attrs: { waiting: 1 } } }),
    ];
    const live = rows.flatMap((row) => t().logEntry({ entry: row }));
    const carried = (type: string) => live.filter((event) => event.type === type).map((event) => (event as { metadata?: unknown }).metadata);
    assert.deepEqual(carried(EventType.TEXT_MESSAGE_START), [facts(rows[0]), speech(rows[2], "the answer"), speech(rows[4], "parked")],
        "an arrival carries its row's facts, and speech its heading's aside and its receipt too");
    assert.deepEqual(carried(EventType.TOOL_CALL_START), [facts(rows[1]), facts(rows[3])], "a call carries its row's facts, a bodiless WAIT's among them");
    assert.deepEqual(carried(EventType.TOOL_CALL_RESULT), [facts(rows[1]), facts(rows[3])], "and so does its result, its status the failure");
    const [snapshot] = t().replay(rows);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(snapshot.messages.map((message) => "toolCalls" in message && message.toolCalls !== undefined
        ? message.toolCalls.map(({ metadata }) => metadata)[0] : message.metadata),
        [facts(rows[0]), facts(rows[1]), facts(rows[1]), speech(rows[2], "the answer"), facts(rows[3]), facts(rows[3]), speech(rows[4], "parked")],
        "the snapshot holds the same metadata on the same parts");
});

test("{§agui-plurnk-metadata} a row's address is what it recorded: scheme, host, port, path, query and channel, or the bare path of a file", () => {
    assert.equal(Translator.addressOf(wireRow({ scheme: "https", hostname: "example.com", port: 8443, pathname: "/a", query: "b=1", fragment: "top" })), "https://example.com:8443/a?b=1#top");
    assert.equal(Translator.addressOf(wireRow({ scheme: "worker", hostname: null, pathname: "/plan.md" })), "worker:///plan.md", "an empty authority stays empty");
    assert.equal(Translator.addressOf(wireRow({ scheme: "ops", hostname: "helper", pathname: "/1" })), "ops://helper/1");
    assert.equal(Translator.addressOf(wireRow({ scheme: null, pathname: "src/a.ts", fragment: "stderr" })), "src/a.ts#stderr", "a file's channel is its fragment");
    assert.equal(Translator.addressOf(wireRow({ scheme: null, pathname: null })), null, "a row that named nothing has no address");
});

test("{§agui-parse-refusal} a parse refusal is the call the worker attempted, answered by the refusal, live and on replay; one that names no attempt rides whole", () => {
    const refusal = { type: "https://problems.plurnk.xyz/grammar/parser/invalid-operation-syntax", title: "Invalid operation syntax", status: 400, detail: "invalid READ scope" };
    const attempted = wireRow({ id: 4, sequence: 2, op: "error", status_rx: 400, tx: "", rx: { status: 400, problem: refusal },
        attrs: { attempt: { verb: "READ", text: "````READ (a.md) <1,\n````" } } });
    const unread = wireRow({ id: 5, sequence: 3, op: "error", status_rx: 400, tx: "", rx: { status: 400, problem: refusal }, attrs: {} });
    const live = [attempted, unread].flatMap((row) => t().logEntry({ entry: row }));
    const start = live.find((event) => event.type === EventType.TOOL_CALL_START) as { toolCallId: string; toolCallName: string } | undefined;
    assert.deepEqual([start?.toolCallId, start?.toolCallName], ["1/1/2", "READ"], "named by the verb the parser read");
    const args = live.find((event) => event.type === EventType.TOOL_CALL_ARGS) as { delta: string } | undefined;
    assert.deepEqual(JSON.parse(args?.delta ?? "{}"), { text: "````READ (a.md) <1,\n````" }, "its arguments are the statement as written");
    const result = live.find((event) => event.type === EventType.TOOL_CALL_RESULT) as { content: string; metadata?: { plurnk?: { status?: number } } } | undefined;
    assert.deepEqual([JSON.parse(result?.content ?? "{}").problem?.type, result?.metadata?.plurnk?.status], [refusal.type, 400], "answered by the refusal, its status the failure");
    assert.equal(live.filter((event) => event.type === EventType.TOOL_CALL_START).length, 1, "a refusal that names no attempt is no call");
    assert.ok(live.some((event) => event.type === EventType.CUSTOM && event.name === "plurnk.ambient"), "it rides whole");
    const [snapshot] = t().replay([attempted, unread]);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("missing snapshot");
    assert.deepEqual(calls(snapshot.messages), [["1/1/2", "READ"]], "the snapshot holds the same call");
    assert.ok(snapshot.messages.some((message) => message.role === "tool" && message.toolCallId === "1/1/2"), "and its refusal");
});

test("{§methods-log-coordinate} a row's message identity is its L/T/S coordinate, and a row without its ordinals is refused", () => {
    assert.equal(Translator.idOf(wireRow({ loop_seq: 3, turn_seq: 4, sequence: 5 })), "3/4/5");
    assert.throws(() => Translator.idOf({ id: 9 } as never), /loop, turn and sequence ordinals/);
});
