// Per-loop flag gating at dispatch time. Schemes self-declare affinity in
// their manifest (excludedInAsk / requiresWeb / requiresInteraction);
// SchemeRegistry.resolveForLoop returns the active set under the loop's
// persisted flags; Dispatcher rejects each inactive operation/resource
// authority with a 403 action-entry-as-outcome.

import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { Effect } from "@plurnk/plurnk-execs";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, schemeManifest } from "./_helpers.ts";
import { urlPath, localPath, editStmt, readStmt, copyStmt, moveStmt, sendStmt, execStmt } from "./_dsl.ts";

const makeMimetypes = (): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] },
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

class AffinitySource {
    readonly manifest: SchemeManifest;
    reads = 0;

    constructor(name: string, flags: NonNullable<SchemeManifest["flags"]>) {
        this.manifest = { ...schemeManifest(name), flags };
    }

    async read(): Promise<{ status: number; content: string; mimetype: string; channel: string }> {
        this.reads += 1;
        return { status: 200, content: "source", mimetype: "text/plain", channel: "body" };
    }
}

const flagExecutor: Executor = {
    runtime: "flag-tool",
    glyph: "🧪",
    get manifest(): SchemeManifest {
        return {
            ...schemeManifest("flag-tool", { results: "text/plain" }, "results"),
            scope: "worker",
            volatile: true,
        };
    },
    get defaultChannel(): string { return "results"; },
    get channels() { return { results: { mimetype: "text/plain" } }; },
    async run({ setState }) {
        setState("results", "closed");
        return { status: 200 };
    },
    async probe() { return { available: true }; },
    effect(target: string | null): Effect { return target === null ? "pure" : "read"; },
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const schemes = new SchemeRegistry();
    schemes.register("sideeffect-test", new SideEffectingScheme());
    const engine = new Engine({ db, schemes, mimetypes: makeMimetypes() });
    engine.setExecutors(new ExecutorRegistry(new Map([
        ["flag-tool", { executor: flagExecutor, glyph: "🧪", example: "", documentation: "", available: true, detail: undefined }],
    ])));
    return { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec: schemes.get("exec") as Exec };
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
        assert.equal(edit.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/ask-mode-read-only");
        assert.equal(edit.problem?.mode, "ask");
        assert.equal(edit.problem?.operation, "EDIT");
        assert.match(edit.problem?.recovery ?? "", /Answer or advise/);
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
        assert.equal(r.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-unavailable");
        assert.match(r.problem?.detail ?? "", /ask-mode/, "the 403 names the ask-mode restriction");
        assert.equal(r.problem?.recovery, "Answer or advise the user without using the unavailable scheme.");
        assert.equal(r.problem?.retryable, false);
    } finally { await db.close(); }
});

test("noProposals is not a dispatch gate — non-proposing schemes dispatch normally (worker)", async () => {
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

// {§op-methods-op-dispatch} Loop affinity narrows registered schemes; it does
// not turn an unknown name into a registered-but-unavailable authority.
test("unregistered direct targets remain scheme-not-found under every loop flag (#166)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const flagSets = [
            { mode: "act" },
            { mode: "act", noWeb: true },
            { mode: "act", noInteraction: true },
            { mode: "act", noWeb: true, noInteraction: true },
            { mode: "ask" },
            { mode: "ask", noWeb: true },
            { mode: "ask", noInteraction: true },
            { mode: "ask", noWeb: true, noInteraction: true },
        ];
        for (const [index, flags] of flagSets.entries()) {
            await setLoopFlags(db, loopId, flags);
            const result = await engine.dispatch({
                statement: readStmt(urlPath("unknown-source", "/item")),
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "client",
            });
            assert.equal(result.status, 501);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-not-found");
            assert.equal(result.problem?.scheme, "unknown-source");
        }
    } finally { await db.close(); }
});

test("unregistered EXEC sources remain scheme-not-found when the exec authority is active (#166)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, exec } = await setup();
    try {
        const flagSets = [
            { mode: "act", noWeb: true },
            { mode: "act", noInteraction: true },
            { mode: "act", noWeb: true, noInteraction: true },
        ];
        for (const [index, flags] of flagSets.entries()) {
            await setLoopFlags(db, loopId, flags);
            const result = await engine.dispatch({
                statement: execStmt("flag-tool", "transform", urlPath("unknown-source", "/item")),
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "client",
            });
            assert.equal(result.status, 501);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-not-found");
            assert.equal(result.problem?.scheme, "unknown-source");
        }
        await exec.idle();
    } finally { await exec.idle(); await db.close(); }
});

// {§exec-target-routing} EXEC consumes operation and optional source authority independently.
test("ask mode gates the exec operation before every target form (#164)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new AffinitySource("web-source", { requiresWeb: true });
    schemes.register("web-source", web);
    try {
        await setLoopFlags(db, loopId, { mode: "ask", noWeb: true });
        const targets = [
            null,
            localPath("input.txt"),
            urlPath("file", "/input.txt"),
            urlPath("worker", "/source"),
            urlPath("web-source", "/source"),
        ];
        for (const [index, target] of targets.entries()) {
            const result = await engine.dispatch({
                statement: execStmt("flag-tool", "transform", target),
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "client",
            });
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-unavailable");
            assert.equal(result.problem?.scheme, "exec", "the unavailable operation owner wins before its source");
        }
        assert.equal(web.reads, 0);
        await exec.idle();
    } finally { await exec.idle(); await db.close(); }
});

test("EXEC additionally gates non-file sources by their own affinity (#164)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new AffinitySource("web-source", { requiresWeb: true });
    const interaction = new AffinitySource("interaction-source", { requiresInteraction: true });
    schemes.register("web-source", web);
    schemes.register("interaction-source", interaction);
    try {
        await setLoopFlags(db, loopId, { mode: "act", noWeb: true });
        const webResult = await engine.dispatch({
            statement: execStmt("flag-tool", "transform", urlPath("web-source", "/source")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(webResult.status, 403);
        assert.equal(webResult.problem?.scheme, "web-source");

        await setLoopFlags(db, loopId, { mode: "act", noInteraction: true });
        const interactionResult = await engine.dispatch({
            statement: execStmt("flag-tool", "transform", urlPath("interaction-source", "/source")),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "client",
        });
        assert.equal(interactionResult.status, 403);
        assert.equal(interactionResult.problem?.scheme, "interaction-source");
        assert.equal(web.reads, 0);
        assert.equal(interaction.reads, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("noWeb and noInteraction do not reinterpret local/file EXEC targets as scheme operations (#164)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, exec } = await setup();
    try {
        await setLoopFlags(db, loopId, { mode: "act", noWeb: true, noInteraction: true });
        const targets = [null, localPath("input.txt"), urlPath("file", "/input.txt")];
        for (const [index, target] of targets.entries()) {
            const result = await engine.dispatch({
                statement: execStmt("flag-tool", "transform", target),
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "client",
            });
            assert.equal(result.status, 200, "the active exec owner may use an executor-local target");
        }
        await exec.idle();
    } finally { await exec.idle(); await db.close(); }
});
