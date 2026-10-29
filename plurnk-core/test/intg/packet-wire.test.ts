import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket, { type StoredPacketSection, type DurablePacket } from "../../src/core/StoredPacket.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Paths from "../../src/Paths.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mock, chatMessageText, type ChatMessage } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, insertTurn, insertPacketTurn } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { tmpdir } from "node:os";
import { Validator } from "@plurnk/plurnk-contracts";
import { urlPath, readStmt, completeStmt, copyStmt, editStmt, findStmt, regex, noteStmt } from "./_dsl.ts";
import { clientRead } from "./_client-read.ts";
import { parseEnv } from "node:util";
import { Lexer } from "marked";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { type PacketSectionDraft } from "@plurnk/plurnk-schemes";
import { createHash } from "node:crypto";
import { rpcCall, rpcProblem, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";


describe("Engine.inject", () => {
test("{§message-arrival} concurrent injections keep arrival order across a new Engine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ordered-messages");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "initial");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await Promise.all([engine.injectIntoLoop(loopId, "first"), engine.injectIntoLoop(loopId, "second")]);
        await new Engine({ db, schemes: new SchemeRegistry() }).injectIntoLoop(loopId, "third");
        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
        assert.deepEqual(inbox.map(({ body }) => body), ["initial", "first", "second", "third"], "the loop's assignment first, then arrivals in order");
        assert.deepEqual(inbox.map(({ ordinal }) => ordinal), [1, 2, 3, 4], "ordinals are durable across engines");
        assert.ok(inbox.every(({ log_entry_id }) => log_entry_id === null), "nothing is published before a turn boundary");
    } finally { await db.close(); }
});

test("{§message-arrival} engine.inject: persists a message with its ordinal, open paths, and causal source", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "initial prompt");
        // Loop starts at status=102 (insertLoop default). Insert a turn
        // 1 placeholder so engine.inject's next-turn query returns 2 —
        // matches the realistic mid-loop state.
        await insertTurn(db, loopId, 1, 102);

        const result = await engine.injectIntoLoop(
            loopId,
            "follow-up",
            ["src/context.ts", "README.md"],
            "session://researcher",
        );
        assert.ok(result, "engine.inject returned a result");
        assert.equal(result.loopId, loopId);
        assert.equal(result.turnSeq, 2, "the LANDING turn is 2 (turn 1 already exists) — delivery timing, not the key");

        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; source: string | null; open_paths: string; log_entry_id: number | null }>;
        assert.equal(inbox.length, 2, "the assignment and the arrival");
        const [, message] = inbox;
        assert.deepEqual(
            { ordinal: message.ordinal, body: message.body, source: message.source, openPaths: JSON.parse(message.open_paths), published: message.log_entry_id },
            { ordinal: 2, body: "follow-up", source: "session://researcher", openPaths: ["src/context.ts", "README.md"], published: null },
            "the message durably owns its selected workspace paths and causal source ({§message-arrival})",
        );
    } finally { await db.close(); }
});

test("{§message-arrival} concurrent injects are contained as distinct ordered messages with their own paths", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-containment");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "initial");
        await insertTurn(db, loopId, 1, 102);

        const [r1, r2] = await Promise.all([
            engine.injectIntoLoop(loopId, "first follow-up", ["first.ts"]),
            engine.injectIntoLoop(loopId, "second follow-up", ["second.ts"]),
        ]);
        assert.ok(r1 && r2, "both injects landed in the ACTIVE loop — no new loop while one is live");

        const rows = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ id: number; ordinal: number; body: string; open_paths: string }>;
        assert.deepEqual(rows.map(({ ordinal, body, open_paths }) => ({ ordinal, body, openPaths: JSON.parse(open_paths) })), [
            { ordinal: 1, body: "initial", openPaths: [] },
            { ordinal: 2, body: "first follow-up", openPaths: ["first.ts"] },
            { ordinal: 3, body: "second follow-up", openPaths: ["second.ts"] },
        ], "the earlier message is CONTAINED, never superseded");
        assert.equal(new Set(rows.map(({ id }) => id)).size, 3, "concurrent messages remain independent rows");

        const restarted = new Engine({ db, schemes: new SchemeRegistry() });
        await restarted.injectIntoLoop(loopId, "after restart", ["third.ts"]);
        const after = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; open_paths: string }>;
        assert.deepEqual(after.at(-1), { ...after.at(-1), ordinal: 4, body: "after restart", open_paths: JSON.stringify(["third.ts"]) }, "a new engine continues after the durable historical ordinals");
    } finally { await db.close(); }
});

test("{§message-arrival} engine.inject: returns null when the addressed Loop is missing or finished", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-no-active");
        const sessionId = await insertSession(db, workspaceId);
        // No loops at all in this session.
        const result = await engine.injectIntoLoop(999_999, "orphan prompt");
        assert.equal(result, null, "no active loop → null (caller falls back to enqueue path)");

        // Also returns null when a loop exists but it's terminal.
        const closedLoop = await insertLoop(db, sessionId, 1, "done");
        await db.test_set_loop_status.run({
            id: closedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        const result2 = await engine.injectIntoLoop(closedLoop, "still orphan");
        assert.equal(result2, null, "loop at status=200 doesn't count as active");
    } finally { await db.close(); }
});

test("{§session-wait-timing}: a queued recipient accepts messages without changing its lifecycle", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "queued-recipient");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "queued");
        await db.test_set_loop_status.run({ id: loopId, status: 100, terminal_result: null });
        const recipient = await db.drain_message_recipient.get<{ id: number }>({ session_id: sessionId, loop_id: loopId });
        assert.equal(recipient?.id, loopId);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        assert.equal((await engine.injectIntoLoop(loopId, "before execution"))?.loopId, loopId);
        assert.deepEqual((await db.test_messages_by_loop.all<{ body: string }>({ loop_id: loopId })).map(({ body }) => body), ["queued", "before execution"]);
        assert.equal((await db.drain_message_recipient.get<{ id: number }>({ session_id: sessionId, loop_id: loopId }))?.id, loopId);
    } finally { await db.close(); }
});

test("{§session-wait-timing}: completion between recipient lookup and insertion admits no message", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "injection-completion-race");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "original");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const query = db.drain_next_turn_seq_for_loop;
        const get = query.get.bind(query);
        t.mock.method(query, "get", async (...args: Parameters<typeof get>) => {
            const result = await get(...args);
            await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
            return result;
        });
        assert.equal(await engine.injectIntoLoop(loopId, "too late"), null);
        const messages = await db.test_messages_by_loop.all<{ body: string }>({ loop_id: loopId });
        assert.deepEqual(messages.map(({ body }) => body), ["original"]);
    } finally { await db.close(); }
});
});


