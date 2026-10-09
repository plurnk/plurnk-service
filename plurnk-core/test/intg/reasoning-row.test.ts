// {§reasoning-row} — the model's own reasoning as a row immediately before its emission row, whole when the
// room allows, absent otherwise, and nothing else in the turn changed by it.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { packetSection } from "./_packet.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import { contentWeight } from "../../src/core/content-weight.ts";

const frame = PlurnkParser.frame;
const KNOB = "PLURNK_SERVICE_REASONING_ROWS";
const TRAILING = "PLURNK_SERVICE_REASONING_TRAILING_LINES";
const withEnv = async (name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { await fn(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
};
const withKnob = (value: string | undefined, fn: () => Promise<void>): Promise<void> => withEnv(KNOB, value, fn);
type Row = { sequence: number; op: string | null; origin: string; scheme: string | null; attrs: string | null; tx: string | null; rx: string | null };
const rowsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<Row[]> =>
    (await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId })).sort((a, b) => a.sequence - b.sequence);
const kindOf = (row: Row): string | null => { try { return (JSON.parse(row.attrs ?? "{}") as { kind?: string }).kind ?? null; } catch { return null; } };

const story = async (contextWindow: number, reasoning: string) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `reasoning-row-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1, "Inspect the evidence and report the result.");
    await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "An observed fact." });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const program = `${frame("READ (worker:///fact.txt)", null)}\n\n${frame("NOTE", "Bearing one.")}`;
    const provider = new Mock({ contextWindow, responses: [
        { assistant: { content: program, reasoning } },
        { assistant: { content: frame("SEND [200]", "Done."), reasoning: null } },
    ] });
    const first = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
    const second = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
    const rows = await rowsOf(db, first.turnId);
    const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
    return { db, first, second, rows, program, log: packetSection(packet, "log"), envelope: provider.received[1]!, engine, ids: { workspaceId, workerId, loopId } };
};

test("{§reasoning-row} {§emission-history}: reasoning and NOTE stay in the log and retained content operations are assistant-authored", async () => {
    await withKnob("1", async () => {
        const reasoning = "I think the fix is in the resolver.\nBecause the converter raises before the view is named.";
        const { db, first, second, rows, program, log, envelope } = await story(100_000, reasoning);
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
            assert.match(log, /converter raises before the view is named/u, "the reasoning is in the packet, not a page of it");
            assert.deepEqual(envelope.map(({ role }) => role), ["system", "user", "assistant", "user"]);
            const before = chatMessageText(envelope[1]!);
            const previous = chatMessageText(envelope[2]!);
            assert.match(before!, /reasoning:\/\/alice\/1\/2/u);
            assert.match(before!, /converter raises before the view is named/u, "reasoning remains in its log row");
            assert.equal(previous, frame("READ (worker:///fact.txt)", null), "the assistant message retains the complete READ without copying reasoning or NOTE");
            assert.match(before, /Bearing one\./u, "the content NOTE remains in the log");
            assert.equal(JSON.parse(emissionRow.rx!).content, program, "the frozen emission still contains every admitted operation");
        } finally { await db.close(); }
    });
});

test("{§reasoning-row}: without room for it, no reasoning row lands and the turn is otherwise untouched", async () => {
    await withKnob("1", async () => {
        // The row's page is bounded by PLURNK_SERVICE_PREVIEW_CHARS, so the room that is missing must be smaller than that page.
        const reasoning = Array.from({ length: 400 }, (_, i) => `thought ${i}: ${"the fix is in the resolver and the converter raises before the view is named; ".repeat(3)}`).join("\n");
        const { db, first, second, rows, log } = await story(9_000, reasoning);
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

test("{§reasoning-row}: an oversized reasoning line is a column-scoped suffix and the original stays readable", async () => {
    await withKnob("1", () => withEnv("PLURNK_SERVICE_PREVIEW_CHARS", "64", async () => {
        const reasoning = "🙂".repeat(200);
        const { db, rows, engine, ids } = await story(100_000, reasoning);
        try {
            const preview = rows.find((row) => kindOf(row) === "reasoning");
            assert.ok(preview);
            assert.equal(JSON.parse(preview.rx!).content, "🙂".repeat(64));
            assert.deepEqual(JSON.parse(preview.tx!).lineMarker, { marks: [1, 137, 1, 201] });
            const item = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2) <1,-1>", null)).items[0];
            assert.ok(item?.kind === "statement");
            const whole = await engine.look({ ...ids, statement: item.statement });
            assert.equal(whole.status, 200);
            assert.equal(whole.content, reasoning, "automatic preview bounds never truncate source evidence");
        } finally { await db.close(); }
    }));
});

test("{§reasoning-row}: reasoning longer than the page lands as its last page, with its range, and the whole stays at its address", async () => {
    await withKnob("1", async () => {
        const lines = Array.from({ length: 300 }, (_, i) => `thought ${i + 1}: ${i + 1 === 300 ? "DECISION: patch the resolver" : "an exploratory step"}`);
        const { db, rows, log, envelope, engine, ids } = await story(100_000, lines.join("\n"));
        try {
            const row = rows.find((r) => kindOf(r) === "reasoning");
            assert.ok(row, "the row lands");
            const rx = JSON.parse(row.rx!) as { content: string; range?: { unit: string; total: number; returned?: [number, number] } };
            assert.equal(rx.content, lines.slice(200).join("\n"), "the body is the last 100 lines: the shared page, PLURNK_SERVICE_PREVIEW_LINES");
            assert.deepEqual([rx.range?.unit, rx.range?.total, rx.range?.returned], ["line", 300, [201, 300]], "the receipt states the page against the whole");
            assert.deepEqual((JSON.parse(row.tx!) as { lineMarker?: unknown }).lineMarker, { marks: [201, 300] }, "the statement carries the scope it took");
            assert.match(log, /DECISION: patch the resolver/u, "the conclusion is in the packet");
            assert.doesNotMatch(log, /thought 1: an exploratory step/u, "the restatement is not");
            assert.match(log, /<201,300> of 300 lines/u, "the fact of the page is stated beneath the heading");
            const statement = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2) <1,200>", null)).items.flatMap((i) => i.kind === "statement" ? [i.statement] : [])[0]!;
            const head = await engine.look({ ...ids, statement });
            assert.ok("content" in head && typeof head.content === "string" && head.content.startsWith("thought 1:") && head.content.endsWith("thought 200: an exploratory step"), "the rest is one READ away");
            assert.ok(envelope.some((m) => m.role === "user" && /DECISION: patch the resolver/u.test(String(m.content))), "the page reaches the wire");
        } finally { await db.close(); }
    });
});

test("{§reasoning-row}: PLURNK_SERVICE_REASONING_TRAILING_LINES is the row's own page; unset defers to the shared page", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `thought ${i + 1}`);
    await withKnob("1", () => withEnv(TRAILING, "20", async () => {
        const { db, rows } = await story(100_000, lines.join("\n"));
        try {
            const rx = JSON.parse(rows.find((r) => kindOf(r) === "reasoning")!.rx!) as { content: string; range?: { returned?: [number, number] } };
            assert.equal(rx.content, lines.slice(30).join("\n"), "the last 20 lines");
            assert.deepEqual(rx.range?.returned, [31, 50]);
        } finally { await db.close(); }
    }));
    await withKnob("1", () => withEnv(TRAILING, "", async () => {
        const { db, rows } = await story(100_000, lines.join("\n"));
        try {
            const rx = JSON.parse(rows.find((r) => kindOf(r) === "reasoning")!.rx!) as { content: string; range?: unknown };
            assert.equal(rx.content, lines.join("\n"), "50 lines fit the shared 100-line page: whole");
            assert.equal(rx.range, undefined, "a whole row states no range");
        } finally { await db.close(); }
    }));
});

test("{§reasoning-row}: the optional preview never displaces an authored READ result", async () => {
    const evidence = Array.from({ length: 40 }, (_, i) => `fact ${i}: ${"evidence ".repeat(12)}`).join("\n");
    const reasoning = "Consider the evidence. ".repeat(100);
    const outcomes: unknown[] = [];
    let budget = 0;
    for (const enabled of ["reference", "0", "1"]) await withKnob(enabled === "reference" ? "0" : enabled, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `reasoning-priority-${enabled}`);
            const workerId = await insertWorker(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, workerId, 1);
            const schemes = new SchemeRegistry();
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/evidence.txt", content: evidence });
            const messages = [{ role: "user" as const, content: "Read the evidence." }];
            const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
            const output = enabled === "reference" ? process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET : String(1_000_000 - budget);
            await withEnv("PLURNK_PROVIDERS_OUTPUT_BUDGET", output, async () => {
                const provider = new Mock({ contextWindow: 1_000_000, responses: [
                    { assistant: { content: frame("READ (worker:///evidence.txt) <1,-1>", null), reasoning } },
                ] });
                const turn = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages, turnNumber: 1 });
                const rows = await rowsOf(db, turn.turnId);
                const read = rows.find((row) => row.op === "READ" && row.scheme === "worker");
                assert.ok(read, "the authored READ has a receipt");
                const result = JSON.parse(read.rx!);
                assert.equal(result.status, 200, `the requested result fits with reasoning previews ${enabled}`);
                assert.equal(result.content, evidence, "the requested result remains complete");
                assert.equal(rows.some((row) => kindOf(row) === "reasoning"), false, "no room remains for optional reasoning");
                if (enabled === "reference") {
                    const completed = await db.engine_loop_turn_seqs.get<{ turn_seq: number }>({ loop_id: loopId, turn_id: turn.turnId });
                    assert.ok(completed);
                    const complete = await builder.buildRequestPacket({ initialMessages: messages, workspaceId, workerId, loopId,
                        provider, currentTurnSeq: completed.turn_seq + 1, gitStatus: null });
                    budget = complete.weight + Math.floor(contentWeight(reasoning) / 2);
                } else outcomes.push(result);
            });
        } finally { await db.close(); }
    });
    assert.deepEqual(outcomes[1], outcomes[0], "the optional preview does not change the requested result");
});

test("{§reasoning-row}: -1 returns complete reasoning independently of the shared preview bounds", async () => {
    await withKnob("1", () => withEnv(TRAILING, "-1", () => withEnv("PLURNK_SERVICE_PREVIEW_CHARS", "64", async () => {
        const reasoning = Array.from({ length: 150 }, (_, i) => `thought ${i + 1}: ${"evidence ".repeat(20)}`).join("\n");
        const { db, rows, envelope, engine, ids } = await story(100_000, reasoning);
        try {
            const row = rows.find((r) => kindOf(r) === "reasoning");
            assert.ok(row, "complete reasoning fits and lands");
            assert.equal(JSON.parse(row.rx!).content, reasoning);
            assert.equal(JSON.parse(row.rx!).range, undefined);
            assert.equal(JSON.parse(row.tx!).lineMarker, null);
            const wire = envelope.filter((m) => m.role === "user").map(chatMessageText).join("\n");
            assert.match(wire, /thought 1:/u);
            assert.match(wire, /thought 150:/u);
            const item = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2)", null)).items[0];
            assert.ok(item?.kind === "statement");
            const ordinary = await engine.look({ ...ids, statement: item.statement });
            assert.equal(ordinary.status, 200);
            assert.ok(typeof ordinary.content === "string" && ordinary.content.length <= 64, "an ordinary markerless READ still uses the shared preview");
        } finally { await db.close(); }
    })));
});

test("{§reasoning-row}: complete reasoning is omitted whole when it cannot fit, without displacing results", async () => {
    await withKnob("1", () => withEnv(TRAILING, "-1", async () => {
        const reasoning = "An extended deliberation. ".repeat(10_000);
        const { db, first, second, rows, engine, ids } = await story(100_000, reasoning);
        try {
            assert.equal(first.status, 102);
            assert.equal(second.status, 200);
            assert.equal(rows.some((row) => kindOf(row) === "reasoning"), false);
            assert.ok(rows.some((row) => row.op === "READ" && row.origin === "model"));
            assert.equal(rows.some((row) => row.op === "error"), false);
            const item = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2) <1,-1>", null)).items[0];
            assert.ok(item?.kind === "statement");
            const source = await engine.look({ ...ids, statement: item.statement });
            assert.equal(source.content, reasoning, "omission retains the full immutable source");
        } finally { await db.close(); }
    }));
});

for (const content of ["", frame("NOTE", "content note")]) {
    test(`{§reasoning-row}: reasoning-only operations retain their preview ${content === "" ? "without" : "with"} a content emission`, async () => {
        await withKnob("1", async () => {
            const db = await openMigrated();
            try {
                const workspaceId = await insertWorkspace(db, `reasoning-source-${crypto.randomUUID()}`);
                const workerId = await insertWorker(db, workspaceId, null, "alice");
                const loopId = await insertLoop(db, workerId, 1);
                const reasoning = frame("NOTE", "reasoned finding");
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
                const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning } }] });
                const turn = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
                const rows = await rowsOf(db, turn.turnId);
                const preview = rows.find((row) => kindOf(row) === "reasoning");
                assert.ok(preview, "reasoning preview does not depend on content-channel operations");
                assert.equal(JSON.parse(preview.rx!).content, reasoning);
                assert.equal(rows.filter((row) => kindOf(row) === "emission").length, content === "" ? 0 : 1);
                const notes = rows.filter((row) => row.op === "NOTE");
                assert.equal(notes.length, content === "" ? 1 : 2, "reasoning operations execute exactly once");
                assert.ok(notes.every((row) => row.sequence > preview.sequence), "the preview precedes the operations it informed");
            } finally { await db.close(); }
        });
    });
}
