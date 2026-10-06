import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import Turn from "../../src/core/Turn.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { readStmt, urlPath } from "./_dsl.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";

const messages = [{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Review the evidence." }];
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });
const providerAt = (capacity: number, responses: MockResponse[]): Mock => {
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - capacity);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new Mock({ contextWindow: 1_000_000, responses });
    } finally {
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
};
const continuing = "````NOTE\nReview the evidence.\n````";

const receipt = (row: Record<string, unknown>): { lines: number; tokens: number; remaining: number; detail: string } => {
    const problem = (row.problem ?? {}) as { detail?: string; lines?: number; tokens?: number; remaining?: number };
    return { lines: Number(problem.lines), tokens: Number(problem.tokens), remaining: Number(problem.remaining), detail: String(problem.detail ?? "") };
};

// {§markerless-first-page} — the room a test pins is measured, not guessed: the first packet's weight
// plus the margin the story needs.
const floorWeight = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, workerId: number, loopId: number): Promise<number> => {
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ initialMessages: messages, workspaceId, workerId, loopId, provider: providerAt(999_000, []), currentTurnSeq: 1, gitStatus: null });
    return packet.weight;
};
const pageLines = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES);
const pageChars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);

test("{§markerless-first-page}: a READ without a scope lands as its first page, bounded by lines and characters, naming the page of the whole; a range READ reaches the rest", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `first-page-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        const provider = providerAt(999_000, [
            response(`\`\`\`\`READ (worker:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`READ (worker:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 200, "the page is an ordinary result");
        const stored = JSON.parse(read.rx) as { content: string; range: { total: number; returned: [number, number] } };
        const [from, to] = stored.range.returned;
        assert.equal(from, 1);
        assert.ok(to < 600 && to <= pageLines, `the page is bounded: ${to} lines`);
        assert.ok(stored.content.length <= pageChars + 1, "and by characters");
        assert.equal(stored.content, content.split("\n").slice(0, to).join("\n"), "the page is the first lines, cut at a line boundary");
        assert.equal(stored.range.total, 600, "the whole is named beside the page");
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const row = logEntries(packet).find((entry) => entry.path === "worker:///large.md")!;
        assert.equal(row.range, `<1,${to}> of 600 lines`, "{§packet-extent-metadata}: one fact, one notation");
        assert.equal(String(row.body).trimEnd().split("\n").length, to, "the row shows exactly the page");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "an explicit scope is exact");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const look = await engine.look({ statement: readStmt(urlPath("worker", "/large.md"), { marks: [1, -1] }), workspaceId, workerId, loopId });
        assert.equal((look as { content?: string }).content, content, "`<1,-1>` is the whole thing");
    } finally { await db.close(); }
});

test("{§context-fit}: a page that does not fit the room lands as the longest prefix of its lines above a 413 receipt naming the lines delivered; the prefix holds the room until the receipt is killed, then a range READ succeeds", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        // A room 1,500 over the floor: the first page (about 8,000) cannot land whole, a few lines can.
        const room = await floorWeight(db, workspaceId, workerId, loopId) + 1_500;
        const provider = providerAt(room, [
            response(`\`\`\`\`READ (worker:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`KILL (log:///**/READ)\`\`\`\`\n\`\`\`\`READ (worker:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413, "the page does not fit the remaining budget");
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { type: string; detail: string; lines: number; tokens: number; remaining: number; delivered: number }; range?: { total: number; returned?: [number, number] } };
        const delivered = stored.problem.delivered;
        assert.ok(Number.isSafeInteger(delivered) && delivered > 0 && delivered < stored.problem.lines, `a prefix of the page fit: ${delivered} of ${stored.problem.lines}`);
        assert.equal(stored.content, `${content.split("\n").slice(0, delivered).join("\n")}\n`, "the row carries the first lines delivered, cut at a line boundary");
        assert.equal(stored.problem.type, "https://problems.plurnk.xyz/engine/context/result-exceeds-budget");
        assert.match(stored.problem.detail, new RegExp(`^${stored.problem.lines} lines, \\d+ tokens; \\d+ tokens remain: ${delivered} lines? delivered; READ a range, or KILL first\\.$`, "u"));
        assert.ok(stored.problem.tokens > stored.problem.remaining, "the page did not fit");
        assert.deepEqual(stored.range?.returned, [1, delivered], "the returned range closes on the last line delivered");
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        assert.ok(packet.weight <= room, "the receipt and its prefix fit where the page could not");
        const row = logEntries(packet).find((entry) => entry.status === 413 && entry.path === "worker:///large.md")!;
        assert.ok(row, "the receipt is a row of the next packet");
        assert.equal(String(row.body).trimEnd().split("\n").length, delivered, "the row shows exactly the lines delivered");
        const facts = receipt(row);
        assert.ok(facts.tokens > 0 && facts.remaining >= 0 && facts.tokens > facts.remaining);
        assert.match(facts.detail, /READ a range, or KILL first/u);
        assert.doesNotMatch(packetSection(packet, "budget"), /WARNING|MUST/u, "{§context-gauge}: the gauge is state, not a mandate");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "{§context-verbs}: the prefix held the room; KILL first, then a range READ takes a piece of what did not fit");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const look = await engine.look({ statement: readStmt(urlPath("worker", "/large.md"), { marks: [1, -1] }), workspaceId, workerId, loopId });
        assert.equal((look as { content?: string }).content, content, "the complete result is where it was read from");
    } finally { await db.close(); }
});

