import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TelemetryChannel from "../../src/core/TelemetryChannel.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";

// These pin the TABULAR budget baseline; #440's default is the mermaid form (covered by [§budget-mermaid]).
process.env.PLURNK_SERVICE_BUDGET_MERMAID = "off";

test("the prompt ceiling derives from the provider window minus reserves — reserves over the window fail hard", async () => {
    // #507 — the envelope is PROVIDER-owned: the window is the provider's own (Mock ctor), the
    // reserves ride the bare PLURNK_PROVIDERS_*_RESERVE knobs Mock reads, SAFETY stays core's.
    // 1000+2000 reserves + 500 safety: a 10000 window → promptBudget 6500; a 5000 window → 1500;
    // a 3000 window → reserves exceed it → the build fails hard (pinned absolutes vs the window).
    const KEYS = ["PLURNK_PROVIDERS_REASONING_RESERVE", "PLURNK_PROVIDERS_COMPLETION_RESERVE", "PLURNK_SERVICE_SAFETY"] as const;
    const prev = KEYS.map((k) => process.env[k]);
    process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "1000";
    process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = "2000";
    process.env.PLURNK_SERVICE_SAFETY = "500";
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
        assert.match(await run(10000), /Token Ceiling 6500 /, "the provider window governs: 10000 − 3500 reserves");
        assert.match(await run(5000), /Token Ceiling 1500 /, "a narrower window: 5000 − 3500");
        await assert.rejects(() => run(3000), /partition contradiction/, "reserves exceeding the window fail hard");
    } finally {
        KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
        await db.close();
    }
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});

test("Engine.runTurn: budget readout — partition-derived ceiling, free reconciles to ceiling − assembled total", async () => {
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
        const packet = JSON.parse(row.packet) as { tokens: number; sections: Array<{ tokens: number }> };
        const budget = packetSection(packet, "budget");
        // partition: provider window 4000 − test reserves (256+1024+64) = 2656
        assert.match(budget, /Token Ceiling 2656 · Token Usage \d+ \(\d+%\) · Tokens Free \d+/, "headline carries the partition-derived ceiling, usage, percent, and free");
        const free = Number(/Tokens Free (\d+)/.exec(budget)?.[1]);
        const total = packet.sections.reduce((n, s) => n + s.tokens, 0); // summed per-section render-weights (the assembled request size, inter-section joins aside)
        assert.ok(free > 0 && free < 2656, `free ${free} within (0, 2656)`);
        // Reconciles to ceiling − assembled total, within the placeholder/number
        // substitution delta (tokensFree's own digits change the packet's size).
        assert.ok(Math.abs(free - (2656 - total)) <= 25, `free ${free} ~= 2656 - ${total}`);
    } finally { await db.close(); }
});

test("a virtual prompt budget tightens the gauge and grinder without changing provider physics or generation", async () => {
    const db = await openMigrated();
    const prev = {
        cap: process.env.PLURNK_SERVICE_PROMPT_BUDGET,
        rr: process.env.PLURNK_PROVIDERS_REASONING_RESERVE,
        cr: process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE,
        safety: process.env.PLURNK_SERVICE_SAFETY,
    };
    try {
        process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "4915";
        process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = "12288";
        process.env.PLURNK_SERVICE_SAFETY = "1024";
        process.env.PLURNK_SERVICE_PROMPT_BUDGET = "128000";
        const schemes = new SchemeRegistry();
        const packets = new PacketBuilder({ db, schemes, telemetry: new TelemetryChannel({ db }), executors: () => undefined });
        const provider = new Mock({ contextWindow: 1_048_575, responses: [] });
        const budget = packets.promptBudgetFor(provider);
        assert.equal(budget, 128_000);
        assert.equal(provider.contextWindow, 1_048_575, "virtual pressure does not rewrite physical context");
        assert.equal(provider.reasoningReserve, 4915, "virtual pressure does not rewrite reasoning settings");
        assert.equal(provider.completionReserve, 12288, "virtual pressure does not rewrite completion settings");
        assert.equal(packets.maxTokensFor(provider), 4915 + 12288, "virtual pressure does not rewrite maxTokens");

        process.env.PLURNK_SERVICE_PROMPT_BUDGET = "2000000";
        assert.equal(
            packets.promptBudgetFor(provider),
            1_048_575 - 4915 - 12288 - 1024,
            "a virtual cap cannot widen the natural physical prompt budget",
        );

        const unknown = new Mock({ contextWindow: null, responses: [] });
        process.env.PLURNK_SERVICE_PROMPT_BUDGET = "64000";
        assert.equal(packets.promptBudgetFor(unknown), 64_000, "virtual pressure remains usable when provider physics are unknown");
    } finally {
        for (const [k, v] of [["PLURNK_SERVICE_PROMPT_BUDGET", prev.cap], ["PLURNK_PROVIDERS_REASONING_RESERVE", prev.rr], ["PLURNK_PROVIDERS_COMPLETION_RESERVE", prev.cr]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        if (prev.safety === undefined) delete process.env.PLURNK_SERVICE_SAFETY; else process.env.PLURNK_SERVICE_SAFETY = prev.safety;
        await db.close();
    }
});

test("a malformed virtual prompt budget fails at construction", async () => {
    const previous = process.env.PLURNK_SERVICE_PROMPT_BUDGET;
    const db = await openMigrated();
    try {
        process.env.PLURNK_SERVICE_PROMPT_BUDGET = "12.5";
        assert.throws(
            () => new Engine({ db, schemes: new SchemeRegistry() }),
            /PLURNK_SERVICE_PROMPT_BUDGET must be a positive integer/,
        );
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_PROMPT_BUDGET;
        else process.env.PLURNK_SERVICE_PROMPT_BUDGET = previous;
        await db.close();
    }
});
