import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText, type ChatMessage } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { readStmt, urlPath } from "./_dsl.ts";
import { clientRead } from "./_client-read.ts";

const op = PlurnkParser.frame;
const note = (body: string) => op("NOTE", body);
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const previousProgram = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "assistant").map(chatMessageText).join("\n\n");
const observations = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");
const announcementOf = (turn: number): RegExp => new RegExp(
    `^### log:///1/${turn}/\\d+/emission → ops://writer/1/${turn} · \\d+$`, "u",
);
const withHistory = async (mode: string, fn: () => Promise<void>): Promise<void> => {
    const name = "PLURNK_SERVICE_EMISSION_HISTORY";
    const previous = process.env[name];
    process.env[name] = mode;
    try { await fn(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
};

test("{§emission-history} {§packet-cache-monotone}: each turn's operations precede their results and settled history stays a prefix", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "interpolated-history");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Write, inspect, and reply.");
    const edit = op("EDIT (worker:///memo.md)", "Persist this exact body.");
    const read = op("READ (worker:///memo.md)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(`${note("Memory before writing.")}\n\n${edit}`, note("Reasoning memory.")),
        say(`${read}\n\n${note("Checking what landed.")}`),
        say(op("SEND [200]", "Done.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    const [opening, afterEdit, afterRead] = provider.received;
    assert.ok(opening && afterEdit && afterRead);
    assert.deepEqual(afterRead.map(({ role }) => role), ["system", "user", ...Array.from({ length: 2 }, () => ["assistant", "user"]).flat()]);
    assert.deepEqual(afterRead.filter(({ role }) => role === "assistant").map(chatMessageText), [`${note("Memory before writing.")}\n\n${edit}`, `${read}\n\n${note("Checking what landed.")}`]);
    for (const [index, operations] of [[2, ["NOTE", "EDIT"]], [4, ["READ", "NOTE"]]] as const) {
        assert.match(chatMessageText(afterRead[index + 1]), new RegExp(`^${operations.map((operation) => `### log:///1/\\d+/\\d+/${operation}${operation === "NOTE" ? "" : " → worker:///memo\\.md"} · \\d+`).join("[\\s\\S]*")}`, "u"), "the turn's receipts follow it, in order, each naming its operand");
    }
    const log = observations(afterRead);
    assert.match(log, /Reasoning memory\./u, "a reasoning NOTE is not in the program and keeps its ordinary row");
    assert.doesNotMatch(log, /Memory before writing\.|Checking what landed\./u, "authored memory appears only in assistant operations");
    assert.doesNotMatch(previousProgram(afterRead), /Reasoning memory\./u, "reasoning operations never enter content replay");
    assert.deepEqual(afterRead.slice(0, 3), afterEdit.slice(0, 3), "the earlier roles and bytes stay identical");
    // The retained results end where the status clump begins ({§packet-cache-monotone}).
    const oldResults = chatMessageText(afterEdit[3]).split(/\n\n## (?:Git Status|Context|Worker)\n/u)[0];
    assert.ok(chatMessageText(afterRead[3]).startsWith(oldResults), "new observations append after retained results");
});

for (const mode of ["none", "latest", "all"]) {
    test(`{§emission-history}: ${mode} replays operations without changing execution or source evidence`, async () => withHistory(mode, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `history-${mode}`);
            const workerId = await insertWorker(db, workspaceId, null, "writer");
            const loopId = await insertLoop(db, workerId, 1, "Edit, inspect, and reply.");
            const firstNote = note("First memory.");
            const first = `${firstNote}\n\n${op("EDIT (worker:///memo.md)", "Actual replacement.\nLast line.")}`;
            const secondNote = note("Second memory.");
            const second = `${op("READ (worker:///memo.md)", null)}\n\n${secondNote}`;
            const final = op("SEND [200]", "Done.");
            const provider = new Mock({ contextWindow: 100000, responses: [
                say(first, note("Reasoning memory.")), say(second), say(final),
            ] });
            const schemes = new SchemeRegistry();
            const result = await new Engine({ db, schemes }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 3, "replay neither executes programs again nor changes the loop");
            assert.equal(previousProgram(provider.received[0]), "");
            assert.equal(previousProgram(provider.received[1]), mode === "none" ? "" : first);
            assert.equal(previousProgram(provider.received[2]), mode === "none" ? "" : mode === "latest" ? second : `${first}\n\n${second}`);
            const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
            assert.equal(source?.content, first, "replay never changes addressable evidence");
            const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
            const packet = await builder.buildRequestPacket({ workspaceId, workerId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(packet)), mode === "all" ? `${first}\n\n${second}\n\n${final}` : mode === "latest" ? final : "", "a concluding SEND remains a whole operation");
            assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0));
            const nextLoop = await insertLoop(db, workerId, 2, "New request.");
            const next = await builder.buildRequestPacket({ workspaceId, workerId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(next)), "", "replay is scoped to the current loop");
            if (mode !== "none") assert.match(observations(PacketWire.packetToWireMessages(next)), /First memory\./u, "a NOTE of a turn that is not replayed renders as an ordinary row");
        } finally { await db.close(); }
    }));
}

test("{§emission-history}: all replays older eligible turns across a reasoning-only turn and a syntax failure", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-eligibility");
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const kept = note("Kept finding.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(`${kept}\n\n${op("SEND", "Progress update.")}`), say("", note("Reasoning memory.")),
            say(`${note("Partial program.")}\n\n\`\`\`READ (unclosed`),
            say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        for (const request of provider.received.slice(1)) assert.equal(previousProgram(request), `${kept}\n\n${op("SEND", "Progress update.")}`, "a syntactically partial program is not eligible, NOTE or no NOTE");
    } finally { await db.close(); }
}));