test("{§context-fit}: a READ whose first line does not fit is a bodiless receipt", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-line-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // One line longer than the page's characters: the page is a cut of that line, about 8,000 tokens.
        await seedEntryWithChannel(db, { workspaceId, pathname: "/line.md", content: "evidence ".repeat(4_000) });
        const room = await floorWeight(db, workspaceId, workerId, loopId) + 1_500;
        const provider = providerAt(room, [response(`\`\`\`\`READ (worker:///line.md)\`\`\`\`\n${continuing}`)]);
        const turn = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: turn.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413);
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { detail: string; lines: number; delivered?: number } };
        assert.equal(stored.content, null, "not one line fit: the row carries no body");
        assert.equal(stored.problem.delivered, undefined);
        assert.match(stored.problem.detail, /^1 line, \d+ tokens; \d+ tokens remain: READ a range, or KILL first\.$/u);
    } finally { await db.close(); }
});

test("{§context-verbs}: KILL first — the fit measure honours curation within the same turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-verbs-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const filler = Array.from({ length: 100 }, (_, i) => `filler ${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        const wanted = Array.from({ length: 100 }, (_, i) => `wanted ${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/filler.md", content: filler });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/wanted.md", content: wanted });
        // `<1,-1>` asks for the whole file, so each READ is the whole 14,000 and not its page ({§markerless-first-page}).
        const provider = providerAt(24_000, [
            response(`\`\`\`\`READ (worker:///filler.md) <1,-1>\`\`\`\`\n${continuing}`),
            response([
                "````READ (worker:///wanted.md) <1,-1>````",
                "````KILL (log:///1/*/*/READ)````",
                "````READ (worker:///wanted.md) <1,-1>````",
                continuing,
            ].join("\n")),
        ]);
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 1, provider });
        const filled = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: first.turnId })).find((row) => row.op === "READ")!;
        assert.equal(filled.status_rx, 200, "the first file fits an empty room");
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 2, provider });
        const reads = (await db.test_log_entries_by_turn.all<{ sequence: number; op: string; status_rx: number }>({ turn_id: second.turnId }))
            .filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))
            .toSorted((a, b) => a.sequence - b.sequence)
            .map(({ status_rx }) => status_rx);
        assert.deepEqual(reads, [413, 200], "before the KILL the room is full; after it the same READ fits");
    } finally { await db.close(); }
});

