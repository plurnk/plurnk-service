import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import type { KillStatement } from "@plurnk/plurnk-contracts";
import Digest from "../../src/digest/Digest.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { urlPath } from "./_dsl.ts";

test("{§digest-forensic-fidelity}: unknown actionless rows remain evidence without hiding turn programs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-unknown-source-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    const source = "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
    try {
        const workspaceId = await insertWorkspace(db, "unknown-source");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "inspect history");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.recordSource(db, turn.id, "ops", source);
        for (const [index, kind] of ["reasoning", "unknown", "emissionAttempt"].entries()) {
            await db.engine_insert_log_entry.get({
                worker_id: workerId, loop_id: loopId, turn_id: turn.id, sequence: index + 1,
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
        Digest.run({ dbPath, digestDir });
        assert.equal(await readFile(join(digestDir, "packet000.assistant.md"), "utf8"), source);
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
        "```TASK\n[{\"content\":\"Continue one.\",\"status\":\"in_progress\"}]\n```",
        "```TASK\n[{\"content\":\"Continue two.\",\"status\":\"in_progress\"}]\n```",
        "```KILL (log:///1/[1-2]/*/READ)```\n```TASK\n[{\"content\":\"Continue three.\",\"status\":\"in_progress\"}]\n```",
    ];
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "killed-turn-artifact");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "curate history");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const observeProgram = async (turnId: number, source: string): Promise<number> => {
            await Turn.recordSource(db, turnId, "ops", source);
            const turn = (await db.test_get_turn.get<{ sequence: number }>({ id: turnId }))!;
            const result = await engine.dispatch({
                workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
                statement: {
                    op: "READ", aside: null, metadata: null, matcher: null, body: null,
                    target: urlPath("ops", `/1/${turn.sequence}`), lineMarker: { marks: [1, -1] },
                    position: { line: 1, column: 1 },
                },
            });
            assert.equal(result.status, 200);
            return (await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: turnId }))[0]!.id;
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
        await Turn.recordSource(db, curationTurn, "ops", sources[2]!);
        const kill: KillStatement = {
            metadata: null,
            op: "KILL", aside: null,
            target: urlPath("log", "/1/[1-2]/*/READ"), lineMarker: null, matcher: null, body: null,
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: kill,
            workspaceId, workerId, loopId, turnId: curationTurn, sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(result.matched, 2, "the real broad KILL retires both prior source READ receipts");
        await Turn.complete(db, curationTurn, 200);

        const active = await db.engine_render_log.all<{ id: number }>({ worker_id: workerId });
        assert.ok(retiredIds.every((id) => !active.some((row) => row.id === id)), "retired READ receipts leave the current packet projection");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        for (const [index, source] of sources.entries()) {
            assert.equal(
                await readFile(join(digestDir, `packet${String(index).padStart(3, "0")}.assistant.md`), "utf8"),
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

test("{§digest-turn-artifact-identity}: digest projects exact chronological turnOps and provider participation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-turn-artifacts-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    const inferenceSource = "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
    let initializationSource = "";
    try {
        const workspaceId = await insertWorkspace(db, "turn-artifacts");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "conclude");
        const response = {
            assistant: { content: inferenceSource, reasoning: null },
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as MockResponse;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response] }),
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "Conclude." }],
        });

        const previousOutput = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        const previousReasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "999999";
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        const constrained = new Mock({ contextWindow: 1_000_000, responses: [response] });
        if (previousOutput === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previousOutput;
        if (previousReasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previousReasoning;
        const overflow = await engine.runTurn({
            provider: constrained,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "Conclude." }],
            turnNumber: 2,
        });
        assert.equal(overflow.producer, "model");
        assert.equal(overflow.kind, "inference");
        assert.equal(overflow.status, 413);
        assert.equal(constrained.remaining, 1, "the rejected candidate performs no provider call");

        const turns = await db.test_list_turns_in_loop.all<{ id: number }>({ loop_id: loopId });
        const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        initializationSource = programs.find(({ turn_id, kind }) => turn_id === turns[0]!.id && kind === "ops")!.content;
        assert.match(initializationSource, /^````READ \(reasoning:/);
        assert.ok(!programs.some(({ turn_id }) => turn_id === overflow.turnId), "no recovery program was executed or fabricated");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        assert.equal(
            await readFile(join(digestDir, "packet000.assistant.md"), "utf8"),
            initializationSource,
            "the first durable turn projects its exact persisted turnOps",
        );
        await assert.rejects(() => access(join(digestDir, "packet000.system.md")), { code: "ENOENT" });
        await assert.rejects(() => access(join(digestDir, "packet000.user.md")), { code: "ENOENT" });
        await assert.rejects(() => access(join(digestDir, "packet000.assistantRaw.json")), { code: "ENOENT" });

        assert.equal(await readFile(join(digestDir, "packet001.assistant.md"), "utf8"), inferenceSource);
        await access(join(digestDir, "packet001.system.md"));
        await access(join(digestDir, "packet001.user.md"));
        await access(join(digestDir, "packet001.assistantRaw.json"));

        await assert.rejects(() => access(join(digestDir, "packet002.assistant.md")), { code: "ENOENT" });
        await assert.rejects(() => access(join(digestDir, "packet002.system.md")), { code: "ENOENT" });
        await assert.rejects(() => access(join(digestDir, "packet002.user.md")), { code: "ENOENT" });
        await assert.rejects(() => access(join(digestDir, "packet002.assistantRaw.json")), { code: "ENOENT" });
        await assert.rejects(() => access(join(digestDir, "packet003.assistant.md")), { code: "ENOENT" });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("Digest: operation and request-only turns remain visibly distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-packet-algebra-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "packet-algebra");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "packet states");
        for (const producer of ["client", "plugin"] as const) {
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
        Digest.run({ dbPath, digestDir });
        await assert.rejects(() => access(join(digestDir, "packet000.packet.md")));
        assert.match(
            await readFile(join(digestDir, "packet000.response.md"), "utf8"),
            /No provider response was admitted/,
        );
        await assert.rejects(
            () => access(join(digestDir, "packet001.response.md")),
            { code: "ENOENT" },
            "source-less programmatic turns create no artifact ordinals",
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Tokens:\s+no provider requests/);
        assert.match(markdown, /Cost:\s+n\/a/);
        assert.match(markdown, /T1: producer=client kind=operation status=200/);
        assert.doesNotMatch(markdown, /T1:.*(?:model=|input=|cost=)/);
        assert.match(markdown, /T2: producer=plugin kind=operation status=200/);
        assert.match(markdown, /T3:.*\n  ↳ emission: \(none admitted\)/);
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "inspect delivery");
        for (const [index, stored] of [
            StoredPacket.stringify({ ...packet, attachments: [attachment] }),
            StoredPacket.stringify(packet),
            null,
        ].entries()) {
            await db.test_turns_insert.run({ loop_id: loopId, sequence: index + 1, status: 200, packet: stored });
        }
    } finally { await db.close(); }
    try {
        Digest.run({ dbPath, digestDir });
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.deepEqual(json.turns.map((turn: { attachments: unknown }) => turn.attachments), [[attachment], [], null]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§digest-forensic-fidelity}: one malformed historical packet remains exact evidence without aborting later turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-malformed-packet-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    // {§packet-items} — the bag's CHECK admits this (attributions is an array); the packet shape does
    // not (an attribution is a non-empty string). Historical evidence, stored straight into the bag.
    const malformedPacket = JSON.stringify({ weight: 0, attributions: [""] });
    const db = await openMigrated(dbPath);
    let malformedTurnId: number | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "malformed-packet");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "retain the complete history");
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
        Digest.run({ dbPath, digestDir });
        assert.equal(
            await readFile(join(digestDir, "packet000.packet.raw.txt"), "utf8"),
            malformedPacket,
            "the diagnostic artifact preserves the stored text exactly",
        );
        const diagnostic = JSON.parse(await readFile(join(digestDir, "packet000.packet.invalid.json"), "utf8"));
        assert.equal(diagnostic.turnId, malformedTurnId);
        assert.match(diagnostic.error.message, new RegExp(`digest turn ${malformedTurnId} has an invalid packet shape`));
        assert.match(diagnostic.error.cause.message, /attributions\[0\] must be a non-empty string/);

        await access(join(digestDir, "packet001.system.md"));
        assert.equal(await readFile(join(digestDir, "packet001.user.md"), "utf8"), "later");
        await access(join(digestDir, "packet001.response.md"));

        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Stored packet failures: 1/);
        assert.match(markdown, /T1:.*packet=invalid/);
        assert.match(markdown, /T2:.*status=502/);

        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(json.turns.length, 2);
        assert.equal(json.turns[0].packet_failure.raw, malformedPacket);
        assert.match(json.turns[0].packet_failure.error.cause.message, /attributions\[0\] must be a non-empty string/);
        assert.equal(json.turns[1].packet_failure, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