describe("emission-history", () => {
const op = PlurnkParser.frame;
const note = (body: string) => op("NOTE", body);
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const previousProgram = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "assistant").map(chatMessageText).join("\n\n");
const observations = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");
const announcementOf = (turn: number): RegExp => new RegExp(
    `^### log:///1/${turn}/\\d+/emission \\(ops://writer/1/${turn}\\) · \\d+$`, "u",
);
const withHistory = async (mode: string, fn: () => Promise<void>): Promise<void> => {
    const name = "PLURNK_SERVICE_EMISSION_HISTORY";
    const previous = process.env[name];
    process.env[name] = mode;
    try { await fn(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
};

test("{§emission-history} {§packet-assembly}: each turn's operations precede their results and settled history stays a prefix", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "interpolated-history");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Write, inspect, and reply.");
    const edit = op("EDIT (workspace:///memo.md)", "Persist this exact body.");
    const read = op("READ (workspace:///memo.md)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(`${note("Memory before writing.")}\n\n${edit}`, note("Reasoning memory.")),
        say(`${read}\n\n${note("Checking what landed.")}`),
        say(op("SEND [200]", "Done.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
    const [opening, afterEdit, afterRead] = provider.received;
    assert.ok(opening && afterEdit && afterRead);
    assert.deepEqual(afterRead.map(({ role }) => role), ["system", "user", ...Array.from({ length: 2 }, () => ["assistant", "user"]).flat()]);
    assert.deepEqual(afterRead.filter(({ role }) => role === "assistant").map(chatMessageText), [`${note("Memory before writing.")}\n\n${edit}`, `${read}\n\n${note("Checking what landed.")}`]);
    for (const [index, operations] of [[2, ["NOTE", "EDIT"]], [4, ["READ", "NOTE"]]] as const) {
        assert.match(chatMessageText(afterRead[index + 1]), new RegExp(`^${operations.map((operation) => `### log:///1/\\d+/\\d+/${operation}${operation === "NOTE" ? "" : " \\(workspace:///memo\\.md\\)"} · \\d+`).join("[\\s\\S]*")}`, "u"), "the turn's receipts follow it, in order, each naming its operand");
    }
    const log = observations(afterRead);
    assert.match(log, /Reasoning memory\./u, "a reasoning NOTE is not in the program and keeps its ordinary row");
    assert.doesNotMatch(log, /Memory before writing\.|Checking what landed\./u, "authored memory appears only in assistant operations");
    assert.doesNotMatch(previousProgram(afterRead), /Reasoning memory\./u, "reasoning operations never enter content replay");
    assert.deepEqual(afterRead.slice(0, 3), afterEdit.slice(0, 3), "the earlier roles and bytes stay identical");
    // The retained results end where the status clump begins ({§packet-assembly}).
    const oldResults = chatMessageText(afterEdit[3]).split(/\n\n## (?:Git Status|Context|Session)\n/u)[0];
    assert.ok(chatMessageText(afterRead[3]).startsWith(oldResults), "new observations append after retained results");
});

for (const mode of ["none", "latest", "all"]) {
    test(`{§emission-history}: ${mode} replays operations without changing execution or source evidence`, async () => withHistory(mode, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `history-${mode}`);
            const sessionId = await insertSession(db, workspaceId, null, "writer");
            const loopId = await insertLoop(db, sessionId, 1, "Edit, inspect, and reply.");
            const firstNote = note("First memory.");
            const first = `${firstNote}\n\n${op("EDIT (workspace:///memo.md)", "Actual replacement.\nLast line.")}`;
            const secondNote = note("Second memory.");
            const second = `${op("READ (workspace:///memo.md)", null)}\n\n${secondNote}`;
            const final = op("SEND [200]", "Done.");
            const provider = new Mock({ contextWindow: 100000, responses: [
                say(first, note("Reasoning memory.")), say(second), say(final),
            ] });
            const schemes = new SchemeRegistry();
            const result = await new Engine({ db, schemes }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 3, "replay neither executes programs again nor changes the loop");
            assert.equal(previousProgram(provider.received[0]), "");
            assert.equal(previousProgram(provider.received[1]), mode === "none" ? "" : first);
            assert.equal(previousProgram(provider.received[2]), mode === "none" ? "" : mode === "latest" ? second : `${first}\n\n${second}`);
            const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
            assert.equal(source?.content, first, "replay never changes addressable evidence");
            const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
            const packet = await builder.buildRequestPacket({ workspaceId, sessionId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(packet)), mode === "all" ? `${first}\n\n${second}\n\n${final}` : mode === "latest" ? final : "", "a concluding SEND remains a whole operation");
            assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0));
            const nextLoop = await insertLoop(db, sessionId, 2, "New request.");
            const next = await builder.buildRequestPacket({ workspaceId, sessionId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(next)), mode === "all" ? `${first}\n\n${second}\n\n${final}` : mode === "latest" ? final : "", "replay spans loops of the same session");
            if (mode !== "all") assert.match(observations(PacketWire.packetToWireMessages(next)), /First memory\./u, "a NOTE of a turn that is not replayed renders as an ordinary row");
        } finally { await db.close(); }
    }));
}

test("{§emission-history}: all replays sanitized active emissions across a reasoning-only turn, a partial parse recovery, and an unclosed-only turn", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-eligibility");
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Work.");
        const kept = note("Kept finding.");
        const partial = note("Partial program.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(`${kept}\n\n${op("SEND", "Progress update.")}`), say("", note("Reasoning memory.")),
            say(`${partial}\n\n\`\`\`READ (unclosed`),
            say("```READ (unclosed"),
            say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 6, maxStrikes: 3 });
        assert.equal(provider.received.length, 5);
        assert.equal(previousProgram(provider.received[1]), `${kept}\n\n${op("SEND", "Progress update.")}`);
        assert.equal(previousProgram(provider.received[2]), `${kept}\n\n${op("SEND", "Progress update.")}`);
        assert.equal(previousProgram(provider.received[3]), `${kept}\n\n${op("SEND", "Progress update.")}\n\n${partial}`, "a turn with an admitted statement and an unclosed tail replays its sanitized emission");
        assert.equal(previousProgram(provider.received[4]), `${kept}\n\n${op("SEND", "Progress update.")}\n\n${partial}`, "a turn with no admitted statement writes no emission and leaves prior emissions intact");
    } finally { await db.close(); }
}));

test("{§emission-history}: retiring an emission removes only that turn's replay, and its NOTEs return to the log as rows", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-curation");
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Work.");
        const firstNote = note("First finding.");
        const secondNote = note("Second finding.");
        const curate = op("KILL (log:///1/2/*/emission)", null);
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(`${firstNote}\n\n${op("SEND", "First progress update.")}`), say(`${secondNote}\n\n${op("SEND", "Second progress update.")}`), say(curate), say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        assert.equal(previousProgram(provider.received[2]), `${firstNote}\n\n${op("SEND", "First progress update.")}\n\n${secondNote}\n\n${op("SEND", "Second progress update.")}`);
        assert.equal(previousProgram(provider.received[3]), `${secondNote}\n\n${op("SEND", "Second progress update.")}`, "curation removes the retired turn's replay without replaying the successful curation KILL itself");
        const request = provider.received[3];
        const index = request.findIndex(({ role }) => role === "assistant");
        assert.match(chatMessageText(request[index - 1]).split("\n\n").at(-1)!, announcementOf(3), "the surviving turn keeps its source announcement");
        const log = observations(request);
        assert.doesNotMatch(log, /### log:\/\/\/1\/2\/\d+\/emission/u, "only the retired emission row is gone");
        assert.match(log, /### log:\/\/\/1\/2\/\d+\/NOTE · \d+\n[^\n]*\n1:First finding\./u, "the retired turn's NOTE is an ordinary row again, body and all");
        const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
        assert.equal(source?.content, `${firstNote}\n\n${op("SEND", "First progress update.")}`, "the immutable source is untouched");
    } finally { await db.close(); }
}));