test("{§context-wall}: an impossible window terminates the loop without provider calls or manufactured operations", async () => {
    const db = await openMigrated();
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        const workspaceId = await insertWorkspace(db, `output-floor-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        // An eleven-token window with a two-token output budget: no packet fits it even as receipts.
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        const provider = new Mock({ contextWindow: 11, responses: [response(continuing)] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, messages, provider, maxTurns: 3 });
        assert.equal(result.result.status, 413);
        assert.equal(result.result.problem?.detail, "Context window overflow: the packet cannot fit the model's window even as receipts."); // {§pinned-wording-core}
        assert.equal(result.reason, "token_budget");
        assert.equal(provider.remaining, 1);
        const turn = await db.test_get_turn.get<{ packet: string | null }>({ id: result.turnIds.at(-1)! });
        assert.equal(turn!.packet, null, "a request that was never submitted is not provider evidence");
        const rows = await db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: result.turnIds.at(-1)! });
        assert.ok(rows.every(({ op }) => !["WAIT", "DONE", "FAIL", "KILL"].includes(op)), "no recovery disposition or curation program is manufactured");
    } finally {
        await db.close();
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET; else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET; else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
});

test("{§context-over-budget-row}: over budget but under the wall, the packet goes with one 413 row at its head, the gauge shows it over, and authored state is untouched", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-authorship-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const note = "Remember ".repeat(5000);
        const wide = providerAt(999_000, [response(`\`\`\`\`NOTE\n${note}\n\`\`\`\``)]);
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: wide });
        const before = await db.engine_render_log.all({ worker_id: workerId });
        // A 12,000-token budget inside a million-token window: far over the budget, far under the wall.
        const small = providerAt(12_000, [response(continuing), response(continuing)]);
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: small });
        assert.equal(second.status, 102, "the over-budget packet is submitted, not ended");
        assert.equal(small.remaining, 1, "the provider was asked once");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const gauge = JSON.parse(packetSection(packet, "budget")) as { tokens: number; budget: number };
        assert.ok(gauge.tokens > gauge.budget, `the gauge shows the packet over: ${gauge.tokens} of ${gauge.budget}`);
        const rows = logEntries(packet).filter((row) => String(row.logPath).endsWith("/error"));
        assert.equal(rows.length, 1, "one row, at the head of the turn");
        const problem = (rows[0]!.problem ?? {}) as { detail?: string; excess?: number };
        assert.equal(problem.detail, "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn."); // {§pinned-wording-core}
        assert.equal(problem.excess, undefined, "{§context-gauge}: the gauge is the one home for the numbers");
        assert.equal(rows[0]!.origin, "_plurnk");
        const third = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: small });
        const next = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: third.turnId }))!.packet);
        assert.equal(logEntries(next).filter((row) => String(row.logPath).endsWith("/error")).length, 2, "the row recurs on every packet that is over");
        const after = await db.engine_render_log.all<{ id: number }>({ worker_id: workerId });
        for (const row of before as Array<{ id: number }>) assert.deepEqual(after.find(({ id }) => id === row.id), row, "authored state cannot be removed or folded to manufacture a fit");
        const firstRows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; folded: string }>({ turn_id: first.turnId });
        assert.ok(firstRows.some(({ op, tx }) => op === "NOTE" && JSON.parse(tx).body === note), "the authored NOTE stands whole");
    } finally { await db.close(); }
});

test("{§context-own-rows-fit}: over the wall, the newest bodied rows go bodiless as receipts until the packet fits; older rows and every stored body stand, and each packet decides afresh", async () => {
    const db = await openMigrated();
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        const workspaceId = await insertWorkspace(db, `own-rows-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const alpha = "alpha ".repeat(1_000);
        const beta = "beta ".repeat(1_200);
        const wide = providerAt(999_000, [response(`\`\`\`\`NOTE\n${alpha}\n\`\`\`\``), response(`\`\`\`\`NOTE\n${beta}\n\`\`\`\``), response(continuing)]);
        await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: wide });
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: wide });
        const third = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: wide });
        const settled = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: third.turnId }))!.packet) as { weight: number };
        const betaRow = logEntries(settled).find((row) => String(row.logPath).endsWith("/NOTE") && /beta beta/u.test(String(row.body))) as { logPath: string; tokens: number; body?: string };
        assert.ok(betaRow, "the newest large NOTE is a bodied row of the settled packet");
        // A wall 600 tokens under the settled packet: the next packet is over it by its newest small rows and
        // those 600 tokens, and the beta NOTE alone sheds that. The output budget is half the window, so the
        // packet that fits the wall is still over budget.
        const contextWindow = Math.ceil((settled.weight - 600) / 0.9);
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(Math.floor(contextWindow / 2));
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        const tight = new Mock({ contextWindow, responses: [response(continuing), response(`\`\`\`\`KILL (${betaRow.logPath})\`\`\`\`\n${continuing}`), response(continuing)] });
        const wall = tight.inputWall!;
        assert.ok(wall < settled.weight && wall > settled.weight - betaRow.tokens, `the wall sits inside the beta NOTE: ${wall} of ${settled.weight}`);
        const fourth = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: tight });
        assert.equal(fourth.status, 102, "the packet was submitted, not ended");
        assert.equal(tight.remaining, 2);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: fourth.turnId }))!.packet) as { weight: number };
        assert.ok(packet.weight <= wall, `the packet fits the wall: ${packet.weight} of ${wall}`);
        const entries = logEntries(packet);
        const taken = entries.find((row) => row.logPath === betaRow.logPath)!;
        assert.equal(taken.body, undefined, "the newest bodied row is a receipt");
        assert.deepEqual(taken.size, { lines: 1, tokens: betaRow.tokens }, "its size names the lines and tokens of the body it stood for");
        assert.ok(Number(taken.tokens) < betaRow.tokens, "the receipt charges less than the body did");
        assert.ok(entries.some((row) => /alpha alpha/u.test(String(row.body))), "the older NOTE keeps its body: newest first, and only as many as it takes");
        assert.equal(entries.filter((row) => row.size !== undefined).length, 1, "one row was taken");
        const gauge = JSON.parse(packetSection(packet, "budget")) as { tokens: number; budget: number };
        assert.ok(gauge.tokens > gauge.budget, "the packet that fits the wall is still over budget");
        assert.equal(entries.filter((row) => String(row.logPath).endsWith("/error")).length, 1, "{§context-over-budget-row}: the row rides the packet that fits");
        const stored = await db.test_log_entries_by_turn.all<{ op: string; tx: string; folded: string }>({ turn_id: second.turnId });
        assert.ok(stored.some(({ op, tx, folded }) => op === "NOTE" && JSON.parse(tx).body === beta && folded === "[]"), "the body stays stored, whole and unfolded");
        const look = await engine.look({ statement: readStmt(urlPath("log", String(betaRow.logPath).slice("log://".length)), { marks: [1, -1] }), workspaceId, workerId, loopId });
        assert.equal(look.status, 200);
        assert.match(String((look as { content?: string }).content), /beta beta/u, "and readable at its address");
        await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: tight });
        const sixth = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: tight });
        const after = logEntries(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: sixth.turnId }))!.packet));
        assert.equal(after.find((row) => row.logPath === betaRow.logPath), undefined, "{§context-verbs}: the KILL retired the row");
        assert.equal(after.filter((row) => row.size !== undefined).length, 0, "with the room restored, nothing is taken: each packet decides afresh");
        assert.ok(after.some((row) => /alpha alpha/u.test(String(row.body))), "the older NOTE stands whole");
    } finally {
        await db.close();
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET; else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET; else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
});

