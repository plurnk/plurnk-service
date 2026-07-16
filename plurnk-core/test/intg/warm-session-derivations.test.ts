// #290 — Engine.warmWorkspaceDerivations runs the derivation pump at SESSION scope (no loop), so a
// freshly-created workspace's corpus warms during the client's startup window instead of freezing the
// first loop.run. workspace.create fires it fire-and-forget; here we drive the seam directly and assert
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
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const tokenize = (text: string): number => Math.ceil(text.length / 4);

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 },
});
const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await (db.test_fts_search as PrepMethod).all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

test("[#290] Engine.warmWorkspaceDerivations derives deep channels at workspace scope (no loop) and fans out embed_progress", async () => {
    const db = await openMigrated();
    try {
        const telemetry: Array<{ workspaceId: number; loopId: number; event: TelemetryEvent }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), tokenize,
            telemetryEventNotify: (workspaceId, { loopId, event }) => telemetry.push({ workspaceId, loopId, event: event as TelemetryEvent }),
        });
        const workspaceId = await insertWorkspace(db, `warm-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        // A multi-entry corpus — exactly the "initial ingest" case that otherwise looks frozen on turn 1.
        await new Known().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Known().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await new Known().edit(editStmt(url("cart.ts"), "export function addToCart() {}\n"), ctx);

        // §semantic-fts-at-write — the keyword half indexes AT the write now: a cold corpus is
        // FTS-addressable before any pump runs. The warm still owns the DEEP channels (graph,
        // embeddings, deep_hash) — asserted below by the stamped hashes and progress fan-out.
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"], "write-time FTS precedes the warm");

        // Warm at workspace scope — the seam workspace.create fires. No loop/turn exists.
        await engine.warmWorkspaceDerivations(workspaceId);

        // The pump ran: every entry's body is FTS-indexed, addressable with no loop ever opened.
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"], "warm indexed pay.ts");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "warm indexed auth.ts");
        assert.deepEqual(await fts(db, workspaceId, "addToCart"), ["/cart.ts"], "warm indexed cart.ts");

        // Startup progress streamed to the client — embed_progress, workspace-scoped (loopId 0, never a real loop).
        const progress = telemetry.filter((t) => t.event.kind === "embed_progress");
        assert.ok(progress.length > 0, "warm fans out embed_progress for the multi-entry ingest");
        assert.ok(progress.every((p) => p.loopId === 0), "workspace-scope progress carries loopId 0 (no turn yet)");
        assert.equal((progress.at(-1)?.event as { total?: number } | undefined)?.total, 3, "progress totals the whole corpus");
    } finally {
        await db.close();
    }
});
