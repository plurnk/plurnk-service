import test, { describe } from "node:test";
import assert from "node:assert/strict";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import Daemon from "../../src/server/Daemon.ts";
import { mkdtemp, readFile, rm, access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelProvider, Mock, type MockResponse } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { Digest, Share } from "@plurnk/plurnk-digest";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, insertPacketTurn } from "./_db.ts";
import { digestStems } from "./_packet.ts";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { type KillStatement } from "@plurnk/plurnk-contracts";
import { urlPath } from "./_dsl.ts";
import { missingDigestDirs, recoverDigest } from "../../bin/digest-missing.ts";
import { rpcCall, connect } from "./_rpc.ts";


describe("Digest.wire-evidence", () => {
test("{§emission-history} {§digest-forensic-fidelity}: stored and shared requests preserve interpolated assistant messages byte for byte", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "interpolated-evidence-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const frame = PlurnkParser.frame;
    const provider = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: frame("EDIT (workspace:///memo.md)", "The complete replacement."), reasoning: null } },
        { assistant: { content: frame("READ (workspace:///memo.md)", null), reasoning: null } },
        { assistant: { content: frame("SEND [200]", "Done."), reasoning: null } },
    ] });
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "interpolated-evidence");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "Write and read.");
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 3);
    } finally { await db.close(); }
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { turns: Array<{ producer: string; artifact: string }> };
    const turns = report.turns.filter(({ producer }) => producer === "model");
    assert.equal(turns.length, 3);
    for (const [index, { artifact }] of turns.entries()) {
        const wire = JSON.parse(await readFile(join(digestDir, `${artifact}.wire.json`), "utf8"));
        assert.deepEqual(wire, provider.received[index], "the stored packet reconstructs what the provider received");
        const request = await readFile(join(digestDir, `${artifact}.request.md`), "utf8");
        let cursor = 0;
        for (const message of wire as Array<{ role: string; content: string }>) {
            const at = request.indexOf(message.content, cursor);
            assert.ok(at >= cursor, `${artifact}: the navigable request retains ${message.role} text in order`);
            cursor = at + message.content.length;
        }
    }
    assert.deepEqual(provider.received[2].map(({ role }) => role), ["system", "user", "assistant", "user", "assistant", "user"], "EDIT and READ each retain their own assistant/result boundary");
});

test("{§provider-failure-normalization}: blank emissions retain their wire channels through persistence and digest", async () => {
    // The surveys are the initialization program; with the preview off there is none and no digest stem for it.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "wire-evidence-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        let requests = 0;
        const provider = new ModelProvider({
            model: "wire-evidence", url: "https://example.test/v1/chat/completions",
            fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            contextWindow: 100000, outputBudget: 1000,
            effort: { mode: "off", budget: null }, temperature: null, repeatPenalty: null, retryAttempts: 0,
            rawBody: false,
            // {§provider-failure-normalization}: ordinary empty-turn recovery follows the warning.
            fetch: async () => {
                requests += 1;
                if (requests > 1) {
                    return new Response(`data: ${JSON.stringify({
                        id: "text", model: "wire-evidence",
                        choices: [{ index: 0, delta: { content: "````SEND [200]\nInspected.\n````" }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
                    })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
                }
                return new Response(`data: ${JSON.stringify({
                    id: "blank-tools", model: "wire-evidence",
                    choices: [{ index: 0, delta: {
                        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "READ", arguments: '{"path":"example.txt"}' } }],
                        refusal: "retained vendor text",
                    }, finish_reason: "tool_calls" }],
                    usage: { prompt_tokens: 10, completion_tokens: 13, total_tokens: 23 },
                })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "wire-evidence");
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            // A workspace entry, so the workspace survey selects something and the initialization program exists.
            await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
            const loopId = await insertLoop(db, sessionId, 1, "inspect");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 3, messages: [{ role: "user", content: "Inspect." }] });
            assert.equal(result.result.status, 200);
            assert.equal(result.turnIds.length, 3, "initialization, one empty turn, then the answer");
            const first = result.turnIds[1];
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "no provider retry or parser rejection");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: first });
            assert.deepEqual(rows.filter(({ op }) => op === "error").map(({ rx }) => JSON.parse(rx).problem.detail), ["The turn performed no operation."]);
        } finally {
            await db.close();
        }
        assert.equal(requests, 2, "the model recovers on the next ordinary turn");
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        const raw = JSON.parse(await readFile(join(digestDir, `${stems[1]}.assistantRaw.json`), "utf8"));
        assert.equal(raw.rawBody, undefined);
        assert.deepEqual(raw.wire.toolCalls, [
            { index: 0, id: "call-1", type: "function", name: "READ", arguments: '{"path":"example.txt"}' },
        ]);
        assert.deepEqual(raw.wire.channels, { refusal: "retained vendor text" });
        assert.equal(await readFile(join(digestDir, `${stems[2]}.assistant.md`), "utf8"), "````SEND [200]\nInspected.\n````");
        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.doesNotMatch(report, /rejected-emissions=/);
        assert.match(await readFile(join(digestDir, `${stems[2]}.user.md`), "utf8"), /native tool calls, but no tools were declared/);
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});
});