test("{§emission-history}: mixed KILL targets execute normally; a retired NOTE leaves the replay, the distillation stays in the log, and sources stay readable", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "history-mixed-curation");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Draft and curate.");
    const edit = op("EDIT (workspace:///memo.md)", "Draft.");
    const first = `${edit}\n\n${note("Superseded memory.")}`;
    const mixed = op("KILL (log:///1/2/*/NOTE) (workspace:///memo.md)", null);
    const distilled = op("KILL (log:///1/2/*/EDIT)", "The draft was removed.");
    const second = `${mixed}\n\n${distilled}`;
    const provider = new Mock({ contextWindow: 100000, responses: [say(first), say(second), say(op("SEND [200]", "Done."))] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const ids = { workspaceId, sessionId, loopId };
    const result = await engine.runLoop({ ...ids, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[1]), first, "before curation the turn replays EDIT and NOTE");
    assert.equal(previousProgram(provider.received[2]), op("KILL (workspace:///memo.md)", null), "the file deletion remains; successful curation and retired operations do not replay");
    const log = observations(provider.received[2]);
    assert.doesNotMatch(log, /Superseded memory\./u, "the curated NOTE is gone from row and replay alike");
    assert.match(log, /The draft was removed\./u, "the KILL body still distills into an ordinary NOTE row");
    const missing = await clientRead(engine, db, { workspaceId, sessionId, statement: readStmt(urlPath("workspace", "/memo.md")) });
    assert.equal(missing.status, 404, "the file KILL in the mixed target executed");
    for (const [turn, original] of [[2, first], [3, second]] as const) {
        const parsed = PlurnkParser.parse(op(`READ (ops://writer/1/${turn}) <1,-1>`, null)).items[0];
        assert.ok(parsed?.kind === "statement");
        const source = await clientRead(engine, db, { workspaceId, sessionId, statement: parsed.statement });
        assert.equal(source.status, 200);
        assert.equal(source.content, original, "an explicit source READ keeps NOTE, curation, grouped targets and every body");
    }
});

test("{§emission-history} {§operator-config-precedence}: complete operations replay without parsing nested examples or replaying reasoning", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-whole");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Edit, inspect, and reply.");
    const body = "Actual replacement.\n```NOTE\nA literal nested example, not an operation.\n```\nLast line.";
    const contentNote = note("Content memory.");
    const first = [op("EDIT (workspace:///memo.md) <!-- draft memo -->", body), contentNote, op("WAIT [0]", null)].join("\n\n");
    const readNote = note("Read it back.");
    const second = `${op("READ (workspace:///memo.md)", null)}\n\n${readNote}`;
    const reasoning = `Unretained deliberation.\n\n${note("Reasoning memory.")}`;
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(first, reasoning),
        say(second), say(op("SEND [200]", "Finished.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const result = await engine.runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.deepEqual(provider.received[0].map(({ role }) => role), ["system", "user"]);
    for (const [index, request] of provider.received.slice(1).entries()) {
        assert.deepEqual(request.map(({ role }) => role), ["system", "user", ...Array.from({ length: index + 1 }, () => ["assistant", "user"]).flat()], "each replayed turn is one assistant message before its receipts");
        assert.match(chatMessageText(request[1]), /^## Log\n/u);
        assert.match(chatMessageText(request.at(-1)!), /\n\n## Session\n/u);
    }
    const [opening, afterEdit, afterRead] = provider.received.map(observations);
    assert.doesNotMatch(opening, /## Previous Emission/u);
    assert.equal(previousProgram(provider.received[1]), first, "the EDIT body and its nested example remain whole");
    assert.equal(previousProgram(provider.received[2]), `${first}\n\n${second}`, "replays accumulate in turn order");
    assert.doesNotMatch(previousProgram(provider.received[1]), /Reasoning memory/u, "reasoning operations stay in their channel");
    assert.match(afterEdit, /Reasoning memory\./u, "a reasoning NOTE persists as an ordinary row");
    assert.doesNotMatch(afterEdit, /Content memory\./u, "a paired receipt does not duplicate its authored body");
    assert.doesNotMatch(afterEdit, /"aside":"draft memo"/u, "the aside stays on the assistant emission line, not duplicated in the paired receipt");
    assert.doesNotMatch(afterEdit, /Unretained deliberation\.|\/reasoning \(reasoning:\/\//u, "automatic reasoning return is off");
    const record = afterEdit.split("\n\n").find((text) => /^### log:\/\/\/1\/2\/\d+\/emission/u.test(text))!;
    assert.ok(record);
    assert.match(record, announcementOf(2));
    assert.ok(afterRead.includes(record), "aging the replay never changes the old record's bytes or weight");
    assert.equal(Number(/ · (\d+)/u.exec(record)![1]), contentWeight(record), "the announcement charges only its own record");
    const reads = await db.test_log_entries_by_session_op_full.all<{ rx: string }>({ session_id: sessionId, op: "READ" });
    assert.ok(reads.some(({ rx }) => (JSON.parse(rx) as { content?: string }).content === body), "the actual EDIT wrote the full replacement");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, first, "the immutable source is untouched");
    const reasoningSource = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "reasoning", sequence: 0 });
    assert.equal(reasoningSource?.content, reasoning, "reasoning remains addressable without automatic return");
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ workspaceId, sessionId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(packet, "emission-history"), `${first}\n\n${second}\n\n${op("SEND [200]", "Finished.")}`, "the concluding reply remains complete");
    assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0), "each message is charged exactly once");
    const nextLoop = await insertLoop(db, sessionId, 2, "A new request.");
    const next = await builder.buildRequestPacket({ workspaceId, sessionId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(next, "emission-history"), `${first}\n\n${second}\n\n${op("SEND [200]", "Finished.")}`, "a new loop in the same session retains prior loops' active emissions");
});

for (const [name, content, reasoning, expected] of [
    ["runtime refusal", op("READ (workspace:///missing.md)", null), null, op("READ (workspace:///missing.md)", null)],
    ["syntax failure after a valid operation", `${note("admitted")}\n\n\`\`\`READ (unclosed`, null, note("admitted")],
    ["reasoning-only turn", "", note("Only reasoning."), ""],
    ["content NOTE only", note("Log memory only."), null, note("Log memory only.")],
    ["unmatched log curation", op("KILL (log:///1/1/*/READ)", null), null, op("KILL (log:///1/1/*/READ)", null)],
    ["empty turn", "", null, ""],
] as const) {
    test(`{§emission-history}: latest evaluates ${name} on the immediate turn, never an older program`, async (t) => withHistory("latest", async () => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, name);
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Work.");
        const older = note("OLDER MEMORY");
        const provider = new Mock({ contextWindow: 100000, responses: [say(`${older}\n\n${op("SEND", "Older progress.")}`), say(content, reasoning), say(op("SEND [200]", "Done."))] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(provider.received.length, 3);
        assert.equal(previousProgram(provider.received[1]), `${older}\n\n${op("SEND", "Older progress.")}`);
        assert.equal(previousProgram(provider.received[2]), expected);
    }));
}

for (const mode of ["latest", "all"]) test(`{§emission-history}: ${mode} never replays an exhausted rejected turn`, async (t) => withHistory(mode, async () => {
    const limit = process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
    process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS = "1";
    t.after(() => {
        if (limit === undefined) delete process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
        else process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS = limit;
    });
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-rejected");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Work.");
    const older = note("Old memory.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(`${older}\n\n${op("SEND", "Old admitted program.")}`),
        say(`### log:///1/2/9/READ\nInvented receipt.\n\n${note("Rejected program.")}`),
        say(op("SEND [200]", "Done.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const args = { workspaceId, sessionId, loopId, provider, messages: [] };
    await engine.runTurn(args);
    const rejected = await engine.runTurn(args);
    assert.equal(rejected.emissionExhausted, true);
    await engine.runTurn(args);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[2]), mode === "all" ? `${older}\n\n${op("SEND", "Old admitted program.")}` : "");
    assert.doesNotMatch(observations(provider.received[2]) + previousProgram(provider.received[2]), /Rejected program\./u, "a rejected attempt's NOTE is nowhere");
}));
});

