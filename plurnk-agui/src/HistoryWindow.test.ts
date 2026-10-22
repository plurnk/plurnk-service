// {§agui-history-window} {§agui-history-page} {§agui-loop-page} — the cut matrix: loops, whole turns, parts, the ceiling,
// accepted messages, pages that walk back to reassemble the complete conversation, and each loop by its number.
import test from "node:test";
import assert from "node:assert/strict";
import type { ContentPart, Message } from "@ag-ui/core";
import HistoryWindow from "./HistoryWindow.ts";

const facts = (coordinate: string): { plurnk: { coordinate: string } } => ({ plurnk: { coordinate } });
const attributed = <T extends Message>(message: T, run?: string): T => run === undefined ? message : { ...message, subagentRunId: run };
const user = (id: string, coordinate: string, content = "ask"): Message => ({ id, role: "user", content, metadata: facts(coordinate) });
const call = (id: string, run?: string, args = "{}"): Message =>
    attributed({ id, role: "assistant", toolCalls: [{ id, type: "function", function: { name: "READ", arguments: args }, metadata: facts(id.replace(/^.*#/u, "")) }] }, run);
const result = (callId: string, run?: string, content = "{}"): Message => attributed({ id: `${callId}/result`, role: "tool", toolCallId: callId, content }, run);
const reasoning = (id: string, turn: string): Message => ({ id, role: "reasoning", content: "", metadata: facts(turn) });
const speech = (id: string, content = "Done."): Message => ({ id, role: "assistant", content, metadata: facts(id) });
const pending = (id: string): Message => ({ id, role: "user", content: "next", metadata: { plurnk: { published: false } } });

// One loop of the bound worker: its arrival, a turn's reasoning, a call and its result, and its reply.
const loop = (n: number): Message[] => [user(`m${n}`, `${n}/1/1`), reasoning(`r${n}`, `${n}/2`), call(`${n}/2/1`), result(`${n}/2/1`), speech(`${n}/2/2`)];
const ids = (messages: readonly Message[]): string[] => messages.map(({ id }) => id);
const unbounded = { loops: 2, chars: Number.POSITIVE_INFINITY };
const none = (): number => 0;

test("{§agui-history-window} the window holds the bound worker's newest loops, each whole; fewer loops than that is the whole conversation", () => {
    const messages = [1, 2, 3, 4].flatMap(loop);
    const window = new HistoryWindow(messages, unbounded);
    assert.deepEqual(ids(messages.slice(window.window(none))), ids([3, 4].flatMap(loop)));
    assert.equal(new HistoryWindow(messages, { ...unbounded, loops: 9 }).window(none), 0);
    assert.equal(new HistoryWindow(messages, { ...unbounded, loops: 1 }).window(none), messages.findIndex(({ id }) => id === "m4"));
});

test("{§agui-history-window} a cut never splits a turn: a subagent's turn straddling the boundary pulls the cut back to its start", () => {
    const run = "ops://helper/1";
    const messages = [
        ...loop(1),
        call("worker://helper#1/2/1", run), ...loop(2), result("worker://helper#1/2/1", run), call("worker://helper#1/2/2", run),
        ...loop(3),
    ];
    const start = new HistoryWindow(messages, unbounded).window(none);
    assert.equal(messages[start]?.id, "worker://helper#1/2/1", "the helper's turn began before loop 2, so the window begins with it");
});

test("{§agui-history-window} the ceiling moves the cut to the first whole turn that fits; a turn is cut between its parts only when it alone passes the ceiling", () => {
    const big = (id: string, size: number): Message => call(id, undefined, JSON.stringify({ body: "x".repeat(size) }));
    // Loop 2 holds two turns: one of ~3,000 characters, then one of ~1,000.
    const messages = [...loop(1), user("m2", "2/1/1"), big("2/2/1", 3000), result("2/2/1"), big("2/3/1", 1000), result("2/3/1")];
    const fitting = new HistoryWindow(messages, { loops: 2, chars: 2000 });
    assert.deepEqual(ids(messages.slice(fitting.window(none))), ["2/3/1", "2/3/1/result"], "the newest turn that fits, whole");
    // One turn of two parts, each ~1,500 characters: past a 2,000 ceiling it is cut between the parts, a call keeping its result.
    const split = [...loop(1), user("m2", "2/1/1"), big("2/2/1", 1500), result("2/2/1"), big("2/2/2", 1500), result("2/2/2")];
    assert.deepEqual(ids(split.slice(new HistoryWindow(split, { loops: 2, chars: 2000 }).window(none))), ["2/2/2", "2/2/2/result"]);
});

test("{§agui-history-window} {§agui-history-page} a part that alone passes the ceiling falls into history and is a page of its own", () => {
    const messages = [...loop(1), user("m2", "2/1/1"), call("2/2/1", undefined, JSON.stringify({ body: "x".repeat(5000) })), result("2/2/1")];
    const window = new HistoryWindow(messages, { loops: 2, chars: 2000 });
    const start = window.window(none);
    assert.equal(start, messages.length, "nothing past the ceiling travels in a snapshot");
    const page = window.page(start, none);
    assert.deepEqual(ids(messages.slice(page.start, page.end)), ["2/2/1", "2/2/1/result"], "it is fetched whole, alone");
});

test("{§agui-history-window} accepted messages the worker has not yet observed always travel, and no cut falls after them", () => {
    const messages = [...[1, 2, 3].flatMap(loop), pending("p1"), pending("p2")];
    const window = new HistoryWindow(messages, { loops: 1, chars: 400 });
    const held = ids(messages.slice(window.window(none)));
    assert.deepEqual(held.slice(-2), ["p1", "p2"]);
    assert.equal(window.pending, messages.length - 2);
});

test("{§agui-history-window} the serialized snapshot, envelope included, stays within the ceiling", () => {
    const messages = [1, 2, 3, 4, 5].flatMap(loop);
    for (const chars of [300, 600, 900, 2000, 5000]) {
        const window = new HistoryWindow(messages, { loops: 3, chars });
        const older = "https://daemon.test/agui/1/2/messages?thread=t&before=m3";
        const start = window.window(() => HistoryWindow.snapshotEnvelope(older));
        const event = { type: "MESSAGES_SNAPSHOT", messages: messages.slice(start), metadata: { plurnk: { history: { older } } } };
        assert.ok(JSON.stringify(event).length <= chars, `${chars}: ${JSON.stringify(event).length}`);
    }
});

test("{§agui-history-page} pages walk back one loop at a time and, with the window, reassemble the complete conversation exactly", () => {
    const run = "ops://helper/1";
    const messages = [...loop(1), call("worker://helper#1/2/1", run), result("worker://helper#1/2/1", run), ...[2, 3, 4, 5].flatMap(loop), pending("p")];
    for (const chars of [Number.POSITIVE_INFINITY, 200, 500]) {
        const window = new HistoryWindow(messages, { loops: 2, chars });
        let end = window.window(none);
        const segments = [messages.slice(end)];
        while (end > 0) {
            const page = window.page(end, none);
            assert.ok(page.start < page.end && page.end === end, `${chars}: a page ends where the next segment begins`);
            segments.unshift(messages.slice(page.start, page.end));
            end = page.start;
        }
        assert.deepEqual(ids(segments.flat()), ids(messages), `${chars}: the pages and the window are the conversation, once each, in order`);
    }
    const window = new HistoryWindow(messages, { loops: 2, chars: Number.POSITIVE_INFINITY });
    const page = window.page(window.window(none), none);
    assert.deepEqual([messages[page.start]?.id, window.loopOf(page)], ["m3", 3], "the page before the window is its previous loop");
});

test("{§agui-history-page} a page is settled when every call in it holds its result", () => {
    const messages = [...loop(1), user("m2", "2/1/1"), call("2/2/1"), ...loop(3)];
    const window = new HistoryWindow(messages, { loops: 1, chars: Number.POSITIVE_INFINITY });
    const loop2 = window.page(window.window(none), none);
    assert.equal(window.settled(loop2), false, "a call still awaiting its result");
    assert.equal(window.settled(window.page(loop2.start, none)), true);
});

test("{§agui-loop-page} a loop is its messages from its first to the next loop's first, every subagent message among them, whole past the ceiling; the loops are the conversation before its accepted messages", () => {
    const run = "ops://helper/1";
    // The helper's turn begins in loop 1 and its next in loop 2; loop 2's call outgrows any ceiling below.
    const helper = (turn: number): Message[] => [call(`worker://helper#1/${turn}/1`, run), result(`worker://helper#1/${turn}/1`, run)];
    const large = [user("m2", "2/1/1"), call("2/2/1", undefined, JSON.stringify({ body: "x".repeat(3000) })), result("2/2/1"), speech("2/2/2")];
    const messages = [...loop(1), ...helper(2), ...large, ...helper(3), ...loop(3), pending("p")];
    const expected = [[...ids(loop(1)), ...ids(helper(2))], [...ids(large), ...ids(helper(3))], ids(loop(3))];
    for (const chars of [Number.POSITIVE_INFINITY, 2000, 200]) {
        const window = new HistoryWindow(messages, { loops: 1, chars });
        const spans = [1, 2, 3].map((sequence) => window.loopSpan(sequence));
        assert.deepEqual(spans.map((span) => span === null ? null : ids(messages.slice(span.start, span.end))), expected, `${chars}: each loop whole, in order`);
        assert.equal(spans.at(-1)?.end, window.pending, `${chars}: the newest loop ends where the accepted messages begin`);
        assert.deepEqual([window.loopSpan(4), window.loopSpan(0)], [null, null], `${chars}: a number the conversation holds no loop of`);
    }
});

test("{§agui-words-by-reference} a part carries its senders' words by reference exactly when it alone, envelope included, would pass the ceiling", () => {
    const document = (id: string): ContentPart[] => [{ type: "document", source: { type: "url", value: `https://daemon.test/agui/1/2/entry?target=${id}`, mimeType: "text/plain" } }];
    const envelope = (): number => 57;
    // Text JSON keeps as it is, text it doubles, and text it writes six characters for: a part's size is its serialization.
    for (const [kind, words] of [["plain", "w".repeat(300)], ["newlines", "\n".repeat(300)], ["controls", "\u0001".repeat(300)]] as const) {
        for (const [label, part] of [
            ["an arrival", [user("m2", "2/1/1", words)]],
            ["a reply beside its call", [call("2/2/1"), result("2/2/1", undefined, words)]],
        ] as const) {
            const messages = [...loop(1), ...part];
            const references = new Map(part.filter(({ role }) => role !== "assistant").map(({ id }) => [id, document(id)]));
            const size = JSON.stringify(part).length - 2;
            const held = (chars: number): Message[] => new HistoryWindow(messages, { loops: 2, chars }, references, envelope).messages.slice(-part.length);
            assert.deepEqual(held(envelope() + size), part, `${kind}, ${label}: a part that fits travels as it is`);
            assert.deepEqual(held(envelope() + size - 1), part.map((message) => references.has(message.id) ? { ...message, content: references.get(message.id) } : message),
                `${kind}, ${label}: one character past the ceiling, its words travel by reference and nothing else changes`);
        }
    }
});