for (const origin of ["client", "_plurnk"] as const) test(`{§context-fit}: ${origin} output crosses maintenance and loop boundaries whole, result and all`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-origin-${origin}-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const earlier = await Turn.open(db, { loopId, producer: origin, kind: "operation" });
        const content = "result ".repeat(1_000);
        const result = { ...Results.failure("scheme:worker", "output-failure", 503, "Connection closed."), content, mimetype: "text/plain", startLine: 1 };
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: earlier.id, sequence: 1, origin,
            source: null, model_call_id: null, op: "READ", scheme: "worker", pathname: "/result",
            username: null, password: null, hostname: null, port: null, query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json", rx: JSON.stringify(result), mimetype_rx: "application/json",
            status_rx: 503, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await Turn.complete(db, earlier.id, 102);
        const maintenance = await Turn.open(db, { loopId, producer: "_plurnk", kind: "maintenance" });
        await Turn.complete(db, maintenance.id, 200);
        const laterLoop = await insertLoop(db, workerId, 2);
        const schemes = new SchemeRegistry();
        const provider = providerAt(999_000, [response(continuing)]);
        const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
        await builder.buildRequestPacket({ initialMessages: messages, workspaceId, workerId, loopId: laterLoop, provider, currentTurnSeq: 1, gitStatus: null });
        const before = await db.engine_render_log.all<{ id: number; folded: string; rx: string }>({ worker_id: workerId });
        assert.equal(before.find(({ id }) => id === inserted!.id)!.folded, "[]", "speculative construction has no projection effects");
        const next = await new Engine({ db, schemes }).runTurn({ workspaceId, workerId, loopId: laterLoop, messages, provider });
        assert.equal(provider.remaining, 0);
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const row = logEntries(packet).find(({ logPath: path }) => path === `log:///1/${earlier.sequence}/1/READ`)!;
        assert.equal(row.status, 503, "the actual operation result is not restamped");
        assert.equal((row.problem as { detail: string }).detail, "Connection closed.");
        assert.match(String(row.body), /result result/u, "the retained result arrives whole: nothing is withheld");
        const projected = await db.engine_render_log.all<{ id: number; folded: string; rx: string }>({ worker_id: workerId });
        assert.equal(projected.find(({ id }) => id === inserted!.id)!.folded, "[]");
        assert.deepEqual(JSON.parse(projected.find(({ id }) => id === inserted!.id)!.rx), result);
    } finally { await db.close(); }
});

test("{§packet-markdown}: structured section content directly follows its heading; Git is a NOTE", () => {
    for (const header of ["Errors", "Context", "Open Messages"]) {
        assert.equal(PacketWire.renderSection({ header, content: "[]" }), `## ${header}\n[]`);
    }
    const git = PacketWire.renderGit({ branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 });
    assert.equal(git, "> [!NOTE]\n> branch `main` — 0 staged, 0 unstaged, 0 untracked");
    assert.equal(PacketWire.renderSection({ header: "Git Status", content: git }), `## Git Status\n\n${git}`);
});
