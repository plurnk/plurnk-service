// {§reasoning-row} — the model's own thinking as a row immediately before its emission row, whole when the
// room allows, absent otherwise, and nothing else in the turn changed by it.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { packetSection } from "./_packet.ts";

const frame = PlurnkParser.frame;
const KNOB = "PLURNK_SERVICE_REASONING_ROWS";
const withKnob = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env[KNOB];
    if (value === undefined) delete process.env[KNOB]; else process.env[KNOB] = value;
    try { await fn(); } finally { if (previous === undefined) delete process.env[KNOB]; else process.env[KNOB] = previous; }
};
type Row = { sequence: number; op: string | null; origin: string; scheme: string | null; attrs: string | null; rx: string | null };
const rowsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<Row[]> =>
    (await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId })).sort((a, b) => a.sequence - b.sequence);
const kindOf = (row: Row): string | null => { try { return (JSON.parse(row.attrs ?? "{}") as { kind?: string }).kind ?? null; } catch { return null; } };

const story = async (contextWindow: number, reasoning: string) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `reasoning-row-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "An observed fact." });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // A program with a retrieval: an emission of only NOTEs rides no assistant message ({§emission-row}).
    const program = `${frame("READ (worker:///fact.txt)", null)}\n\n${frame("NOTE", "Bearing one.")}`;
    const provider = new Mock({ contextWindow, responses: [
        { assistant: { content: program, reasoning } },
        { assistant: { content: frame("KILL", "Done."), reasoning: null } },
    ] });
    const first = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
    const second = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
    const rows = await rowsOf(db, first.turnId);
    const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
    return { db, first, second, rows, log: packetSection(packet, "log"), envelope: provider.received[1]! };
};

test("{§reasoning-row}: with the knob on, the turn's reasoning lands whole as the row before its emission row, and the program stays the assistant message", async () => {
    await withKnob("1", async () => {
        const reasoning = "I think the fix is in the resolver.\nBecause the converter raises before the view is named.";
        const { db, first, second, rows, log, envelope } = await story(100_000, reasoning);
        try {
            assert.equal(first.status, 102); assert.equal(second.status, 200);
            const reasoningRow = rows.find((row) => kindOf(row) === "reasoning");
            const emissionRow = rows.find((row) => kindOf(row) === "emission");
            assert.ok(reasoningRow && emissionRow, `both rows land: ${JSON.stringify(rows.map((r) => [r.sequence, r.op, kindOf(r)]))}`);
            assert.equal(reasoningRow.sequence, emissionRow.sequence - 1, "the reasoning row is the one sequence before the emission row");
            assert.equal(reasoningRow.op, "READ"); assert.equal(reasoningRow.origin, "_plurnk"); assert.equal(reasoningRow.scheme, "reasoning");
            assert.equal((JSON.parse(reasoningRow.rx!) as { content: string }).content, reasoning, "the body is the model's own reasoning, whole");
            const heading = log.indexOf(`/${reasoningRow.sequence}/reasoning → reasoning://alice/1/2`);
            const emissionHeading = log.indexOf(`/${emissionRow.sequence}/emission`);
            assert.ok(heading >= 0, `the packet names the row by its own leaf and address: ${log.slice(0, 400)}`);
            assert.ok(emissionHeading > heading, "the reasoning row precedes the emission row in the packet");
            assert.match(log, /converter raises before the view is named/u, "the thinking is in the packet, not a page of it");
            const assistantIndex = envelope.findIndex((m) => m.role === "assistant");
            assert.ok(assistantIndex > 0, "the emission rides as the assistant message");
            const userBefore = String(envelope[assistantIndex - 1]!.content);
            assert.match(userBefore, /reasoning:\/\/alice\/1\/2/u, "the user message that ends on the emission row carries the reasoning row before it");
            assert.doesNotMatch(String(envelope[assistantIndex]!.content), /converter raises/u, "the assistant message is the program alone");
            assert.match(String(envelope[assistantIndex]!.content), /READ \(worker:\/\/\/fact\.txt\)/u, "and it is the program");
        } finally { await db.close(); }
    });
});

test("{§reasoning-row}: without room for it, no reasoning row lands and the turn is otherwise untouched", async () => {
    await withKnob("1", async () => {
        const reasoning = Array.from({ length: 4000 }, (_, i) => `thought ${i}: the fix is in the resolver and the converter raises`).join("\n");
        const { db, first, second, rows, log } = await story(20_000, reasoning);
        try {
            assert.equal(first.status, 102, "the turn continues; nothing about the room ends it"); assert.equal(second.status, 200);
            assert.equal(rows.filter((row) => kindOf(row) === "reasoning").length, 0, "no reasoning row");
            assert.equal(rows.filter((row) => kindOf(row) === "emission").length, 1, "the emission row lands as always");
            assert.deepEqual(rows.filter((row) => row.op === "error").map((row) => row.sequence), [], "no receipt, no 413, nothing else changes");
            assert.ok(rows.some((row) => row.op === "READ" && row.origin === "model"), "the program ran");
            assert.doesNotMatch(log, /\/reasoning → reasoning:\/\//u, "the next packet carries no reasoning row");
        } finally { await db.close(); }
    });
});

test("{§reasoning-row}: with the knob off, no row lands", async () => {
    await withKnob("0", async () => {
        const { db, rows, log } = await story(100_000, "Some thinking.");
        try {
            assert.equal(rows.filter((row) => kindOf(row) === "reasoning").length, 0);
            assert.doesNotMatch(log, /\/reasoning → reasoning:\/\//u);
        } finally { await db.close(); }
    });
});
