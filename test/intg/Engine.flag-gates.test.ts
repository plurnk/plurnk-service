// Per-loop flag gating at dispatch time. Schemes self-declare affinity in
// their manifest (excludedInAsk / requiresWeb / requiresInteraction);
// SchemeRegistry.resolveForLoop returns the active set under the loop's
// persisted flags; Engine.#checkFlagsGate rejects dispatch to inactive
// schemes with 403 action-entry-as-outcome.

import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";
import { urlPath, editStmt, sendStmt } from "./_dsl.ts";

const makeMimetypes = (): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map() },
});

// Side-effecting scheme — opts into manifest.flags.excludedInAsk so it
// gets gated under mode=ask. Doesn't propose; succeeds 201 when allowed.
class SideEffectingScheme {
    static manifest: SchemeManifest = {
        name: "sideeffect-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plurnk"],
        volatile: false,
        modelVisible: true,
        flags: { excludedInAsk: true },
    };
    async edit(): Promise<{ status: number }> {
        return { status: 201 };
    }
}

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const schemes = new SchemeRegistry();
    schemes.register("sideeffect-test", new SideEffectingScheme());
    const engine = new Engine({ db, schemes, mimetypes: makeMimetypes() });
    return { db, sessionId, runId, loopId, turnId, engine };
};

const setLoopFlags = async (db: Awaited<ReturnType<typeof openMigrated>>, loopId: number, flags: object): Promise<void> => {
    await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify(flags) });
};

test("flag gate active: mode=ask rejects side-effecting scheme with 403", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { mode: "ask" });
        const stmt = editStmt(urlPath("sideeffect-test", "x"), "body");
        const r = await engine.dispatch({ statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "client" });
        assert.equal(r.status, 403);
    } finally { await db.close(); }
});

test("noProposals is not a dispatch gate — non-proposing schemes dispatch normally (known)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { noProposals: true });
        const stmt = editStmt(urlPath("known", "/x"), "body");
        const r = await engine.dispatch({ statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "client" });
        assert.equal(r.status, 201);
    } finally { await db.close(); }
});

test("flag gate active: broadcast SEND is never gated (no scheme to check)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { noProposals: true, mode: "ask" });
        const stmt = sendStmt(200, null);
        const r = await engine.dispatch({ statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "client" });
        assert.equal(r.status, 200);
    } finally { await db.close(); }
});
