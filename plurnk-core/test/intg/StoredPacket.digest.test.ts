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
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { urlPath } from "./_dsl.ts";

test("{§log-history-projection}: digest retains KILLed turn programs as chronological artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-killed-turn-artifact-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const sources = [
        "# PLAN0\n[]\n## SEND0 [102]\nContinue one.",
        "# PLAN0\n[]\n## SEND0 [102]\nContinue two.",
        "# PLAN0\n[]\n## KILL0 (log:///1/[1-2]/*/ops)\n## SEND0 [102]\nContinue three.",
    ];
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "killed-turn-artifact");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "curate history");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const insertTurnOps = async (turnId: number, source: string, initialFolded: string): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
                origin: "model", source: null, model_call_id: null,
                op: null, delimiter: "", signal: null,
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: null, query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/vnd.plurnk",
                rx: JSON.stringify({ content: source, mimetype: "text/vnd.plurnk" }),
                mimetype_rx: "application/json", status_rx: 200, weight: 1,
                state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "turnOps" }),
                initial_folded: initialFolded,
            });
            if (row === undefined) throw new Error("turnOps insert returned no row");
            return row.id;
        };
        const retiredIds: number[] = [];
        for (const source of sources.slice(0, 2)) {
            const turnId = (await Turn.open(db, {
                loopId,
                producer: "model",
                kind: "inference",
            })).id;
            retiredIds.push(await insertTurnOps(turnId, source, "[[1,-1]]"));
            await Turn.complete(db, turnId, 200);
        }

        const curationTurn = (await Turn.open(db, {
            loopId,
            producer: "model",
            kind: "inference",
        })).id;
        await insertTurnOps(curationTurn, sources[2]!, "[[1,-1]]");
        const kill: KillStatement = {
            metadata: null,
            op: "KILL", annotation: null, delimiter: "", signal: null,
            target: urlPath("log", "/1/[1-2]/*/ops"), lineMarker: null, body: null,
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: kill,
            workspaceId, workerId, loopId, turnId: curationTurn, sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(result.matched, 2, "the real broad KILL retires both prior turn programs");
        await Turn.complete(db, curationTurn, 200);

        const active = await db.engine_render_log.all<{ id: number }>({ worker_id: workerId });
        assert.ok(retiredIds.every((id) => !active.some((row) => row.id === id)), "retired programs leave the current packet projection");
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
            log_entries: Array<{ id: number; projection: { active: boolean } }>;
            log_curation_effects: Array<{ active_before: boolean; active_after: boolean }>;
        };
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
    const inferenceSource = [
        "# PLAN0",
        "* Preserve this exact admitted program.",
        "## SEND0 [200]",
        "done",
    ].join("\n");
    let overflowSource = "";
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
        assert.equal(overflow.producer, "_plurnk");
        assert.equal(overflow.kind, "overflow");
        assert.equal(constrained.remaining, 1, "the real overflow turn performs no provider call");

        const turns = await db.test_list_turns_in_loop.all<{ id: number }>({ loop_id: loopId });
        const initializationRows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            attrs: string;
            rx: string;
        }>({ turn_id: turns[0]!.id });
        const sourceRow = initializationRows.find(({ op, attrs }) =>
            op === null && JSON.parse(attrs).kind === "turnOps");
        initializationSource = JSON.parse(sourceRow?.rx ?? "null").content;
        assert.match(initializationSource, /^# PLAN0\n/);
        const overflowRows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            attrs: string;
            rx: string;
            folded: string;
        }>({ turn_id: overflow.turnId });
        const overflowTurnOps = overflowRows.find(({ op, attrs }) =>
            op === null && JSON.parse(attrs).kind === "turnOps");
        overflowSource = JSON.parse(overflowTurnOps?.rx ?? "null").content;
        assert.match(overflowSource, /^# PLAN0\n\[\{"content":"Automatically FOLD log bodies newly active at token-budget overflow\.","status":"in_progress"}\]\n## FOLD0 /, "the digest specimen is the actual admitted recovery program");
        assert.match(overflowSource, /\n## SEND0 \[102\]\nNext: YOU MUST ONLY FOLD, KILL, or trim ALL superseded, stale, or irrelevant log content in bulk\.$/);
        assert.equal(overflowTurnOps?.folded, "[[1,-1]]", "the real recovery source is durably folded");
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

        assert.equal(await readFile(join(digestDir, "packet002.assistant.md"), "utf8"), overflowSource);
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

test("{§digest-forensic-fidelity}: one malformed historical packet remains exact evidence without aborting later turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-malformed-packet-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const malformedPacket = JSON.stringify({
        weight: 0,
        sections: [{ name: "", slot: "user", header: null, content: "historic", weight: 0 }],
        attributions: [],
    });
    const healthyPacket = StoredPacket.stringify({
        weight: 0,
        sections: [{ name: "prompt", slot: "user", header: null, content: "later", weight: 0 }],
        attributions: [],
    });
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "malformed-packet");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "retain the complete history");
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 500, packet: malformedPacket });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 502, packet: healthyPacket });
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
        assert.equal(diagnostic.turnId, 1);
        assert.match(diagnostic.error.message, /digest turn 1 has an invalid packet shape/);
        assert.match(diagnostic.error.cause.message, /sections\[0\]\.name must be a non-empty string/);

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
        assert.match(json.turns[0].packet_failure.error.cause.message, /name must be a non-empty string/);
        assert.equal(json.turns[1].packet_failure, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