test("{§emission-history}: retiring an emission removes only that turn's replay, and its NOTEs return to the log as rows", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-curation");
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const firstNote = note("First finding.");
        const secondNote = note("Second finding.");
        const curate = op("KILL (log:///1/2/*/emission)", null);
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(`${firstNote}\n\n${op("SEND", "First progress update.")}`), say(`${secondNote}\n\n${op("SEND", "Second progress update.")}`), say(curate), say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        assert.equal(previousProgram(provider.received[2]), `${firstNote}\n\n${op("SEND", "First progress update.")}\n\n${secondNote}\n\n${op("SEND", "Second progress update.")}`);
        assert.equal(previousProgram(provider.received[3]), `${secondNote}\n\n${op("SEND", "Second progress update.")}`, "curation removes the retired turn's replay without replaying the successful curation KILL itself");
        const request = provider.received[3];
        const index = request.findIndex(({ role }) => role === "assistant");
        assert.match(chatMessageText(request[index - 1]).split("\n\n").at(-1)!, announcementOf(3), "the surviving turn keeps its source announcement");
        const log = observations(request);
        assert.doesNotMatch(log, /### log:\/\/\/1\/2\/\d+\/emission/u, "only the retired emission row is gone");
        assert.match(log, /### log:\/\/\/1\/2\/\d+\/NOTE · \d+\n[^\n]*\n1:First finding\./u, "the retired turn's NOTE is an ordinary row again, body and all");
        const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
        assert.equal(source?.content, `${firstNote}\n\n${op("SEND", "First progress update.")}`, "the immutable source is untouched");
    } finally { await db.close(); }
}));

test("{§emission-history}: mixed KILL targets execute normally; a retired NOTE leaves the replay, the distillation stays in the log, and sources stay readable", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "history-mixed-curation");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Draft and curate.");
    const edit = op("EDIT (worker:///memo.md)", "Draft.");
    const first = `${edit}\n\n${note("Superseded memory.")}`;
    const mixed = op("KILL (log:///1/2/*/NOTE) (worker:///memo.md)", null);
    const distilled = op("KILL (log:///1/2/*/EDIT)", "The draft was removed.");
    const second = `${mixed}\n\n${distilled}`;
    const provider = new Mock({ contextWindow: 100000, responses: [say(first), say(second), say(op("SEND [200]", "Done."))] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const ids = { workspaceId, workerId, loopId };
    const result = await engine.runLoop({ ...ids, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[1]), first, "before curation the turn replays EDIT and NOTE");
    assert.equal(previousProgram(provider.received[2]), op("KILL (worker:///memo.md)", null), "the file deletion remains; successful curation and retired operations do not replay");
    const log = observations(provider.received[2]);
    assert.doesNotMatch(log, /Superseded memory\./u, "the curated NOTE is gone from row and replay alike");
    assert.match(log, /The draft was removed\./u, "the KILL body still distills into an ordinary NOTE row");
    const missing = await clientRead(engine, db, { workspaceId, workerId, statement: readStmt(urlPath("worker", "/memo.md")) });
    assert.equal(missing.status, 404, "the file KILL in the mixed target executed");
    for (const [turn, original] of [[2, first], [3, second]] as const) {
        const parsed = PlurnkParser.parse(op(`READ (ops://writer/1/${turn}) <1,-1>`, null)).items[0];
        assert.ok(parsed?.kind === "statement");
        const source = await clientRead(engine, db, { workspaceId, workerId, statement: parsed.statement });
        assert.equal(source.status, 200);
        assert.equal(source.content, original, "an explicit source READ keeps NOTE, curation, grouped targets and every body");
    }
});