describe("Share", () => {
test("{§share} {§share}: a scoped share preserves a checkpointed source and holds one workspace", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const kept = await insertWorkspace(db, "kept");
    const other = await insertWorkspace(db, "other");
    await insertLoop(db, await insertSession(db, kept, null, "alice"), 1, "kept task");
    await insertLoop(db, await insertSession(db, other, null, "bob"), 1, "other task");
    // Main-file byte equality requires committed pages outside the WAL first.
    try {
        await db.test_checkpoint.run();
        assert.equal(statSync(`${dbPath}-wal`).size, 0);
    } finally {
        await db.close();
    }
    const before = readFileSync(dbPath);

    const folder = join(root, "shares", "share_this_session_here");
    const shared = await Share.write({ openEvidence: EvidenceReader.open, dbPath, folder, workspaceId: kept });

    assert.deepEqual(shared, { folder });
    assert.ok(existsSync(join(folder, "digest.md")));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["kept"]);
    const after = readFileSync(dbPath);
    assert.ok(after.equals(before), `the database itself is only read: bytes ${before.length} -> ${after.length}, first change ${after.findIndex((byte, index) => byte !== before[index])}`);
});

test("{§share}: a folder that already holds files, the database's own included, is refused and never cleared", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-overlap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await (await openMigrated(dbPath)).close();
    await assert.rejects(Share.write({ openEvidence: EvidenceReader.open, dbPath, folder: root }), { message: `${root} already exists and is not an empty folder; remove it first` });
    assert.ok(existsSync(dbPath));
});

test("{§share-packet-names}: a snapshot of an open WAL database keeps the commits a byte copy drops; an existing copy is refused", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-snapshot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    t.after(() => db.close());
    await insertWorkspace(db, "committed-in-wal");
    const workspacesOf = (copy: string, digestDir: string): string[] => {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath: copy, digestDir });
        return (JSON.parse(readFileSync(join(digestDir, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> }).workspaces.map(({ name }) => name);
    };

    const bytes = join(root, "bytes.db");
    copyFileSync(dbPath, bytes);
    assert.deepEqual(workspacesOf(bytes, join(root, "bytes")), [], "the byte copy holds the migrated schema, but not the commit still in the -wal file");
    const copy = join(root, "snapshot.db");
    Share.snapshot(dbPath, copy);
    assert.deepEqual(workspacesOf(copy, join(root, "snapshot")), ["committed-in-wal"]);
    assert.throws(() => Share.snapshot(dbPath, copy), { message: `${copy} already exists; remove it first` });
});
});

