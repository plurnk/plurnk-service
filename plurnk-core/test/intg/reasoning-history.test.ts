import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import { Translator } from "@plurnk/plurnk-agui";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import Digest from "../../src/digest/Digest.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import LogEntry from "../../src/server/logEntry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { parseLogRecords } from "../LogRecords.ts";

const statement = (source: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseClient(source);
    assert.equal(parsed.unparsedTail, undefined);
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    assert.equal(item?.kind, "statement");
    if (item?.kind !== "statement") throw new Error("Missing parsed statement");
    return item.statement as PlurnkStatement;
};

type History = {
    id: number; sequence: number; turn_id: number; original: string;
    working: string | null; active: number; loop_seq: number; turn_seq: number;
};
const content = (body: string): string => (JSON.parse(body) as { content: string }).content;
const logOf = (packet: string): string => {
    const parsed = JSON.parse(packet) as { sections: { name: string; content: string }[] };
    return parsed.sections.find(({ name }) => name === "log")?.content ?? "";
};

test("reasoning history: model emission creates a hashed, editable working copy without rewriting forensic evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-reasoning-history-"));
    const dbPath = join(dir, "plurnk.db");
    let db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-history");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const original = Array.from({ length: 25 }, (_, index) => `Finding ${index + 1}: preserve evidence ${index + 1}.`).join("\n");
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: {
                content: "## PLAN0\n[]\n### SEND0 (TERM)\nReady.",
                reasoning: original,
            } }],
        });
        let engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const first = await engine.runTurn({ provider, workspaceId, workerId, loopId, turnNumber: 1, messages: [] });
        const rows = await db.test_reasoning_history.all<History>({ worker_id: workerId });
        assert.equal(rows.length, 1, "the reasoning is an ordinary log item");
        const row = rows[0]!;
        assert.equal(content(row.original), original);
        assert.equal(content(row.working!), original);
        await assert.rejects(() => db.test_reasoning_mutate_original.run({ id: row.id, rx: '{"content":"tampered"}' }), /original reasoning is immutable/);
        const path = `log:///${row.loop_seq}/${row.turn_seq}/${row.sequence}/reasoning`;
        const hashes = LineAnchors.tokens(path, original);
        let sequence = 10;
        const dispatch = (source: string) => engine.dispatch({
            statement: statement(source), workspaceId, workerId, loopId,
            turnId: first.turnId, sequence: sequence++, origin: "model",
        });

        const read = await dispatch(`### READ0 (${path}) <1,-1>`);
        assert.equal(read.status, 200);
        assert.equal((read as { content?: string }).content, original);
        assert.deepEqual((read as { lineAnchors?: string[] }).lineAnchors, hashes);
        const shorthand = await dispatch(`### READ0 (${path.replace(/\/reasoning$/, "")}) <1,-1>`);
        assert.deepEqual((shorthand as { lineAnchors?: string[] }).lineAnchors, hashes, "short and canonical addresses share anchor identity");

        const nextProvider = new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: "## PLAN0\n[]\n### SEND0 (TERM)\nDone.", reasoning: null,
        } }] });
        const next = await engine.runTurn({ provider: nextProvider, workspaceId, workerId, loopId, turnNumber: 2, messages: [] });
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: next.turnId });
        assert.ok(packet);
        const rendered = parseLogRecords(logOf(packet.packet)).find((record) => record.path === path);
        assert.ok(rendered, "the next packet presents reasoning as normal log content");
        assert.match(logOf(packet.packet), new RegExp(`${hashes[24]} +25:Finding 25:`), "reasoning is not clipped to a retrieval preview");

        const edit = await dispatch(`### EDIT0 (${path}) <${hashes[0]}>
Retained determination.`);
        assert.equal(edit.status, 200, JSON.stringify(edit));
        assert.equal((await dispatch(`### EDIT0 (${path}) <${hashes[0]}>\nStale overwrite.`)).status, 409);
        const changed = (await db.test_reasoning_history.all<History>({ worker_id: workerId }))[0]!;
        assert.equal(content(changed.original), original, "the original log evidence is immutable");
        assert.match(content(changed.working!), /^Retained determination\./);
        const firstPacket = await db.test_get_packet.get<{ packet: string }>({ id: first.turnId });
        assert.equal((JSON.parse(firstPacket!.packet) as { assistant: { reasoning: string } }).assistant.reasoning, original);
        assert.equal((await dispatch(`### READ0 (${path}) <1>` ) as { content?: string }).content, "Retained determination.");
        const badChannel = await dispatch(`### EDIT0 (${path}#missing) <1>\nMust not replace the default body.`);
        assert.equal(badChannel.status, 404, JSON.stringify(badChannel));
        assert.match(badChannel.problem!.type, /channel-not-found$/);
        const found = await dispatch(`### FIND0 (${path})\n~Retained`);
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.equal((found as { matchLocationCount?: number }).matchLocationCount, 1);
        assert.equal((await dispatch(`### EDIT0 (${path}) <1>\nRevised conclusion.`)).status, 200);
        const outdated = await dispatch(`### FIND0 (${path})\n~Retained`);
        assert.equal(outdated.status, 204, JSON.stringify(outdated));
        assert.equal((outdated as { matchLocationCount?: number }).matchLocationCount, 0, "search cannot retain the old working copy");
        const current = await dispatch(`### FIND0 (${path})\n~Revised`);
        assert.equal(current.status, 200, JSON.stringify(current));
        assert.equal((current as { matchLocationCount?: number }).matchLocationCount, 1);
        assert.equal((await dispatch(`### KILL0 (${path}) <2,4>`)).status, 200);
        assert.equal((await dispatch(`### EDIT0 (${path}) <0>\nPreface.`)).status, 200);
        const projection = await db.log_read_by_coordinate.get<{ folded: string }>({
            worker_id: workerId, loop_seq: row.loop_seq, turn_seq: row.turn_seq, sequence: row.sequence,
        });
        assert.equal(projection?.folded, "[[3,5]]", "earlier insertion moves the hidden passages without exposing them");
        const branchId = await Fork.fork(db, workerId, "reasoning-branch", {}, () => "none");
        const branched = (await db.test_reasoning_history.all<History>({ worker_id: branchId }))[0]!;
        await assert.rejects(() => db.test_reasoning_set_body_turn.run({ id: row.id, turn_id: branched.turn_id }), /same worker/);
        assert.equal(content(branched.original), original);
        assert.match(content(branched.working!), /^Preface\.\nRevised conclusion\./);
        const branchLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: branchId });
        assert.ok(branchLoop);
        const branchEdit = await engine.dispatch({
            statement: statement(`### EDIT0 (${path}) <1>\nBranch-only decision.`),
            workspaceId, workerId: branchId, loopId: branchLoop.id,
            turnId: branched.turn_id, sequence: sequence++, origin: "model",
        });
        assert.equal(branchEdit.status, 200, JSON.stringify(branchEdit));
        assert.match(content((await db.test_reasoning_history.all<History>({ worker_id: workerId }))[0]!.working!), /^Preface\./);
        await db.close();
        db = await openMigrated(dbPath);
        engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        assert.match(content((await db.test_reasoning_history.all<History>({ worker_id: branchId }))[0]!.working!), /^Branch-only decision\./);
        assert.equal((await dispatch(`### EDIT0 (log:///${row.loop_seq}/${row.turn_seq}/${row.sequence + 1}/PLAN) <1,-1>\n[]`)).status, 403, "ordinary operation history is not made writable");
        assert.equal((await dispatch(`### EDIT0 (${path})\nAccidental replacement.`)).status, 400);
        assert.equal((await dispatch(`### EDIT0 (log:///1/99/1/reasoning) <0>\nInvented history.`)).status, 404);
        const currentBody = content((await db.test_reasoning_history.all<History>({ worker_id: workerId }))[0]!.working!);
        const currentHashes = LineAnchors.tokens(path, currentBody);
        assert.equal((await dispatch(`### EDIT0 (${path.replace(/\/reasoning$/, "")}) <${currentHashes[0]},${currentHashes[1]}>\nCompact conclusion.`)).status, 200,
            "hash ranges work through the coordinate shorthand");
        assert.equal((await dispatch(`### EDIT0 (${path}) <1,1,1,8>\nBrief`)).status, 200, "character regions use ordinary text coordinates");
        assert.equal((await dispatch(`### EDIT0 (${path}) <-1>\nEpilogue.`)).status, 200);
        const revised = await dispatch(`### READ0 (${path}) <1,-1>`);
        assert.equal(revised.status, 200);
        assert.ok("content" in revised && typeof revised.content === "string");
        assert.match(revised.content, /^Brief conclusion\.[\s\S]*Epilogue\.$/);
        assert.equal((await dispatch(`### EDIT0 (${path}) <1,-1>`)).status, 200, "an empty replacement removes the working body's text");
        const empty = await dispatch(`### READ0 (${path}) <1,-1>`);
        assert.equal(empty.status, 204, "empty text uses the ordinary READ No Content result");
        assert.ok("content" in empty);
        assert.equal(empty.content, "");
        assert.equal((await dispatch(`### KILL0 (${path})`)).status, 200);
        assert.equal((await dispatch(`### READ0 (${path})`)).status, 404);
        const killed = (await db.test_reasoning_history.all<History>({ worker_id: workerId }))[0]!;
        assert.equal(killed.active, 0);
        assert.equal(content(killed.original), original);
        const journalIds = await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: first.turnId });
        const journal = await Promise.all(journalIds.map(({ id }) => LogEntry.fetchLogEntry(db, id)));
        const replay = new Translator({ threadId: "history", runId: "reattach" }).replay(journal);
        const snapshot = replay.find(({ type }) => type === "MESSAGES_SNAPSHOT");
        assert.ok(snapshot?.type === "MESSAGES_SNAPSHOT");
        assert.deepEqual(snapshot.messages.filter(({ role }) => role === "reasoning").map((message) => (message as { content: string }).content), [original],
            "AG-UI reattachment preserves the original exactly once after working-copy edits and retirement");
        const digestDir = join(dir, "digest");
        Digest.run({ dbPath, digestDir, workerId });
        const forensicReasoning = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.ok(forensicReasoning.includes(original), "digest retains the entire original after EDIT and KILL");
        assert.ok(!forensicReasoning.includes("Retained determination."), "the curated copy cannot masquerade as the original reasoning");
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

