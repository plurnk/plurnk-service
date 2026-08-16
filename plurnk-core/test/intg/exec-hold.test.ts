// {§exec-hold-until-concluded} — runtimes in
// PLURNK_SERVICE_EXEC_HOLD pause the cycle until their stream concludes, so the model never
// burns a turn waiting on a result the engine controls end-to-end. Bounded + fail-open.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// This file isolates the hold decision after ordinary optimistic settlement:
// disabling the latter keeps the selected-vs-unselected runtime distinction as
// the only variable under test.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

let wireN = 0;
const wire = async (finishAfterMs: number, effect: "read" | "host" | "pure" = "pure") => {
    // unique tag per wiring: testExecutors() is a shared cached registry — a duplicate
    // runtime registration throws and leaks the just-opened db, wedging the test file.
    const tag = `holdstub${++wireN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag, glyph: "?",
            get manifest() { return { name: tag, channels: { results: "application/json" }, defaultChannel: "results", category: "data", writableBy: ["plugin"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "application/json" } }; },
            effect: () => effect,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args) => {
                await new Promise((r) => setTimeout(r, finishAfterMs));
                args.write("results", JSON.stringify([{ title: "HOLD-DONE" }]), "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "?", summary: "Hold fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } }, details: "", available: true, detail: undefined,
    });
    const workspaceId = await insertWorkspace(db, `hold-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "hold test");
    return { db, engine, schemes, workspaceId, workerId, loopId, tag };
};

const streamsSection = (packetJson: string): string => {
    const p = JSON.parse(packetJson) as { sections?: Array<{ name: string; content: string }> };
    return p.sections?.find((s) => s.name === "child-streams")?.content ?? "";
};

const driveLoop = async (finishAfterMs: number, midTurns: number, effect: "read" | "host" | "pure" = "pure", holdSuffix?: string) => {
    const { db, engine, schemes, workspaceId, workerId, loopId, tag } = await wire(finishAfterMs, effect);
    // The effect-qualified selector uses the runtime's actual registered tag.
    if (holdSuffix !== undefined) process.env.PLURNK_SERVICE_EXEC_HOLD = `${tag}${holdSuffix}`;
    try {
        const responses = [
            { assistant: { content: "", reasoning: null, ops: [execStmt(tag, "go"), sendStmt(102, null, "searching")] } },
            ...Array.from({ length: midTurns }, () => ({ assistant: { content: "", reasoning: null, ops: [sendStmt(202, null, "waiting on the monitored stream")] } })),
            { assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } },
        ];
        const provider = new Mock({ contextWindow: 100000, responses: responses as never });
        const t0 = Date.now();
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }], maxTurns: 5 });
        const elapsed = Date.now() - t0;
        const turn2 = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds[1] });
        return { result, elapsed, streams: streamsSection(turn2?.packet ?? "{}"), tag };
    } finally {
        await (schemes.get("exec") as Exec).idle();
        await db.close();
    }
};

test("a HOLD runtime pauses the cycle — turn 2 assembles AFTER the stream concludes", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "holdstub1";
    try {
        const { result, elapsed, streams } = await driveLoop(800, 0);
        assert.equal(result.result.status, 200);
        assert.ok(elapsed >= 800, `the cycle paused for the stream (elapsed ${elapsed}ms >= 800ms)`);
        assert.ok(!/holdstub1/.test(streams), "turn 2's packet lists NO live holdstub stream — it woke to a finished world");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("a runtime OUTSIDE the hold set keeps the standard cycle — turn 2 sees the live stream", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "some-other-runtime";
    try {
        // The standard cycle: T2 assembles immediately with the live stream
        // and parks on it (this direct Engine fixture has no daemon wake owner).
        const { result, streams } = await driveLoop(1200, 1);
        assert.equal(result.result.status, 202, "the unheld stream enters the ordinary monitored lifecycle");
        assert.ok(/holdstub2/.test(streams), "turn 2's packet LISTS the live stream — no hold applied outside the set");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("{§exec-hold-until-concluded}: a `:read` suffix holds a read-effect spawn", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_HOLD;
    try {
        const { elapsed, streams } = await driveLoop(400, 0, "read", ":read");
        assert.ok(!/holdstub/.test(streams), "turn 2 woke to a finished world — the read-effect spawn was held by its :read suffix");
        assert.ok(elapsed >= 350, "the cycle actually paused for the stream (held, not raced)");
    } finally { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prior; }
});

test("{§exec-hold-until-concluded}: a `:host` suffix does not hold a read-effect spawn", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_HOLD;
    try {
        const { result, streams } = await driveLoop(2000, 1, "read", ":host");
        assert.equal(result.result.status, 202, "the mismatched selector leaves the stream monitored");
        assert.ok(/holdstub/.test(streams), "turn 2 saw the LIVE stream — a read spawn is not held by a :host suffix");
    } finally { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prior; }
});