describe("StoredPacket.digest", () => {
test("{§digest-forensic-fidelity}: unknown actionless rows remain evidence without hiding turn programs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-unknown-source-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    const source = "````SEND\ndone\n````";
    try {
        const workspaceId = await insertWorkspace(db, "unknown-source");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect history");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.recordSource(db, turn.id, "ops", source);
        for (const [index, kind] of ["reasoning", "unknown", "emissionAttempt"].entries()) {
            await db.engine_insert_log_entry.get({
                session_id: sessionId, loop_id: loopId, turn_id: turn.id, sequence: index + 1,
                origin: "model", source: null, model_call_id: null,
                op: null,
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: null, query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/vnd.plurnk",
                rx: JSON.stringify({ content: kind, mimetype: "text/vnd.plurnk" }),
                mimetype_rx: "application/json", status_rx: 200, weight: 1,
                state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "emissionAttempt" }),
                initial_folded: "[]",
            });
        }
        await Turn.complete(db, turn.id, 200);
        await db.test_make_historical_actionless_rows();
    } finally {
        await db.close();
    }
    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        assert.equal(await readFile(join(digestDir, `${stems[0]}.assistant.md`), "utf8"), source);
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(json.log_entries.length, 3, "no source row is discarded or rewritten");
        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(report, /unrecognized actionless row.*reasoning/);
        assert.match(report, /unrecognized actionless row.*unknown/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§log-history-projection}: digest retains programs after all source READ receipts are KILLed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-killed-turn-artifact-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const sources = [
        "````NOTE\nContinue one.\n````",
        "````NOTE\nContinue two.\n````",
        "````KILL (log:///1/[1-2]/*/READ)````\n````NOTE\nContinue three.\n````",
    ];
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "killed-turn-artifact");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "curate history");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const observeProgram = async (turnId: number, source: string): Promise<number> => {
            await Turn.recordSource(db, turnId, "ops", source);
            const turn = (await db.test_get_turn.get<{ sequence: number }>({ id: turnId }))!;
            const result = await engine.dispatch({
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                statement: {
                    op: "READ", aside: null, metadata: null, matcher: null, body: null,
                    target: { ...urlPath("ops", `/1/${turn.sequence}`), hostname: "analyst", raw: `ops://analyst/1/${turn.sequence}` }, lineMarker: { marks: [1, -1] },
                    position: { line: 1, column: 1 },
                },
            });
            assert.equal(result.status, 200);
            return (await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: turnId }))[0].id;
        };
        const retiredIds: number[] = [];
        for (const source of sources.slice(0, 2)) {
            const turnId = (await Turn.open(db, {
                loopId,
                producer: "model",
                kind: "inference",
            })).id;
            retiredIds.push(await observeProgram(turnId, source));
            await Turn.complete(db, turnId, 200);
        }

        const curationTurn = (await Turn.open(db, {
            loopId,
            producer: "model",
            kind: "inference",
        })).id;
        await Turn.recordSource(db, curationTurn, "ops", sources[2]);
        const kill: KillStatement = {
            metadata: null,
            op: "KILL", aside: null,
            target: urlPath("log", "/1/[1-2]/*/READ"), lineMarker: null, matcher: null, body: null,
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: kill,
            workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(result.matched, 2, "the real broad KILL retires both prior source READ receipts");
        await Turn.complete(db, curationTurn, 200);

        const active = await db.engine_render_log.all<{ id: number }>({ session_id: sessionId });
        assert.ok(retiredIds.every((id) => !active.some((row) => row.id === id)), "retired READ receipts leave the current packet projection");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        for (const [index, source] of sources.entries()) {
            assert.equal(
                await readFile(join(digestDir, `${stems[index]}.assistant.md`), "utf8"),
                source,
                "broad curation cannot erase any admitted turn artifact",
            );
        }
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ program: string | null }>;
            log_entries: Array<{ id: number; projection: { active: boolean } }>;
            log_curation_effects: Array<{ active_before: boolean; active_after: boolean }>;
        };
        assert.deepEqual(json.turns.map(({ program }) => program), sources, "structured forensic output retains every exact program too");
        assert.equal(
            json.log_entries.filter(({ projection }) => !projection.active).length,
            2,
            "the artifact records both retired current projections",
        );
        assert.deepEqual(
            json.log_curation_effects.map(({ active_before, active_after }) => [active_before, active_after]),
            [[true, false], [true, false]],
            "the digest retains every exact broad-KILL transition",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§share-packet-names}: digest preserves source channels without fabricating provider participation", async () => {
    // The surveys are the initialization program; with the preview off there is none, so this witness turns it on.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-turn-artifacts-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const db = await openMigrated(dbPath);
        const inferenceSource = "````SEND\ndone\n````";
        let initializationSource = "";
        try {
            const workspaceId = await insertWorkspace(db, "turn-artifacts");
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            // A workspace entry, so the workspace survey selects something and the initialization program exists.
            await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
            const loopId = await insertLoop(db, sessionId, 1, "conclude");
            const response = {
                assistant: { content: inferenceSource, reasoning: null },
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            } as MockResponse;
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [response] }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "Conclude." }],
            });

            const previousOutput = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
            const previousReasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            // {§tokenomics} — an eleven-token window holds no packet: the turn ends
            // before any provider call, packetless.
            process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
            delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            const constrained = new Mock({ contextWindow: 11, responses: [response] });
            if (previousOutput === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
            else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previousOutput;
            if (previousReasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previousReasoning;
            const overflow = await engine.runTurn({
                provider: constrained,
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "Conclude." }],
                turnNumber: 2,
            });
            assert.equal(overflow.producer, "model");
            assert.equal(overflow.kind, "inference");
            assert.equal(overflow.status, 413);
            assert.equal(constrained.remaining, 1, "the rejected candidate performs no provider call");

            const turns = await db.test_list_turns_in_loop.all<{ id: number }>({ loop_id: loopId });
            const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            initializationSource = programs.find(({ turn_id, kind }) => turn_id === turns[0].id && kind === "ops")!.content;
            assert.ok(!programs.some(({ turn_id, kind }) => turn_id === turns[0].id && kind === "reasoning"), "initialization authors no reasoning ({§session-initialization-entry})");
            assert.ok(!programs.some(({ turn_id }) => turn_id === overflow.turnId), "no recovery program was executed or fabricated");
        } finally {
            await db.close();
        }

        try {
            Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
            const stems = await digestStems(digestDir);
            assert.deepEqual(stems, ["analyst-1-1", "analyst-1-2"], "source-backed initialization and inference retain their log coordinates");
            assert.equal(
                await readFile(join(digestDir, "analyst-1-1.assistant.md"), "utf8"),
                initializationSource,
                "a packetless turn's program remains exact forensic evidence",
            );
            await assert.rejects(() => access(join(digestDir, "analyst-1-1.reasoning.md")), { code: "ENOENT" });
            await assert.rejects(() => access(join(digestDir, `${stems[0]}.system.md`)), { code: "ENOENT" });
            await assert.rejects(() => access(join(digestDir, `${stems[0]}.user.md`)), { code: "ENOENT" });
            await assert.rejects(() => access(join(digestDir, `${stems[0]}.assistantRaw.json`)), { code: "ENOENT" });

            assert.equal(await readFile(join(digestDir, `${stems[1]}.assistant.md`), "utf8"), inferenceSource);
            await access(join(digestDir, `${stems[1]}.system.md`));
            await access(join(digestDir, `${stems[1]}.user.md`));
            await access(join(digestDir, `${stems[1]}.assistantRaw.json`));

            assert.equal(stems.length, 2, "only the two durable turns wrote artifacts");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§share-packet-names} Digest: operation and request-only turns remain visibly distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-packet-algebra-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "packet-algebra");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "packet states");
        for (const producer of ["client", "_plurnk"] as const) {
            const operation = await Turn.open(db, { loopId, producer, kind: "operation" });
            await Turn.complete(db, operation.id, 200);
        }
        await db.test_turns_insert.run({
            loop_id: loopId,
            sequence: 3,
            status: 502,
            packet: StoredPacket.stringify({ weight: 0, sections: [], attributions: [] }),
        });
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        await assert.rejects(() => access(join(digestDir, `${stems[0]}.packet.md`)));
        assert.match(
            await readFile(join(digestDir, `${stems[0]}.response.md`), "utf8"),
            /No provider response was admitted/,
        );
        await assert.rejects(
            () => access(join(digestDir, `${stems[1]}.response.md`)),
            { code: "ENOENT" },
            "source-less programmatic turns create no artifact ordinals",
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Tokens:\s+no provider requests/);
        assert.match(markdown, /Cost:\s+n\/a/);
        assert.match(markdown, /T1: producer=client kind=operation status=200/);
        assert.doesNotMatch(markdown, /T1:.*(?:model=|input=|cost=)/);
        assert.match(markdown, /T2: producer=_plurnk kind=operation status=200/);
        assert.match(markdown, /T3 \(model turn 1 · [A-Za-z0-9_.-]+-\d+-\d+\):.*\n  ↳ request: input sections not retained \([^\n]+\.request\.md\)\n  ↳ emission: \(none admitted\)/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§digest-forensic-fidelity}: native attachment selection remains distinct from an empty or absent request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-attachment-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const attachment = {
        contentHash: "a".repeat(64),
        coordinate: "log:///1/2/2/READ", path: "board.png", scheme: "file", pathname: "board.png",
        mimetype: "image/png", kind: "image" as const, weight: 547, width: 640, height: 640,
    };
    const packet = { weight: 0, sections: [], attributions: [] };
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "attachment-digest");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect delivery");
        for (const [index, stored] of [
            StoredPacket.stringify({ ...packet, attachments: [attachment] }),
            StoredPacket.stringify(packet),
            null,
        ].entries()) {
            await db.test_turns_insert.run({ loop_id: loopId, sequence: index + 1, status: 200, packet: stored });
        }
    } finally { await db.close(); }
    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.deepEqual(json.turns.map((turn: { attachments: unknown }) => turn.attachments), [[attachment], [], null]);
        const page = await readFile(join(digestDir, `${json.turns[0].artifact}.request.md`), "utf8");
        assert.match(page, /## Native attachments/u);
        assert.match(page, /selection alone does not prove transport or provider acceptance/u);
        assert.ok(page.includes(JSON.stringify(attachment, null, 2).split("\n")[1].trim()));
        assert.match(page, /board\.png/u);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§digest-forensic-fidelity}: one malformed historical packet remains exact evidence without aborting later turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-malformed-packet-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    // {§packet} — the bag's CHECK admits this (attributions is an array); the packet shape does
    // not (an attribution is a non-empty string). Historical evidence, stored straight into the bag.
    const malformedPacket = JSON.stringify({ weight: 0, attributions: [""] });
    const db = await openMigrated(dbPath);
    let malformedTurnId: number | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "malformed-packet");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "retain the complete history");
        malformedTurnId = (await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 1, status: 500, packet: malformedPacket }))!.id;
        await insertPacketTurn(db, loopId, 2, {
            weight: 0,
            sections: [{ name: "prompt", slot: "user", header: null, content: "later", weight: 0 }],
            attributions: [],
        }, 502);
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        assert.equal(
            await readFile(join(digestDir, `${stems[0]}.packet.raw.txt`), "utf8"),
            malformedPacket,
            "the diagnostic artifact preserves the stored text exactly",
        );
        const diagnostic = JSON.parse(await readFile(join(digestDir, `${stems[0]}.packet.invalid.json`), "utf8"));
        assert.equal(diagnostic.turnId, malformedTurnId);
        assert.match(diagnostic.error.message, new RegExp(`digest turn ${malformedTurnId} has an invalid packet shape`));
        assert.match(diagnostic.error.cause.message, /attributions\[0\] must be a non-empty string/);
        const page = await readFile(join(digestDir, `${stems[0]}.request.md`), "utf8");
        assert.match(page, /Stored packet is invalid; no input messages were reconstructed/u);
        assert.match(page, /attributions\[0\] must be a non-empty string/u);
        assert.ok(page.includes(`[Next](${stems[1]}.request.md)`));

        await access(join(digestDir, `${stems[1]}.system.md`));
        assert.equal(await readFile(join(digestDir, `${stems[1]}.user.md`), "utf8"), "later");
        await access(join(digestDir, `${stems[1]}.response.md`));

        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Stored packet failures: 1/);
        assert.match(markdown, /T1 \(model turn 1 · [A-Za-z0-9_.-]+-\d+-\d+\):.*packet=invalid/);
        assert.match(markdown, /T2 \(model turn 2 · [A-Za-z0-9_.-]+-\d+-\d+\):.*status=502/);

        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(json.turns.length, 2);
        assert.equal(json.turns[0].packet_failure.raw, malformedPacket);
        assert.match(json.turns[0].packet_failure.error.cause.message, /attributions\[0\] must be a non-empty string/);
        assert.equal(json.turns[1].packet_failure, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("digest-missing", () => {
test("{§test-artifact-retention} digest:missing selects only interrupted benchmark specimens", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-missing-"));
    try {
        const interrupted = join(root, "demo-interrupted-a1");
        const complete = join(root, "demo-complete-b2");
        const partial = join(root, "demo-partial-c3");
        const unrelated = join(root, "notes");
        await Promise.all([
            mkdir(interrupted),
            mkdir(join(complete, "digest"), { recursive: true }),
            mkdir(join(partial, "digest"), { recursive: true }),
            mkdir(unrelated),
        ]);
        await Promise.all([
            writeFile(join(interrupted, "plurnk.db"), ""),
            writeFile(join(complete, "plurnk.db"), ""),
            writeFile(join(complete, "digest", "digest.json"), "{}"),
            writeFile(join(partial, "plurnk.db"), ""),
            writeFile(join(partial, "digest", "digest.md"), "partial waterfall"),
            writeFile(join(partial, "digest", "digest.json.partial"), "{"),
            writeFile(join(unrelated, "readme.txt"), ""),
        ]);

        assert.deepEqual(missingDigestDirs(root), [interrupted, partial]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§test-artifact-retention} digest:missing replaces an interrupted partial digest with a complete one", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-recover-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = await openMigrated(join(root, "plurnk.db"));
    await db.close();
    await mkdir(join(root, "digest"));
    await writeFile(join(root, "digest", "digest.json.partial"), "{");

    recoverDigest(root);

    assert.deepEqual(JSON.parse(await readFile(join(root, "digest", "digest.json"), "utf8")).workspaces, []);
    assert.equal((await readdir(join(root, "digest"))).includes("digest.json.partial"), false);
});
});


describe("workspace-share", () => {
test("{§share}: workspace.share writes the workspace's share from the daemon's own database", { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-workspace-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const daemon = new Daemon({ db, dbPath, provider: new Mock({ contextWindow: 8192, responses: [] }) });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ws = await connect({ daemon });
    t.after(() => ws.close());
    await rpcCall(ws, 1, "workspace.create", { name: "not-shared" });
    await rpcCall(ws, 2, "workspace.create", { name: "shared-here" }); // creation attaches the connection
    const folder = join(root, "share_this_session_here");
    const shared = (await rpcCall(ws, 4, "workspace.share", { folder })).result as { folder: string };
    assert.deepEqual(shared, { folder });
    assert.ok(existsSync(join(folder, "digest.md")));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["shared-here"], "the share is the attached workspace alone");
    const refused = await rpcCall(ws, 5, "workspace.share", { folder: "relative/folder" });
    const problem = (refused.result as { status: number; problem: { detail: string } });
    assert.equal(problem.status, 400);
    assert.equal(problem.problem.detail, "workspace.share requires an absolute folder.");
});
});