describe("packet-assembled", () => {
const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string; header: string | null; content: string; weight: number }> }> =>
    JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);

test("{§execution-output-identity}: assembled receipts and child inventory identify anonymous WORK and FORK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-anonymous-sessions-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "delegate two reviews");
        const children: number[] = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            injectSession: async (args) => {
                children.push(args.sessionId);
                const history = await db.test_fork_loops.all({ session_id: args.sessionId });
                const childLoopId = await insertLoop(db, args.sessionId, history.length + 1, args.prompt);
                return { action: "enqueued_new_loop", loopId: childLoopId, message: `message://child/${childLoopId}` };
            },
        });
        const parsed = PlurnkParser.parseStatements([
            PlurnkParser.frame("WORK", "Review the files."),
            PlurnkParser.frame("FORK", "Review the reasoning."),
        ].join("\n"), { executors: fixtureExecutors([
            PlurnkParser.frame("WORK", "Review the files."),
            PlurnkParser.frame("FORK", "Review the reasoning."),
        ].join("\n")) });
        assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
        const branches = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [...branches, noteStmt("Continue.")] } },
                { assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } },
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        const receipts = logEntries(packet).filter(({ logPath: path }) => /\/(WORK|FORK)$/.test(path));
        assert.equal(receipts.length, 2);
        const names = await Promise.all(children.map(async (id) => (await db.session_get.get<{ name: string }>({ id }))!.name));
        assert.equal(new Set(names).size, 2);
        const pointers = packetSection(packet, "work");
        for (const [index, name] of names.entries()) {
            assert.match(name, /^[a-f0-9]{8}$/);
            assert.equal(receipts[index]?.session, `session://${name}`, "the outcome address is visible beside the spawning operation");
            assert.equal(receipts[index]?.path, undefined, "no address is invented for the authored operand");
            assert.ok(pointers.includes(`session://${name}`), "the same identity appears in the ordinary live-child inventory");
        }
        assert.match(String(receipts[0]?.body), /Review the files\./);
        assert.match(String(receipts[1]?.body), /Review the reasoning\./);
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} assembled packet: editable READ lines carry copyable anchors without changing their visible ordinals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-line-anchor-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect notes");
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const target = urlPath("workspace", "/anchored.md");
        const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [
                    editStmt(target, source),
                    readStmt(target, { marks: [9, 10] }),
                    noteStmt("Continue."),
                ] } },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });

        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const read = logEntries(await getPacket(db, second.turnId)).find((entry) =>
            entry.path === "workspace:///anchored.md"
            && typeof entry.logPath === "string"
            && entry.logPath.endsWith("/READ"));
        assert.equal(read?.path, "workspace:///anchored.md");
        assert.match(String(read?.body), /^ *9<@[0-9A-Za-z]{5}>line 9\n *10<@[0-9A-Za-z]{5}>line 10\n$/);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} assembled packet: landed EDIT receipts expose causal parser-recovery evidence only when relevant", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-edit-parse-issues-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "edit Go sources");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const brokenTarget = urlPath("workspace", "/broken.go");
        const cleanTarget = urlPath("workspace", "/clean.go");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [
                    editStmt(brokenTarget, "package sample\nfunc broken("),
                    editStmt(cleanTarget, "package sample\nfunc valid() {}"),
                    noteStmt("Continue."),
                ] } },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });

        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const edits = logEntries(await getPacket(db, second.turnId)).filter((entry) =>
            typeof entry.logPath === "string" && entry.logPath.endsWith("/EDIT"));
        const broken = edits.find((entry) => entry.path === "workspace:///broken.go");
        const clean = edits.find((entry) => entry.path === "workspace:///clean.go");
        assert.match(String(broken?.parseIssues), /^0->[1-9]\d*$/);
        assert.equal(clean !== undefined && "parseIssues" in clean, false);
    } finally { await db.close(); }
});

test("{§capability-admission}: packet assembly surfaces invalid workspace policy", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: { deny: "invalid" } }) });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }],
        });

        await assert.rejects(
            engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Workspace ${workspaceId} has invalid persisted capability policy.`);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    } finally { await db.close(); }
});

test("{§session-initialization-entry} assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist markerless shallow maps at turn 0
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-backbone-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "subject");
        const loopId = await insertLoop(db, sessionId, 1, "what do I have?"); // {§session-initialization-entry}: first loop foists
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/nested/deep.md", channel: "body", content: "nested", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/.env.defaults", channel: "body", content: "KNOB=1", mimetype: "text/plain" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/.github/settings.yml", channel: "body", content: "setting: true", mimetype: "text/yaml" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const rows = await db.test_log_entries_by_loop.all<{ id: number; op: string | null; origin: string; tx: string; rx: string; attrs: string }>({ loop_id: loopId });
        const foists = rows
            .filter((row) => row.origin === "_plurnk" && (row.op === "FIND" || row.op === "READ") && !LogEntryProjection.isEmission(row));
        assert.ok(foists.length > 0, "the first turn persists its structural observation foists");
        const sources = await db.test_turn_sources.all<{ kind: string; producer: string; content: string }>({ session_id: sessionId });
        const turnSource = sources.find(({ kind, producer }) => kind === "ops" && producer === "_plurnk");
        assert.ok(turnSource, "initialization stores its exact program as its ops source ({§session-initialization-entry})");
        const source = turnSource.content;
        const sourceFoists = PlurnkParser.parseStatements(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])
            .filter(({ op }) => op === "FIND" || op === "READ");
        assert.equal(sourceFoists.length, foists.length, "the exact source accounts for every structural observation");
        for (const [index, { tx }] of foists.entries()) {
            const statement = JSON.parse(tx) as { position?: unknown };
            assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
            assert.deepEqual(
                statement.position,
                sourceFoists[index].position,
                "the dispatched statement preserves its coordinate in the exact initialization source",
            );
        }
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // The foisted FIND(workspace:///*) renders its RESULT into the log
        // ({§zero-width-column-one-insert}) — the model sees the catalog groups, not just its own
        // echoed query.
        assert.match(log, /workspace:\/\/\/note\.md/, "the foisted catalog FIND renders a direct entry into the packet's log");
        assert.match(log, /workspace:\/\/\/\.env\.defaults/, "the one-level page includes direct dot entries");
        assert.match(log, /"path":"workspace:\/\/\/\.github\/\*\*","items":1,"tokens":\d+/, "a dot directory renders as an actionable recursive summary");
        assert.match(log, /"path":"workspace:\/\/\/nested\/\*\*","items":1,"tokens":\d+/, "a directory renders as an actionable recursive summary");
        assert.doesNotMatch(log, /workspace:\/\/\/nested\/deep\.md/, "the opening map does not dump a summarized descendant");
        for (const path of [".env.defaults", ".github/**", "nested/**", "note.md"]) {
            const target = `workspace:///${path}`;
            const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.match(
                log,
                new RegExp(`\\n\\d+:\\[{1,2}\\{"path":"${escaped}`),
                `${target} begins its own universally numbered FIND row`,
            );
        }
        assert.ok(logEntries(packet).some(({ logPath: path }) => path.endsWith("/FIND")), "the catalog foist appears as a FIND op in the log address");
        const initialization = logEntries(packet)
            .filter(({ logPath: path }) => path.startsWith("log:///1/1/"));
        assert.deepEqual(
            [...new Set(initialization.map(({ logPath: path }) => path.split("/").at(-1) ?? ""))].toSorted(),
            ["FIND", "NOTE"],
            "{§session-initialization-entry}: turn 0 exposes its NOTEs and its surveys, and nothing else",
        );
        assert.equal(initialization.some(({ path: target }) => target?.startsWith("ops://") === true), false,
            "turn 0 reads none of its own program, and it announces no emission ({§turn-source-resources})");
        assert.deepEqual(provider.received[0].filter(({ role }) => role === "assistant"), []);
        const initializationOutcomes = initialization;
        assert.deepEqual(
            initializationOutcomes.filter(({ path: target }) => target !== undefined).map(({ path: target }) => target),
            ["workspace:///*", "session://subject/*"],
            "the survey with entries and the session's own scratch survey run ({§session-initialization-entry})",
        );
        assert.doesNotMatch(log, /workspace:\/\/\/_plurnk\/plurnk\/sh\.md/, "turn-0 never privileges the sh skill with an orientation READ");

    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§log-wire-format}: exact matcher FIND shows flat surgical coordinates with one compact extent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-matches-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "find the target");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/notes.md",
            channel: "body",
            content: "heading\ntarget one\ncontext\ntarget two",
            mimetype: "text/markdown",
        });

        const matchedFind = {
            ...findStmt(urlPath("workspace", "/notes.md")),
            matcher: regex("target"),
        };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [matchedFind, noteStmt("Continue.")] } },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const log = packetSection(await getPacket(db, second.turnId), "log");

        assert.match(log, /^### log:\/\/\/\S+\/FIND \(workspace:\/\/\/notes\.md\) \/target\/ · \d+$/m, "the addressed resource and matcher return on the receipt heading");
        assert.match(log, /"range":"2 match locations"/);
        assert.doesNotMatch(log, /"matchLocationCount":2/);
        assert.doesNotMatch(log, /"matchingPathCount":1/);
        // {§find-result-projection}: a location reads in the scope notation with its matched text, its default channel unnamed.
        assert.match(log, /1:\[\{"region":"<2,1,2,7>","matched":"target"\},/);
        assert.match(log, /2:\{"region":"<4,1,4,7>","matched":"target"\}\]/);
        assert.match(log, /workspace:\/\/\/notes\.md/);
    } finally { await db.close(); }
});

