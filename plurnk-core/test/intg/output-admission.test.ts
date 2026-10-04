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

test("{§context-fit}: a READ that does not fit lands as a bodiless 413 naming its size, tokens, the remaining budget and the verbs; a range READ then succeeds", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        const provider = providerAt(12_000, [
            response(`\`\`\`\`READ (worker:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`READ (worker:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 1, provider });
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; op: string; status_rx: number; rx: string; attrs: string }>({ turn_id: first.turnId });
        const read = rows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413, "the result does not fit the remaining budget");
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { type: string; detail: string; lines: number; tokens: number; remaining: number }; range?: { total: number } };
        assert.equal(stored.content, null, "the row carries no body; the file is where the result lives");
        assert.equal(stored.problem.type, "https://problems.plurnk.xyz/engine/context/result-exceeds-budget");
        assert.match(stored.problem.detail, /^600 lines, \d+ tokens; \d+ tokens remain: READ a range, or KILL first\.$/u);
        assert.equal(stored.problem.lines, 600);
        assert.ok(stored.problem.tokens > stored.problem.remaining, "it did not fit");
        assert.equal(stored.range?.total, 600, "the extent is the whole resource");
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        assert.ok(packet.weight <= 12_000, "the receipt fits where the result could not");
        const row = logEntries(packet).find((entry) => entry.status === 413 && entry.path === "worker:///large.md")!;
        assert.ok(row, "the receipt is a row of the next packet");
        assert.equal(row.body, undefined);
        const facts = receipt(row);
        assert.equal(facts.lines, 600);
        assert.ok(facts.tokens > 0 && facts.remaining >= 0 && facts.tokens > facts.remaining);
        assert.match(facts.detail, /READ a range, or KILL first/u);
        assert.doesNotMatch(packetSection(packet, "budget"), /WARNING|MUST/u, "{§context-gauge}: the gauge is state, not a mandate");
        assert.ok(logEntries(packet).some((entry) => String(entry.logPath).endsWith("/NOTE") && /Review the evidence/u.test(String(entry.body))), "the NOTE is never replaced");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "{§context-verbs}: a range READ takes a piece of what did not fit");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const third = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 3, provider });
        const later = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: third.turnId }))!.packet);
        const slice = logEntries(later).find((entry) => entry.status === undefined && entry.path === "worker:///large.md" && entry.logPath !== row.logPath)!;
        assert.match(String(slice.body), /2(?:<@[0-9A-Za-z]{5}>|:)2: evidence/u);
        assert.match(String(slice.body), /3(?:<@[0-9A-Za-z]{5}>|:)3: evidence/u);
        const look = await engine.look({ statement: readStmt(urlPath("worker", "/large.md"), { marks: [1, -1] }), workspaceId, workerId, loopId });
        assert.equal(look.status, 200);
        assert.equal((look as { content?: string }).content, content, "the complete result is where it was read from");
    } finally {
        await db.close();
    }
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
        const provider = providerAt(24_000, [
            response(`\`\`\`\`READ (worker:///filler.md)\`\`\`\`\n${continuing}`),
            response([
                "````READ (worker:///wanted.md)````",
                "````KILL (log:///1/*/*/READ)````",
                "````READ (worker:///wanted.md)````",
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

test("{§context-hard-413}: an impossible floor terminates the loop without provider calls or manufactured operations", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-floor-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const provider = providerAt(2, [response(continuing)]);
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, messages, provider, maxTurns: 3 });
        assert.equal(result.result.status, 413);
        assert.equal(result.result.problem?.detail, "Context budget overflow: the packet's tokens exceed its budget; retained context cannot fit."); // {§pinned-wording-core}
        assert.equal(result.reason, "token_budget");
        assert.equal(provider.remaining, 1);
        const turn = await db.test_get_turn.get<{ kind: string; producer: string; packet: string | null; status: number }>({ id: result.turnIds.at(-1)! });
        assert.equal(turn!.kind, "inference");
        assert.equal(turn!.producer, "model");
        assert.equal(turn!.status, 413);
        assert.equal(turn!.packet, null, "a request that was never submitted is not provider evidence");
        const rows = await db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: result.turnIds.at(-1)! });
        assert.ok(rows.every(({ op }) => !["WAIT", "DONE", "FAIL", "KILL"].includes(op)), "no recovery disposition or curation program is manufactured");
    } finally { await db.close(); }
});

test("{§context-hard-413}: authored state is never pruned to manufacture a fit", async () => {
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
        const small = providerAt(12_000, [response(continuing)]);
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: small });
        assert.equal(second.status, 413);
        assert.equal(second.curationFailure?.problem?.detail, "Context budget overflow: the packet's tokens exceed its budget; retained context cannot fit."); // {§pinned-wording-core}
        assert.deepEqual(second.curationFailure?.problem && Object.keys(second.curationFailure.problem).filter((key) => ["tokens", "budget", "excess"].includes(key)).sort(), ["budget", "excess", "tokens"], "the terminal names tokens, budget and excess");
        assert.equal(small.remaining, 1);
        const after = await db.engine_render_log.all({ worker_id: workerId });
        assert.deepEqual(after, before, "authored state cannot be removed to manufacture a fit");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; folded: string }>({ turn_id: first.turnId });
        assert.equal(rows.find(({ op }) => op === "NOTE")!.folded, "[]");
        assert.equal(JSON.parse(rows.find(({ op }) => op === "NOTE")!.tx).body, note);
    } finally { await db.close(); }
});

for (const origin of ["plugin", "_plurnk"] as const) test(`{§context-fit}: ${origin} output crosses maintenance and loop boundaries whole, result and all`, async () => {
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
