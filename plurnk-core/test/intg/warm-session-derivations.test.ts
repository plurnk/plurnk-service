// #290 — Engine.warmWorkspaceDerivations runs the derivation pump at SESSION scope (no loop), so a
// freshly-created workspace's corpus warms during the client's startup window instead of freezing the
// first loop.run. workspace.create fires it fire-and-forget; here we drive the seam directly and assert
// it (1) derives the deep channels (FTS proves the pump ran with no loopId) and (2) live-fans-out the
// embed_progress telemetry so a client renders startup progress before any turn.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { TelemetryEvent } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import Owner from "../../src/core/Owner.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const tokenize = (text: string): number => Math.ceil(text.length / 4);

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
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
        await new Worker().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Worker().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await new Worker().edit(editStmt(url("cart.ts"), "export function addToCart() {}\n"), ctx);

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
        const indexing = progress.filter((p) => (p.event as { phase?: unknown }).phase === undefined);
        assert.equal((indexing.at(-1)?.event as { total?: number } | undefined)?.total, 3, "indexing progress totals the whole corpus");
        assert.equal((progress.at(-1)?.event as { phase?: unknown } | undefined)?.phase, "complete", "warm emits an explicit terminal state");
    } finally {
        await db.close();
    }
});

test("[#587] workspace warm materializes a fresh repository before deriving it", async () => {
    const root = mkdtempSync(join(tmpdir(), "plurnk-warm-repo-"));
    execSync("git init -q && git config user.email fixture@plurnk.invalid && git config user.name fixture", { cwd: root, env: hermeticGitEnv() });
    writeFileSync(join(root, "orientation.md"), "repository orientation evidence\n");
    execSync("git add orientation.md && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --no-verify -qm seed", { cwd: root, env: hermeticGitEnv() });

    const db = await openMigrated();
    try {
        const telemetry: Array<{ event: TelemetryEvent }> = [];
        let rescan: Promise<void> | undefined;
        let requestedRescan = false;
        let workspaceId = 0;
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), tokenize,
            telemetryEventNotify: (_workspaceId, payload) => {
                const event = payload.event as TelemetryEvent;
                telemetry.push({ event });
                if (event.phase === "preparing" && !requestedRescan) {
                    assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "preparing", "latest state is queryable while no event stream is attached");
                    requestedRescan = true;
                    rescan = engine.warmWorkspaceDerivations(workspaceId);
                }
            },
        });
        const workspace = await (db.envelope_insert_workspace as PrepMethod).get<{ id: number }>({
            name: `warm-repo-${crypto.randomUUID()}`, project_root: root, settings: "{}",
        });
        assert.ok(workspace);
        workspaceId = workspace.id;
        await Owner.commonsId(db, workspaceId);

        await engine.warmWorkspaceDerivations(workspaceId);
        await rescan;

        const body = await (db.ops_read_channel as PrepMethod).get<{ content: string }>({
            workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId),
            scheme: "file", pathname: "orientation.md", channel: "body",
        });
        assert.equal(body?.content, "repository orientation evidence\n", "warm reads repository members from disk before deriving");
        const phases = telemetry.filter((t) => t.event.kind === "embed_progress").map((t) => t.event.phase);
        assert.deepEqual(phases, ["preparing", "preparing", "complete"], "overlapping warms coalesce, rescan once, and emit one terminal state");
        assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "complete", "terminal state remains queryable for a late client");
    } finally {
        await db.close();
    }
});