test("{§op-shapes} assembled packet: scoped COPY reports both operands and its landed text materialization", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-copy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "copy the selected lines");
        const source = urlPath("workspace", "/src.md");
        const destination = urlPath("workspace", "/slice.md");
        const scopedCopy = copyStmt(source, destination, { marks: [2, 3] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                {
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [
                            editStmt(source, "one\ntwo\nthree\nfour"),
                            scopedCopy,
                            scopedCopy,
                            noteStmt("Continue."),
                        ],
                    },
                },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });

        const first = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.deepEqual(first.outcomes, [
            { op: "EDIT", status: 201, problemType: null },
            { op: "COPY", status: 201, problemType: null },
            { op: "COPY", status: 304, problemType: null },
            { op: "NOTE", status: 200, problemType: null },
        ]);
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        // Turn 0 archives the prompt by COPY (log:///1/1/…); the model's two are under test.
        const copies = logEntries(packet).filter(({ logPath: path }) => path.endsWith("/COPY") && !path.startsWith("log:///1/1/"));

        assert.equal(copies.length, 2);
        assert.equal(copies[0]?.from, "workspace:///src.md");
        assert.deepEqual(copies[0]?.scope, { from: "<2,3>" });
        assert.equal(copies[0]?.to, "workspace:///slice.md");
        assert.equal(copies[0]?.status, 201);
        assert.ok(Array.isArray(copies[0]?.effects));
        const [effect] = copies[0].effects as Array<Record<string, unknown>>;
        assert.equal(effect?.path, "workspace:///slice.md");
        assert.equal(effect?.action, "create");
        assert.equal(Object.hasOwn(effect ?? {}, "rev"), false, "no revision token in the packet");
        assert.equal(effect?.extent, "lines 0->2");
        assert.equal(effect?.change, "lines -0 +2");
        assert.equal(effect?.effect, "<1,1,1,1> -> <1,2>");
        assert.ok(copies[0] !== undefined && "body" in copies[0], "the landed materialization is open (body present, #338)");
        assert.equal(copies[1]?.from, "workspace:///src.md");
        assert.deepEqual(copies[1]?.scope, { from: "<2,3>" });
        assert.equal(copies[1]?.to, "workspace:///slice.md");
        assert.equal(copies[1]?.status, 304);
        assert.equal(copies[1]?.effects, undefined);
        assert.ok(copies[1] !== undefined && !("body" in copies[1]), "the whole-channel effect has no text body (#338)");

        assert.match(packetSection(packet, "log"), /1(?:<@[0-9A-Za-z]{5}>|:)two\n2(?:<@[0-9A-Za-z]{5}>|:)three/);
    } finally { await db.close(); }
});

test("{§packet-assembly} the initial wire preserves canonical order and the Recap override without invented history", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-monotone-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({
            provider,
            recap: "CUSTOM_RECAP_SENTINEL",
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = await getPacket(db, result.turnId);

        // {§packet-assembly}: trusted control-plane sections precede the user slot;
        // append-mostly history precedes per-turn status, open message pointers and Recap.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system"), ["definition", "system-policy"], "the stable system prefix has no injected resource catalog");
        assert.deepEqual(slot("user"), ["log", "git", "budget", "session", "work", "notices", "errors", "recap"]);
        assert.deepEqual(slot("assistant"), []);
        assert.equal(packet.sections.find((section) => section.name === "work")?.header, "Open Work");
        assert.equal(packet.sections.find((section) => section.name === "budget")?.header, "Context");
        assert.equal(packetSection(packet, "recap"), "CUSTOM_RECAP_SENTINEL", "{§packet-inject}: the override replaces the source; no recap line ships ahead of it");
        assert.equal(packetSection(packet, "emission-history"), "", "the first turn has no previous program");
    } finally { await db.close(); }
});