const providerWithCapacity = (capacity: number, responses: MockResponse[]): Mock => {
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

for (const expanded of [false, true]) test(`{§reasoning-history}: overflow curates ${expanded ? "an older copy expanded by EDIT" : "new reasoning"} through ordinary KILL`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-overflow-${expanded}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const large = Array.from({ length: 120 }, (_, index) => `Finding ${index}: ${"evidence ".repeat(16)}`).join("\n");
        const original = expanded ? "The first determination." : large;
        const source = "## PLAN0\n[]\n### SEND0 (NEXT)\nContinue.";
        await engine.runTurn({
            provider: providerWithCapacity(999_000, [{ assistant: { content: source, reasoning: original } }]),
            workspaceId, workerId, loopId, turnNumber: 1, messages: [],
        });
        const row = (await db.test_reasoning_history.all<History>({ worker_id: workerId }))[0]!;
        const path = `log:///${row.loop_seq}/${row.turn_seq}/${row.sequence}/reasoning`;
        if (expanded) {
            const editTurn = await engine.runTurn({
                provider: providerWithCapacity(999_000, [{ assistant: {
                    content: `## PLAN0\n[]\n### EDIT0 (${path}) <1,-1>\n${large}\n### SEND0 (NEXT)\nReview the update.`,
                    reasoning: null,
                } }]), workspaceId, workerId, loopId, turnNumber: 2, messages: [],
            });
            const edits = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: editTurn.turnId });
            assert.equal(edits.find(({ op }) => op === "EDIT")?.status_rx, 200);
        }
        const next = (await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId }))!.next;
        const probe = await new PacketBuilder({ db, schemes, executors: () => undefined }).buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: next,
            provider: providerWithCapacity(999_000, []), gitStatus: null,
        });
        const provider = providerWithCapacity(probe.weight - 50, [{ assistant: {
            content: "## PLAN0\n[]\n### SEND0 (TERM)\nRecovered.", reasoning: null,
        } }]);
        const recovery = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(recovery.status, 102, JSON.stringify(recovery));
        assert.equal(provider.remaining, 1, "overflow never sends the oversized candidate to inference");
        const turn = await db.test_get_turn.get<{ producer: string; kind: string; packet: string | null }>({ id: recovery.turnId });
        assert.deepEqual({ producer: turn?.producer, kind: turn?.kind, packet: turn?.packet }, {
            producer: "_plurnk", kind: "overflow", packet: null,
        });
        const operations = await db.test_log_entries_by_turn.all<{ op: string; pathname: string; status_rx: number }>({ turn_id: recovery.turnId });
        assert.ok(operations.some(({ op, pathname, status_rx }) => op === "KILL" && pathname === path.slice("log://".length) && status_rx === 200), "the real recovery program targets the reasoning copy");
        const current = (await db.test_reasoning_history.all<History>({ worker_id: workerId }))[0]!;
        assert.equal(current.active, 1, "scoped KILL retains the receipt");
        assert.equal(content(current.original), original);
        assert.equal(content(current.working!), large, "curation suppresses lines without deleting the editable copy");
        const look = await engine.look({ statement: statement(`### READ0 (${path}) <1,-1>`), workspaceId, workerId, loopId });
        assert.equal(look.status, 200);
        assert.equal((look as { content?: string }).content, large);
        const recovered = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(recovered.status, 200, JSON.stringify(recovered));
        assert.equal(provider.remaining, 0, "the successor model gets its recovery opportunity");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: recovered.turnId });
        const projection = parseLogRecords(logOf(packet!.packet)).find((record) => record.path === path);
        assert.ok(projection);
        assert.ok(!("body" in projection), "the suppressed body stays out of the next packet");
    } finally {
        await db.close();
    }
});

