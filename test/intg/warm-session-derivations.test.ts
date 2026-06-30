// #290 — Engine.warmSessionDerivations runs the derivation pump at SESSION scope (no loop), so a
// freshly-created session's corpus warms during the client's startup window instead of freezing the
// first loop.run. session.create fires it fire-and-forget; here we drive the seam directly and assert
// it (1) derives the deep channels (FTS proves the pump ran with no loopId) and (2) live-fans-out the
// embed_progress telemetry so a client renders startup progress before any turn.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { TelemetryEvent } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const tokenize = (text: string): number => Math.ceil(text.length / 4);

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 },
});
const fts = async (db: Db, sessionId: number, query: string): Promise<string[]> => {
    const rows = await (db.test_fts_search as PrepMethod).all<{ pathname: string }>({ session_id: sessionId, query });
    return rows.map((r) => r.pathname);
};

test("[#290] Engine.warmSessionDerivations derives deep channels at session scope (no loop) and fans out embed_progress", async () => {
    const db = await openMigrated();
    try {
        const telemetry: Array<{ sessionId: number; loopId: number; event: TelemetryEvent }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), tokenize,
            telemetryEventNotify: (sessionId, { loopId, event }) => telemetry.push({ sessionId, loopId, event: event as TelemetryEvent }),
        });
        const sessionId = await insertSession(db, `warm-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });

        // A multi-entry corpus — exactly the "initial ingest" case that otherwise looks frozen on turn 1.
        await new Known().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Known().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await new Known().edit(editStmt(url("cart.ts"), "export function addToCart() {}\n"), ctx);

        // Nothing derived yet (no turn has run): FTS is empty.
        assert.deepEqual(await fts(db, sessionId, "processPayment"), [], "no derivation before warm");

        // Warm at session scope — the seam session.create fires. No loop/turn exists.
        await engine.warmSessionDerivations(sessionId);

        // The pump ran: every entry's body is FTS-indexed, addressable with no loop ever opened.
        assert.deepEqual(await fts(db, sessionId, "processPayment"), ["/pay.ts"], "warm indexed pay.ts");
        assert.deepEqual(await fts(db, sessionId, "authenticate"), ["/auth.ts"], "warm indexed auth.ts");
        assert.deepEqual(await fts(db, sessionId, "addToCart"), ["/cart.ts"], "warm indexed cart.ts");

        // Startup progress streamed to the client — embed_progress, session-scoped (loopId 0, never a real loop).
        const progress = telemetry.filter((t) => t.event.kind === "embed_progress");
        assert.ok(progress.length > 0, "warm fans out embed_progress for the multi-entry ingest");
        assert.ok(progress.every((p) => p.loopId === 0), "session-scope progress carries loopId 0 (no turn yet)");
        assert.equal((progress.at(-1)?.event as { total?: number } | undefined)?.total, 3, "progress totals the whole corpus");
    } finally {
        await db.close();
    }
});