test("{§packet-inject} no recap line ships and the recap source is empty, so a packet has no Recap", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-recap-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = await getPacket(db, result.turnId);

        assert.equal(await readFile(Paths.defaultRecap, "utf8"), "", "{§packet-inject}: the shipped recap source stays empty");
        assert.equal(packetSection(packet, "recap"), "", "{§packet-inject}: no line ships, so the packet has no Recap");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization} assembled packet: the skills foist surfaces the Session's materialized skills into its log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-docs-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // A materialized scheme doc is an ordinary entry owned by the Session
        // whose effective Functionality it describes.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/_plurnk/plurnk/session.md", channel: "body", content: "# session\n\n## Summary\n\nManage shared session entries.\n\n## Invocation\n\n````EDIT (workspace:///notes.md)\nNotes.\n````", mimetype: "text/markdown" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const log = packetSection(await getPacket(db, result.turnId), "log");

        // The materialized doc reaches the model through its private FIND, not
        // an inline packet link ({§tools-resource-materialization}).
        assert.match(log, /^### log:\/\/\/\S+\/FIND \(workspace:\/\/\/_plurnk\/plurnk\/\*\.md\) · \d+$/m, "the foist scopes discovery to the Session's skills tree");
        assert.match(log, /workspace:\/\/\/_plurnk\/plurnk\/session\.md/, "the materialized skill surfaces in the foist's rendered result");
        assert.match(log, /"aside":"Manage shared session entries\."/, "the catalog projects the document's Summary without opening its body");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§session-initialization-entry} assembled packet: a reference catalog with nothing materialized is left out of turn 0, which still completes", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-empty-docs-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string | null; pathname: string }>({ loop_id: loopId });
        assert.equal(rows.some((row) => row.op === "FIND" && row.scheme === "workspace" && row.pathname === "/_plurnk/plurnk/*.md"), false,
            "the reference survey that would select nothing is left out");
        assert.ok(rows.some((row) => row.origin === "model" && row.op === "SEND"), "and the model's turn still runs and completes");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§operator-config-precedence}: the provider packet excludes personal XDG policy", async (t) => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const priorConfig = process.env.XDG_CONFIG_HOME;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-gate-policy-"));
    t.after(async () => {
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorConfig;
        await rm(dir, { recursive: true, force: true });
    });
    await mkdir(join(dir, "plurnk"));
    const personal = "# Personal rules\nDOGFOOD_ONLY_SENTINEL";
    const path = join(dir, "plurnk", "AGENTS.md");
    await writeFile(path, personal);
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.PLURNK_SERVICE_POLICY;
    const profile = parseEnv(await readFile(new URL("../../.env.test", import.meta.url), "utf8"));
    if (profile.PLURNK_SERVICE_POLICY !== undefined) process.env.PLURNK_SERVICE_POLICY = profile.PLURNK_SERVICE_POLICY;
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `pkt-gate-policy-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
    const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "fixture language" }, { role: "user", content: "go" }] });
    const packet = await getPacket(db, result.turnId);
    assert.ok(provider.received.length > 0, "the real packet reaches the provider");
    const system = provider.received.flat().filter(({ role }) => role === "system").map((message) => chatMessageText(message)).join("\n");
    assert.match(system, /fixture language/);
    assert.doesNotMatch(system, /DOGFOOD_ONLY_SENTINEL/);
    assert.equal(packet.sections.find(({ name }) => name === "system-policy")?.content, "", "the policy slot contributes no content");
    assert.equal(await readFile(path, "utf8"), personal, "daily-driving policy remains untouched");
});

test("{§session-initialization-entry} assembled packet: PLURNK_SERVICE_POLICY renders the single privileged system-slot policy section", async () => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-policy-"));
    const db = await openMigrated();
    try {
        const sysPath = join(dir, "system-AGENTS.md");
        await writeFile(sysPath, "# House rules\nNEVER guess a file path.");
        process.env.PLURNK_SERVICE_POLICY = sysPath;

        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // Policy is the client's foot in the privileged zone — the system slot
        // carries the operator's authoritative rules. Project guidance
        // rides turn 0 as the foisted AGENTS.md entry ({§session-initialization-entry}).
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system"), ["definition", "system-policy"], "PLURNK_SERVICE_POLICY rides the system slot — privileged, not a READable entry");
        assert.equal(packetSection(packet, "system-policy"), "# House rules\nNEVER guess a file path.", "the authored policy content is preserved");
        assert.equal(packet.sections.find(({ name }) => name === "system-policy")?.header, null, "the policy owns its heading");
        const systemMessage = provider.received[0].filter(({ role }) => role === "system").map((message) => chatMessageText(message)).join("\n");
        assert.match(systemMessage, /# House rules\nNEVER guess a file path\./, "the authored heading reaches the provider");
        assert.doesNotMatch(systemMessage, /^## Policy$/m, "the engine adds no enclosing policy heading");
    } finally {
        await db.close();
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§packet-inject} {§host-path-layout} unset PLURNK_SERVICE_POLICY composes $XDG_CONFIG_HOME/agents/AGENTS(.local)?.md, ~/.agents/AGENTS(.local)?.md, and $XDG_CONFIG_HOME/plurnk/AGENTS(.local)?.md in order", async (t) => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-policy-cascade-"));
    const db = await openMigrated();
    t.after(async () => {
        await db.close();
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        await rm(dir, { recursive: true, force: true });
    });
    const hostPaths = new HostPaths({
        home: join(dir, "home"),
        env: { XDG_CONFIG_HOME: join(dir, "config") },
    });
    await mkdir(hostPaths.xdgAgentsDir, { recursive: true });
    await mkdir(hostPaths.globalAgentsDir, { recursive: true });
    await mkdir(hostPaths.configDir, { recursive: true });
    await writeFile(hostPaths.xdgPolicyFile, "# XDG global rules");
    await writeFile(hostPaths.xdgLocalPolicyFile, "# XDG local rules");
    await writeFile(hostPaths.globalPolicyFile, "# Home global rules");
    await writeFile(hostPaths.globalLocalPolicyFile, "# Home local rules");
    await writeFile(hostPaths.policyFile, "# Plurnk rules");
    await writeFile(hostPaths.localPolicyFile, "# Plurnk local rules");
    delete process.env.PLURNK_SERVICE_POLICY;

    const workspaceId = await insertWorkspace(db, `pkt-policy-cascade-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, hostPaths });
    const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
    const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
    const packet = await getPacket(db, result.turnId);
    assert.equal(
        packetSection(packet, "system-policy"),
        "# XDG global rules\n\n# XDG local rules\n\n# Home global rules\n\n# Home local rules\n\n# Plurnk rules\n\n# Plurnk local rules",
    );
});

test("{§child-orientation} the live things a session holds — child sessions — surface as terse pointers in the status clump", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-orient-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // A live child session this session holds (parent_session_id = sessionId; insertLoop's default status 102 = live).
        const child = await insertSession(db, workspaceId, sessionId, "session-x");
        await insertLoop(db, child, 1, "working");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The live child surfaces as a terse status+path pointer under `sessions` — orienting state, not advice.
        assert.match(packetSection(packet, "work"), /^\{"sessions":\[\{"status":102,"path":"session:\/\/session-x"\}\],\n"streams":\[\],\n"messages":\[\{"path":"message:\/\/[^/]+\/[0-9a-f]{8}","origin":"user"\}\]\}$/, "the live child session is a status+path pointer the model READs/KILLs itself");
        const usr = packet.sections.filter((x) => x.slot === "user").map((x) => x.name);
        assert.ok(usr.includes("work"), "{§child-orientation}: open work rides the status clump");
    } finally { await db.close(); }
});

test("{§child-orientation} no live children, streams, or messages → Open Work states every list as empty", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-orient-empty-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("ok")] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }] });
        // {§child-orientation} — Open Work states emptiness as `[]` for every list: the model
        // decides wait-or-complete on them, so it never infers "none" from a missing heading.
        const packet = await getPacket(db, result.turnId);
        assert.equal(packetSection(packet, "work"), '{"sessions":[],\n"streams":[],\n"messages":[]}', "no live children, no open streams, no open or sent messages → all three lists state []");
    } finally { await db.close(); }
});

test("{§packet} assembled packet: definition tables compact without changing other whitespace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-definition-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const definition = [
            "# Definition",
            "",
            "| OP     | purpose                 |",
            "|:-------|------------------------:|",
            "| FIND   | list matching paths     |",
            "| `A \\| B` | preserve escaped pipes |",
            "| ------- | data dashes stay intact  |",
            "",
            "```text",
            "| fenced   | content   |",
            "```",
            "",
            "Prose  spacing remains exact.",
        ].join("\n");
        const expected = [
            "# Definition",
            "",
            "| OP | purpose |",
            "|:---|---:|",
            "| FIND | list matching paths |",
            "| `A \\| B` | preserve escaped pipes |",
            "| ------- | data dashes stay intact |",
            "",
            "```text",
            "| fenced   | content   |",
            "```",
            "",
            "Prose  spacing remains exact.",
        ].join("\n");

        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: definition }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        assert.equal(packetSection(packet, "definition"), expected, "the stored model-facing definition is the compact projection");
        assert.equal(packet.sections.find((section) => section.name === "definition")?.weight, contentWeight(expected), "definition render-weight measures the compact projection");
    } finally { await db.close(); }
});

