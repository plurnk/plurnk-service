import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

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
        assert.match(overflowSource, /^# PLAN0\nAutomatically FOLD log bodies newly active at token-budget overflow\.\n## FOLD0 /, "the digest specimen is the actual admitted recovery program");
        assert.match(overflowSource, /\n## SEND0 \[102\]\nNext: YOU MUST FOLD or KILL ALL superseded, stale, or irrelevant log items before continuing\.$/);
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
