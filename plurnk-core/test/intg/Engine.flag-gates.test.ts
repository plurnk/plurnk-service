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
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import { urlPath, localPath, editStmt, readStmt, copyStmt, moveStmt, sendStmt } from "./_dsl.ts";

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
        scope: "workspace",
        writableBy: ["model", "client", "plurnk"],
        volatile: false,
        modelVisible: true,
        flags: { excludedInAsk: true },
    };
    async editBatch(): Promise<{ status: number }> {
        return { status: 201 };
    }
}

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const schemes = new SchemeRegistry();
    schemes.register("sideeffect-test", new SideEffectingScheme());
    const engine = new Engine({ db, schemes, mimetypes: makeMimetypes() });
    return { db, workspaceId, workerId, loopId, turnId, engine };
};

const setLoopFlags = async (db: Awaited<ReturnType<typeof openMigrated>>, loopId: number, flags: object): Promise<void> => {
    await db.engine_set_loop_flags.run({ loop_id: loopId, flags: JSON.stringify(flags) });
};

test("ask mode refuses EVERY filesystem write — EDIT/COPY-dest/MOVE/KILL on the workspace (the ancient read-only contract, uncovered until now)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { mode: "ask" });
        let seq = 0;
        const disp = (statement: Parameters<typeof engine.dispatch>[0]["statement"]) =>
            engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: ++seq, origin: "client" });
        // A bare path is the `file` scheme (the on-disk workspace). EDIT writes it → refused.
        const edit = await disp(editStmt(localPath("brief.md"), "hello"));
        assert.equal(edit.status, 403, "EDIT to the filesystem is refused in ask mode");
        assert.match(String(edit.error), /read-only|side-effecting/, "the refusal names the read-only contract");
        // COPY into the workspace — the DEST is the write → refused.
        const copy = await disp(copyStmt(urlPath("worker", "note"), localPath("copied.md")));
        assert.equal(copy.status, 403, "COPY writing the filesystem is refused");
        // MOVE a workspace file out — the SOURCE delete side-effects → refused.
        const move = await disp(moveStmt(localPath("brief.md"), urlPath("worker", "moved")));
        assert.equal(move.status, 403, "MOVE deleting a workspace file is refused");
        // But a READ of the same workspace file is ALLOWED — ask is read-ONLY, not no-access.
        const read = await disp(readStmt(localPath("brief.md")));
        assert.notEqual(read.status, 403, "reads of the workspace stay open in ask mode");
    } finally { await db.close(); }
});

test("flag gate active: mode=ask rejects side-effecting scheme with 403", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { mode: "ask" });
        const stmt = editStmt(urlPath("sideeffect-test", "x"), "body");
        const r = await engine.dispatch({ statement: stmt, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client" });
        assert.equal(r.status, 403);
        // #367 — the steer NAMES ask mode and says DO NOT RETRY, so the model changes course
        // instead of re-emitting into the StrikeRail's 508.
        assert.match(String(r.error), /ask-mode/, "the 403 names the ask-mode restriction");
        assert.match(String(r.error), /Do NOT retry|answer or advise/, "the steer directs a course change, not a repeat");
    } finally { await db.close(); }
});

test("noProposals is not a dispatch gate — non-proposing schemes dispatch normally (known)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { noProposals: true });
        const stmt = editStmt(urlPath("worker", "/x"), "body");
        const r = await engine.dispatch({ statement: stmt, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client" });
        assert.equal(r.status, 201);
    } finally { await db.close(); }
});

test("flag gate active: broadcast SEND is never gated (no scheme to check)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopFlags(db, loopId, { noProposals: true, mode: "ask" });
        const stmt = sendStmt(200, null);
        const r = await engine.dispatch({ statement: stmt, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client" });
        assert.equal(r.status, 200);
    } finally { await db.close(); }
});