test("{§emission-history} {§operator-config-shipped-defaults}: complete operations replay without parsing nested examples or replaying reasoning", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-whole");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Edit, inspect, and reply.");
    const body = "Actual replacement.\n```NOTE\nA literal nested example, not an operation.\n```\nLast line.";
    const contentNote = note("Content memory.");
    const first = [op("EDIT (worker:///memo.md)", body), contentNote, op("WAIT [0]", null)].join("\n\n");
    const readNote = note("Read it back.");
    const second = `${op("READ (worker:///memo.md)", null)}\n\n${readNote}`;
    const reasoning = `Unretained deliberation.\n\n${note("Reasoning memory.")}`;
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(first, reasoning),
        say(second), say(op("SEND [200]", "Finished.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const result = await engine.runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.deepEqual(provider.received[0].map(({ role }) => role), ["system", "user"]);
    for (const [index, request] of provider.received.slice(1).entries()) {
        assert.deepEqual(request.map(({ role }) => role), ["system", "user", ...Array.from({ length: index + 1 }, () => ["assistant", "user"]).flat()], "each replayed turn is one assistant message before its receipts");
        assert.match(chatMessageText(request[1]), /^## Log\n/u);
        assert.match(chatMessageText(request.at(-1)!), /\n\n## Worker\n/u);
    }
    const [opening, afterEdit, afterRead] = provider.received.map(observations);
    assert.doesNotMatch(opening, /## Previous Emission/u);
    assert.equal(previousProgram(provider.received[1]), first, "the EDIT body and its nested example remain whole");
    assert.equal(previousProgram(provider.received[2]), `${first}\n\n${second}`, "replays accumulate in turn order");
    assert.doesNotMatch(previousProgram(provider.received[1]), /Reasoning memory/u, "reasoning operations stay in their channel");
    assert.match(afterEdit, /Reasoning memory\./u, "a reasoning NOTE persists as an ordinary row");
    assert.doesNotMatch(afterEdit, /Content memory\./u, "a paired receipt does not duplicate its authored body");
    assert.doesNotMatch(afterEdit, /Unretained deliberation\.|\/reasoning → reasoning:\/\//u, "automatic reasoning return is off");
    const record = afterEdit.split("\n\n").find((text) => /^### log:\/\/\/1\/2\/\d+\/emission/u.test(text))!;
    assert.ok(record);
    assert.match(record, announcementOf(2));
    assert.ok(afterRead.includes(record), "aging the replay never changes the old record's bytes or weight");
    assert.equal(Number(/ · (\d+)/u.exec(record)![1]), contentWeight(record), "the announcement charges only its own record");
    const reads = await db.test_log_entries_by_worker_op_full.all<{ rx: string }>({ worker_id: workerId, op: "READ" });
    assert.ok(reads.some(({ rx }) => (JSON.parse(rx) as { content?: string }).content === body), "the actual EDIT wrote the full replacement");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, first, "the immutable source is untouched");
    const reasoningSource = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "reasoning", sequence: 0 });
    assert.equal(reasoningSource?.content, reasoning, "reasoning remains addressable without automatic return");
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ workspaceId, workerId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(packet, "emission-history"), `${first}\n\n${second}\n\n${op("SEND [200]", "Finished.")}`, "the concluding reply remains complete");
    assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0), "each message is charged exactly once");
    const nextLoop = await insertLoop(db, workerId, 2, "A new request.");
    const next = await builder.buildRequestPacket({ workspaceId, workerId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(next, "emission-history"), "", "a new loop does not inherit a prior loop's replay");
});

for (const [name, content, reasoning, expected] of [
    ["runtime refusal", op("READ (worker:///missing.md)", null), null, op("READ (worker:///missing.md)", null)],
    ["syntax failure after a valid operation", `${note("admitted")}\n\n\`\`\`READ (unclosed`, null, ""],
    ["reasoning-only turn", "", note("Only reasoning."), ""],
    ["content NOTE only", note("Log memory only."), null, note("Log memory only.")],
    ["unmatched log curation", op("KILL (log:///1/1/*/FIND)", null), null, op("KILL (log:///1/1/*/FIND)", null)],
    ["empty turn", "", null, ""],
] as const) {
    test(`{§emission-history}: latest evaluates ${name} on the immediate turn, never an older program`, async (t) => withHistory("latest", async () => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, name);
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const older = note("OLDER MEMORY");
        const provider = new Mock({ contextWindow: 100000, responses: [say(`${older}\n\n${op("SEND", "Older progress.")}`), say(content, reasoning), say(op("SEND [200]", "Done."))] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(provider.received.length, 3);
        assert.equal(previousProgram(provider.received[1]), `${older}\n\n${op("SEND", "Older progress.")}`);
        assert.equal(previousProgram(provider.received[2]), expected);
    }));
}

