// {§derivation-exhaustive}, {§methods-workspace-create} — Engine.warmWorkspaceDerivations runs
// the derivation pump at workspace scope (no loop), so a
// freshly-created workspace's corpus warms during the client's startup window instead of freezing the
// first loop.run. workspace.create fires it fire-and-forget; here we drive the seam directly and assert
// it (1) derives the deep channels (FTS proves the pump ran with no loopId) and (2) live-fans-out the
// embed_progress notices so a client renders startup progress before any turn.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { Mock } from "@plurnk/plurnk-providers";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../../src/core/Db.ts";
import type { Notice } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import Owner from "../../src/core/Owner.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, makeSchemeCtx } from "./_helpers.ts";

const weigh = (text: string): number => Math.ceil(text.length / 4);

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    op: "EDIT", annotation: null, delimiter: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 },
});
const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

test("{§derivation-exhaustive}: workspace warming derives deep channels without a loop and fans out progress", async () => {
    const db = await openMigrated();
    try {
        const notices: Array<{ workspaceId: number; loopId: number; notice: Notice }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), weigh,
            noticeNotify: (workspaceId, { loopId, notice }) => notices.push({ workspaceId, loopId, notice: notice as Notice }),
        });
        const workspaceId = await insertWorkspace(db, `warm-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        // A multi-entry corpus — exactly the "initial ingest" case that otherwise looks frozen on turn 1.
        await new Worker().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Worker().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await new Worker().edit(editStmt(url("cart.ts"), "export function addToCart() {}\n"), ctx);

        // Warm at workspace scope — the seam workspace.create fires. No loop/turn exists.
        await engine.warmWorkspaceDerivations(workspaceId);

        // The pump ran: every entry's body is FTS-indexed, addressable with no loop ever opened.
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"], "warm indexed pay.ts");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "warm indexed auth.ts");
        assert.deepEqual(await fts(db, workspaceId, "addToCart"), ["/cart.ts"], "warm indexed cart.ts");

        // Startup progress streamed to the client — embed_progress, workspace-scoped (loopId 0, never a real loop).
        const progress = notices.filter((t) => t.notice.kind === "embed_progress");
        assert.ok(progress.length > 0, "warm fans out embed_progress for the multi-entry ingest");
        assert.ok(progress.every((p) => p.loopId === 0), "workspace-scope progress carries loopId 0 (no turn yet)");
        const indexing = progress.filter((p) => (p.notice as { phase?: unknown }).phase === undefined);
        assert.equal((indexing.at(-1)?.notice as { total?: number } | undefined)?.total, 3, "indexing progress totals the whole corpus");
        assert.equal((progress.at(-1)?.notice as { phase?: unknown } | undefined)?.phase, "complete", "warm emits an explicit terminal state");
    } finally {
        await db.close();
    }
});

test("{§derivation-exhaustive}: workspace warm materializes a fresh repository before deriving it", async () => {
    const root = mkdtempSync(join(tmpdir(), "plurnk-warm-repo-"));
    execSync("git init -q && git config user.email fixture@plurnk.invalid && git config user.name fixture", { cwd: root, env: hermeticGitEnv() });
    writeFileSync(join(root, "orientation.md"), "repository orientation evidence\n");
    execSync("git add orientation.md && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --no-verify -qm seed", { cwd: root, env: hermeticGitEnv() });

    const db = await openMigrated();
    try {
        const notices: Array<{ notice: Notice }> = [];
        let rescan: Promise<void> | undefined;
        let requestedRescan = false;
        let workspaceId = 0;
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), weigh,
            noticeNotify: (_workspaceId, payload) => {
                const notice = payload.notice as Notice;
                notices.push({ notice });
                if (notice.phase === "preparing" && !requestedRescan) {
                    assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "preparing", "latest state is queryable while no notice stream is attached");
                    requestedRescan = true;
                    rescan = engine.warmWorkspaceDerivations(workspaceId);
                }
            },
        });
        const workspace = await db.envelope_insert_workspace.get<{ id: number }>({
            name: `warm-repo-${crypto.randomUUID()}`, project_root: root, settings: "{}",
        });
        assert.ok(workspace);
        workspaceId = workspace.id;
        await Owner.commonsId(db, workspaceId);

        await engine.warmWorkspaceDerivations(workspaceId);
        await rescan;

        const body = await db.ops_read_channel.get<{ content: string }>({
            workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId),
            scheme: "file", pathname: "orientation.md", channel: "body",
        });
        assert.equal(body?.content, "repository orientation evidence\n", "warm reads repository members from disk before deriving");
        const phases = notices.filter((t) => t.notice.kind === "embed_progress").map((t) => t.notice.phase);
        assert.deepEqual(phases, ["preparing", "preparing", "complete"], "overlapping warms coalesce, rescan once, and emit one terminal state");
        assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "complete", "terminal state remains queryable for a late client");
    } finally {
        await db.close();
    }
});

test("a model turn joins an in-flight startup warm before calling its provider", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `warm-join-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "wait for semantics");
        const mimetypes = new Mimetypes();
        await mimetypes.ready();
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        await new Worker().edit(editStmt(url("orientation.md"), "semantic orientation evidence\n"), ctx);

        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const processing = new Promise<void>((resolve) => { entered = resolve; });
        const originalProcess = mimetypes.process.bind(mimetypes);
        let first = true;
        mimetypes.process = async (...args): Promise<Awaited<ReturnType<typeof originalProcess>>> => {
            if (first) {
                first = false;
                entered();
                await blocked;
            }
            return originalProcess(...args);
        };

        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh, mimetypes });
        const response: MockResponse = {
            assistant: {
                content: "",
                ops: [{ op: "SEND", annotation: null, delimiter: "", signal: 200, target: null, lineMarker: null, body: { raw: "ready", json: null }, position: { line: 1, column: 1 } }],
                reasoning: null,
            },
        };
        const provider = new Mock({ contextWindow: 4096, responses: [response] });

        const warm = engine.warmWorkspaceDerivations(workspaceId);
        await processing;
        const turn = engine.runTurn({
            provider, workspaceId, workerId, loopId, turnNumber: 1,
            messages: [{ role: "system", content: "test" }, { role: "user", content: "go" }],
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(provider.remaining, 1, "provider is untouched while semantic coverage is incomplete");

        release();
        await warm;
        await turn;
        assert.equal(provider.remaining, 0, "provider runs after the joined warm completes");
    } finally {
        await db.close();
    }
});