test("{§packet}: canonical operation examples survive packet projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-definition-grammar-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const definition = await readFile(Paths.instructionsSystem, "utf8");

        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: definition }, { role: "user", content: "go" }] });
        const projected = packetSection(await getPacket(db, result.turnId), "definition");
        const codeBlocks = (markdown: string) => Lexer.lex(markdown)
            .flatMap((token) => token.type === "code" ? [token.text] : []);
        const examples = codeBlocks(definition);
        assert.ok(examples.length > 0, "canonical definition contains operation examples");
        assert.deepEqual(codeBlocks(projected), examples, "packet projection preserves every example's fences and body whitespace");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization}: the assembled packet retains the definition without a second resource catalog", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-shape-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The grammar (plurnk.md) must reach the model — a dropped definition section is a dead packet.
        assert.ok(packetSection(packet, "definition").length > 0, "the definition (grammar) section carries content");
        assert.deepEqual(packet.sections.filter(({ slot }) => slot === "system").map(({ name }) => name), ["definition", "system-policy"]);
    } finally { await db.close(); }
});
});

describe("packet-extension", () => {
test("{§emission-history} extension packet control: a scheme adds, removes, and reorders packet sections", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-extension-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const schemes = new SchemeRegistry();
        const inspected: PacketSectionDraft[][] = [];
        // A third-party extension: prepend its own section, drop the kernel's budget.
        schemes.register("demo", {
            manifest: {
                name: "demo",
                channels: {},
                defaultChannel: "",
                category: "control",
                writableBy: [],
                volatile: false,
                modelVisible: false,
            },
            transformSections(sections: PacketSectionDraft[]): PacketSectionDraft[] {
                inspected.push(structuredClone(sections));
                return [
                    { name: "demo", slot: "user", header: "Demo Extension", content: "hello from the extension" },
                    ...sections.filter((s) => s.name !== "budget"),
                ];
            },
        });
        const engine = new Engine({ db, schemes });
        // {§emission-history}: the transform receives each turn's operations before their results.
        const programs = [
            `${PlurnkParser.frame("EDIT (workspace:///memo.md)", "Kept whole.")}\n\n${PlurnkParser.frame("NOTE", "Wrote the memo.")}`,
            `${PlurnkParser.frame("READ (workspace:///memo.md)", null)}\n\n${PlurnkParser.frame("NOTE", "Read it back.")}`,
            PlurnkParser.frame("SEND [200]", "Done."),
        ];
        const provider = new Mock({ contextWindow: 100000, responses: programs.map((content) => ({ assistant: { content, reasoning: null } })) });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);

        // ADD: the extension's section is in the packet, carrying its content.
        assert.equal(packetSection(packet, "demo"), "hello from the extension");
        const demo = (packet.sections as StoredPacketSection[]).find((section) => section.name === "demo");
        assert.ok(demo !== undefined);
        assert.equal(demo.weight, contentWeight(PacketWire.renderSection(demo)), "core assigns the durable render-weight");
        // REMOVE: the kernel's budget section is gone.
        assert.equal(packetSection(packet, "budget"), "");
        // REORDER: the extension's section leads the user slot.
        const userOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "user").map((s) => s.name);
        assert.equal(userOrder[0], "demo", "extension section leads the user slot");
        assert.ok(!userOrder.includes("budget"), "budget removed from the user slot");
        for (let turn = 0; turn < 2; turn++) await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const chronological = inspected.find((sections) => sections.filter(({ slot }) => slot === "assistant").length === 2);
        assert.ok(chronological, "the transform receives the complete interpolated history");
        const expected = programs.slice(0, 2);
        assert.deepEqual(chronological.filter(({ slot }) => slot === "assistant").map(({ content }) => content), expected);
        for (const [index, section] of chronological.entries()) {
            if (section.slot !== "assistant") continue;
            const receipt: PacketSectionDraft = chronological[index + 1];
            assert.equal(receipt.slot, "user");
            assert.match(receipt.content, /^### log:\/\/\/\d+\/\d+\/\d+\/(?:EDIT|READ) \(\S+\) · \d+/u, "every turn is followed by its receipts, each naming its operand");
        }
        assert.equal(provider.received.length, 3);
        const last = provider.received[2];
        assert.deepEqual(last.filter(({ role }) => role === "assistant").map(chatMessageText), expected);
        assert.match(chatMessageText(last[3]), /^### log:\/\/\/1\/2\/\d+\/EDIT/u, "transformed packets retain the chronological result boundary");
        assert.doesNotMatch(last.map(chatMessageText).join("\n"), /## Context\n/u, "the transform still removes the requested section");
    } finally { await db.close(); }
});

test("{§packet-assembly} extension packet control: duplicate section names fail at the owning scheme boundary", async () => {
    const schemes = new SchemeRegistry();
    schemes.register("broken", {
        manifest: {
            name: "broken",
            channels: {},
            defaultChannel: "",
            category: "control",
            writableBy: [],
            volatile: false,
            modelVisible: false,
        },
        transformSections(): PacketSectionDraft[] {
            return [
                { name: "duplicate", slot: "user", header: null, content: "first" },
                { name: "duplicate", slot: "user", header: null, content: "second" },
            ];
        },
    });

    await assert.rejects(
        schemes.transformSections([]),
        /scheme 'broken' transformSections result has duplicate section name 'duplicate'/,
    );
});
});