for (const mode of ["latest", "all"]) test(`{§emission-history} {§context-own-rows-fit}: the wall omits ${mode} replay whole, the omitted turn's NOTEs return as rows, and the next request decides afresh`, async (t) => withHistory(mode, async () => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-wall");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Retain these observations.");
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    const body = Array.from({ length: 1500 }, (_, i) => `Durable observation ${i + 1}.`).join("\n");
    const big = note(body);
    const wide = new Mock({ contextWindow: 200000, responses: [say(`${big}\n\n${op("SEND", "Retained.")}`)] });
    await engine.runTurn({ workspaceId, workerId, loopId, provider: wide, messages: [] });
    const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
    const args = { workspaceId, workerId, loopId, currentTurnSeq: 3, provider: wide, initialMessages: [], gitStatus: null };
    const full = await builder.buildRequestPacket(args);
    const without = await builder.buildRequestPacket({ ...args, omitEmissionHistory: true });
    assert.equal(PacketWire.sectionContent(full, "emission-history"), `${big}\n\n${op("SEND", "Retained.")}`);
    assert.doesNotMatch(PacketWire.sectionContent(full, "log"), /Durable observation 1500\./u, "replayed, the NOTE's text is in the replay alone");
    assert.match(PacketWire.sectionContent(without, "log"), /Durable observation 1500\./u, "not replayed, the NOTE's text is its row's");
    // A NOTE's text is in the packet once, as replay or as row, so omitting the replay frees no room by itself:
    // the omitted turn's NOTE returns as a bodied row, and the wall's shedding then takes it like any other.
    const wall = full.weight - 1;
    const small = note("New observation.");
    const limited = new class extends Mock {
        override get inputWall(): number { return wall; }
    }({ contextWindow: 200000, responses: [say(`${small}\n\n${op("SEND", "New.")}`), say(op("SEND [200]", "Done."))] });
    await engine.runTurn({ workspaceId, workerId, loopId, provider: limited, messages: [] });
    const request = limited.received[0];
    assert.equal(previousProgram(request), "", "over the wall, the replay is omitted whole");
    assert.deepEqual(request.map(({ role }) => role), ["system", "user"], "whole-replay omission rejoins log and footer");
    const log = chatMessageText(request[1]);
    assert.match(log, /### log:\/\/\/1\/2\/\d+\/NOTE · \d+\n\{[^\n]*"size"/u, "the omitted turn's NOTE stands as a row, bodiless as a receipt when its body does not fit either ({§context-own-rows-fit})");
    assert.doesNotMatch(log, /Durable observation 1500\./u, "the text is nowhere twice and nowhere cut: whole as a row, or a receipt");
    assert.doesNotMatch(log, /\[REDACTED\]|preview|omitted/u, "no replay placeholder");
    await engine.runTurn({ workspaceId, workerId, loopId, provider: limited, messages: [] });
    assert.equal(previousProgram(limited.received[1]), "", "the older turn's NOTE now stands as a row in every packet, so the wall still omits the replay first, whatever the mode, and nothing is selectively redacted");
    assert.match(chatMessageText(limited.received[1][1]), /### log:\/\/\/1\/2\/\d+\/NOTE · \d+\n\{[^\n]*"size"/u, "and the row is taken again as a receipt: each packet decides afresh");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, `${big}\n\n${op("SEND", "Retained.")}`, "omission never rewrites the source");
}));

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
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Work.");
    const older = note("Old memory.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(`${older}\n\n${op("SEND", "Old admitted program.")}`),
        say(`### log:///1/2/9/READ\nInvented receipt.\n\n${note("Rejected program.")}`),
        say(op("SEND [200]", "Done.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const args = { workspaceId, workerId, loopId, provider, messages: [] };
    await engine.runTurn(args);
    const rejected = await engine.runTurn(args);
    assert.equal(rejected.emissionExhausted, true);
    await engine.runTurn(args);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[2]), mode === "all" ? `${older}\n\n${op("SEND", "Old admitted program.")}` : "");
    assert.doesNotMatch(observations(provider.received[2]) + previousProgram(provider.received[2]), /Rejected program\./u, "a rejected attempt's NOTE is nowhere");
}));
