import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";

test("input capacity subtracts the total output budget once; reasoning is only its subset", async () => {
    const KEYS = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const prev = KEYS.map((k) => process.env[k]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "3000";
    process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "1000";
    const db = await openMigrated();
    try {
        const run = async (contextWindow: number): Promise<string> => {
            const workspaceId = await insertWorkspace(db, `part-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "p");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow, responses: [response([sendStmt(200, "done")])] });
            const r = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            return packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: r.turnId }))!.packet), "budget");
        };
        assert.match(await run(10000), /tokensActiveMax: 7000/u, "the total output budget is subtracted once");
        assert.match(await run(5000), /tokensActiveMax: 2000/u, "a narrower window retains the same total output budget");
        await assert.rejects(() => run(3000), /must leave positive input capacity/, "an output envelope cannot consume the complete context window");
    } finally {
        KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
        await db.close();
    }
});

const sendStmt = (status: number, body: string): SendStatement => ({
    metadata: null,
    op: "SEND", annotation: null, delimiter: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

test("Engine.runTurn: context budget readout carries partition-derived maximum and assembled total", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 4000, responses: [response([sendStmt(200, "done")])] });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "go" }],
        });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { weight: number };
        const budget = packetSection(packet, "budget");
        // provider window 4000 − fixture total output budget 1280 = 2720
        assert.match(budget, /tokensActiveTotal:\s+\d+ \(\s*\d+%\)\ntokensActiveMax: 2720/u, "state carries the provider-derived maximum, assembled total, and percent");
        const usage = Number(/tokensActiveTotal:\s+(\d+)/.exec(budget)?.[1]);
        assert.ok(usage > 0 && usage < 2720, `active total ${usage} within (0, 2720)`);
        assert.equal(usage, packet.weight, "the model-facing token label projects the exact stored curation weight");
    } finally { await db.close(); }
});

test("Core reuses provider input capacity for curation without inventing another budget", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const packets = new PacketBuilder({
            db,
            schemes,
            executors: () => undefined,
        });
        const provider = new Mock({ contextWindow: 1_048_575, responses: [] });
        assert.equal(packets.curationBudgetFor(provider), provider.inputCapacity);
        assert.equal(provider.inputCapacity, 1_048_575 - 1280);
        assert.equal(provider.reasoningBudget, 256);
        assert.equal(provider.outputBudget, 1280, "reasoning does not add to the total response envelope");

        const unknown = new Mock({ contextWindow: null, responses: [] });
        assert.equal(packets.curationBudgetFor(unknown), null, "unknown physical capacity remains unknown to curation");
    } finally {
        await db.close();
    }
});

test("retired service-side capacity knobs fail at construction", async () => {
    const keys = ["PLURNK_SERVICE_PROMPT_BUDGET", "PLURNK_SERVICE_SAFETY_rig"] as const;
    const previous = keys.map((key) => process.env[key]);
    const db = await openMigrated();
    try {
        for (const key of keys) {
            process.env[key] = "1";
            assert.throws(() => new Engine({ db, schemes: new SchemeRegistry() }), new RegExp(`${key} is retired`));
            delete process.env[key];
        }
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
        await db.close();
    }
});

test("a malformed prompt projection percentage fails at construction", async () => {
    const previous = process.env.PLURNK_SERVICE_PROMPT_PROJECTION;
    const db = await openMigrated();
    try {
        for (const invalid of ["25", "0%", "100%", "wat%"] as const) {
            process.env.PLURNK_SERVICE_PROMPT_PROJECTION = invalid;
            assert.throws(
                () => new Engine({ db, schemes: new SchemeRegistry() }),
                /PLURNK_SERVICE_PROMPT_PROJECTION must be a percentage in \(0, 100\)/,
            );
        }
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_PROMPT_PROJECTION;
        else process.env.PLURNK_SERVICE_PROMPT_PROJECTION = previous;
        await db.close();
    }
});