describe("packet-inject", () => {
test("{§packet-inject} PLURNK_SERVICE_PACKET_INJECT: operator file rides as a system section after policy", async () => {
    const db = await openMigrated();
    const dir = await mkdtemp(join(tmpdir(), "plurnk-inject-intg-"));
    const prior = process.env.PLURNK_SERVICE_PACKET_INJECT;
    try {
        await writeFile(join(dir, "ops.md"), "## House style\nPrefer sqlite over node.");
        process.env.PLURNK_SERVICE_PACKET_INJECT = join(dir, "ops.md");

        const workspaceId = await insertWorkspace(db, `inject-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });

        const { turnId } = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: "go" }],
        });

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        assert.match(packetSection(packet, "inject"), /Prefer sqlite over node/, "the operator file is the inject section's content");
        const sysOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "system").map((s) => s.name);
        assert.equal(sysOrder.indexOf("inject"), sysOrder.indexOf("system-policy") + 1, "inject follows privileged policy");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_PACKET_INJECT; else process.env.PLURNK_SERVICE_PACKET_INJECT = prior;
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("packet-items", () => {
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const RECORDS = ["### log:///1/1/1/FIND\n{\"status\":200}\n1:[]", "### log:///1/1/2/READ\n{\"status\":200}\n1:alpha\n2:beta"];
const packet = (records: readonly string[], prompt: string): DurablePacket => ({
    weight: 7,
    sections: [
        { name: "definition", slot: "system", header: null, content: "# Plurnk", weight: 2 },
        { name: "log", slot: "user", header: "Log", content: records.join("\n\n"), weight: 4, items: records },
        { name: "work", slot: "user", header: "Open Work", content: prompt, weight: 1 },
    ],
    attributions: ["session://a"],
});

test("{§packet}: a turn stores only the items the previous turn did not, and reads back exactly", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const first = packet(RECORDS.slice(0, 1), "[{\"path\":\"log:///1/1/1/SEND\"}]");
        const second = packet(RECORDS, "[{\"path\":\"log:///1/1/1/SEND\"}]");
        const firstId = await insertPacketTurn(db, loopId, 1, first, 102);
        const before = (await db.test_packet_item_count.get<{ n: number }>({}))!.n;
        assert.equal(before, 3, "turn 1: definition, one log record, prompt");
        const secondId = await insertPacketTurn(db, loopId, 2, second, 200);
        const after = (await db.test_packet_item_count.get<{ n: number }>({}))!.n;
        assert.equal(after - before, 1, "turn 2 added exactly its new log record; every other block was already stored");

        const items = await db.test_turn_items.all<{ section: number; position: number; item_hash: string; text: string }>({ turn_id: secondId });
        assert.deepEqual(items.map(({ section, position, text }) => ({ section, position, text })), [
            { section: 0, position: 0, text: "# Plurnk" },
            { section: 1, position: 0, text: RECORDS[0] },
            { section: 1, position: 1, text: RECORDS[1] },
            { section: 2, position: 0, text: "[{\"path\":\"log:///1/1/1/SEND\"}]" },
        ]);
        assert.ok(items.every(({ item_hash, text }) => item_hash === sha256(text)), "an item's address is the SHA-256 of its text");

        for (const [id, expected] of [[firstId, first], [secondId, second]] as const) {
            const row = await db.test_get_packet.get<{ packet: string }>({ id });
            const parsed = StoredPacket.parse(row!.packet, `turn ${id}`);
            assert.deepEqual(parsed, { ...expected, sections: expected.sections.map(({ items: _items, ...section }) => section) }, "the assembled packet is the stored packet, sections included, without the items key");
        }
        const bag = await db.test_bag_of_turn.get<{ packet: string }>({ id: secondId });
        assert.equal(JSON.parse(bag!.packet).sections, undefined, "the bag in turns.packet carries no sections");
    } finally { await db.close(); }
});

test("{§packet}: the write view refuses a turn that is not an open model inference turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-refuse-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const done = await insertPacketTurn(db, loopId, 1, packet(RECORDS, "[]"), 200);
        await assert.rejects(
            () => Turn.recordInference(db, done, { packet: StoredPacket.stringify(packet([], "[]")), sections: StoredPacket.sections(packet([], "[]")), usageCurationBudget: null, finishReason: null, model: "m", meta: "{}" }),
            /turn is not an open model inference turn/,
        );
    } finally { await db.close(); }
});

test("{§packet}: items nothing references are collected; shared items survive", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-collect-${crypto.randomUUID()}`);
        const keeper = await insertSession(db, workspaceId, null, "keeper");
        const leaver = await insertSession(db, workspaceId, null, "leaver");
        await insertPacketTurn(db, await insertLoop(db, keeper, 1, "k"), 1, packet(RECORDS.slice(0, 1), "[\"k\"]"), 200);
        await insertPacketTurn(db, await insertLoop(db, leaver, 1, "l"), 1, packet(RECORDS, "[\"l\"]"), 200);
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 5, "definition + two records + two prompts");
        await db.test_delete_session.run({ id: leaver });
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 5, "deletion cascades the composition, not the items");
        await db.retention_collect_packet_items.run({ collect: 1 });
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 3, "the leaver's own record and prompt are collected; the shared definition and record stay");
    } finally { await db.close(); }
});
});

describe("workspace-prompts", () => {
const send = () => makeMockResponse("````SEND [200]\nok\n````", 50);
const addressed = (thread: string, id: string) => {
    const address = `acp://operator/threads/${thread}/messages/${id}`;
    return { source: address, messageAddress: address };
};

test("{§methods-workspace-create}: workspace prompts are newest-first and limit-capped", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompts-hist" });
            await runLoopToTerminal(ws, 2, { prompt: "first prompt", ...addressed("prompts-hist", "1") });
            await runLoopToTerminal(ws, 3, { prompt: "second prompt", ...addressed("prompts-hist", "2") });

            // Defaults to the attached workspace; newest-first.
            const all = await rpcCall(ws, 4, "workspace.prompts", {});
            assert.deepEqual(
                (all.result as { prompts: string[] }).prompts,
                ["second prompt", "first prompt"],
                "newest-first over the attached workspace's user prompts (no archaeology)",
            );

            // limit caps to the newest N.
            const capped = await rpcCall(ws, 5, "workspace.prompts", { limit: 1 });
            assert.deepEqual((capped.result as { prompts: string[] }).prompts, ["second prompt"], "limit caps to the newest N");

            // Malformed limit fails hard — no silent default.
            const bad = await rpcCall(ws, 6, "workspace.prompts", { limit: 0 });
            const problem = rpcProblem(bad);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/limit-invalid");
            assert.equal(problem.value, 0);
            assert.equal(problem.recovery, "Use a positive integer limit."); // {§operation-results}

            // A malformed sessionId fails the same way.
            const badSession = rpcProblem(await rpcCall(ws, 7, "workspace.prompts", { sessionId: 0 }));
            assert.equal(badSession.type, "https://problems.plurnk.xyz/daemon/input/identifier-invalid");
            assert.equal(badSession.field, "sessionId");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a client prompt at a forked model session is that session's history, not the crack", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send(), send()] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-fork" });
            const workspaceId = (created.result as { id: number }).id;
            const mainSession = await namedModelSession(daemon, workspaceId, "main");
            await runLoopToTerminal(ws, 2, { prompt: "typed at main", sessionId: mainSession, ...addressed("main", "1") });

            // The TUI's /session + /attach flow: a fork of the thread's session, bound by name, seeded by a human.
            const research = await daemon.forkSession({ workspaceId, sessionId: mainSession, name: "research" });
            await runLoopToTerminal(ws, 3, { prompt: "typed at the research fork", sessionId: research.sessionId, ...addressed("research", "1") });
            await runLoopToTerminal(ws, 4, { prompt: "typed at the research fork again", sessionId: research.sessionId, ...addressed("research", "2") });

            const scopedToFork = await rpcCall(ws, 5, "workspace.prompts", { sessionId: research.sessionId });
            assert.deepEqual(
                (scopedToFork.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork"],
                "the forked session's own human prompts are its history, newest-first",
            );
            const scopedToMain = await rpcCall(ws, 6, "workspace.prompts", { sessionId: mainSession });
            assert.deepEqual(
                (scopedToMain.result as { prompts: string[] }).prompts,
                ["typed at main"],
                "the forked session's parent keeps its own history, without the fork's prompts",
            );
            const unscoped = await rpcCall(ws, 7, "workspace.prompts", {});
            assert.deepEqual(
                (unscoped.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork", "typed at main"],
                "an omitted sessionId lists every model session's client-addressed seeds",
            );
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a seed nobody addressed — a session-issued task — is never history", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-authorship" });
            const workspaceId = (created.result as { id: number }).id;
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await runLoopToTerminal(ws, 2, { prompt: "a human asked this", sessionId, ...addressed("main", "1") });
            // A session-issued seed carries the issuing session as its source and no message address
            // ({§message-arrival}); the seam admits the same shape.
            const task = await runLoopToTerminal(ws, 3, { prompt: "a session delegated this", sessionId, source: "session://exampleSessionName" });
            const seed = await db.test_loop_seed_message.get<{ address: string | null; source: string | null }>({ loop_id: task.loopId });
            assert.deepEqual(seed, { address: null, source: "session://exampleSessionName" }, "the fixture wrote an unaddressed, session-sourced seed");

            const history = await rpcCall(ws, 4, "workspace.prompts", { sessionId });
            assert.deepEqual((history.result as { prompts: string[] }).prompts, ["a human asked this"], "the delegated task is not in the session's history");
        } finally { ws.close(); }
    });
});
});