test("{§reasoning-history}: absent reasoning adds no substitute and private retries do not leak into the working log", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-admission");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const source = "## PLAN0\n[]\n### SEND0 (NEXT)\nContinue.";
        for (const reasoning of [null, ""]) {
            await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning } }] }),
                workspaceId, workerId, loopId, messages: [],
            });
        }
        assert.deepEqual(await db.test_reasoning_history.all({ worker_id: workerId }), []);
        const admitted = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "invalid program", reasoning: "Private rejected reasoning." } },
            { assistant: { content: source, reasoning: "Admitted reasoning." } },
        ] }), workspaceId, workerId, loopId, messages: [] });
        assert.equal(admitted.emissionAttempts, 2);
        const failed = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "first invalid program", reasoning: "First private reasoning." } },
            { assistant: { content: "second invalid program", reasoning: "Second private reasoning." } },
            { assistant: { content: "last invalid program", reasoning: "Final rejected reasoning." } },
        ] }), workspaceId, workerId, loopId, messages: [] });
        assert.equal(failed.emissionExhausted, true);
        const rows = await db.test_reasoning_history.all<History>({ worker_id: workerId });
        assert.deepEqual(rows.map(({ original }) => content(original)), ["Admitted reasoning.", "Final rejected reasoning."]);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0], "all rejected originals remain in provider evidence");
    } finally {
        await db.close();
    }
});
