import assert from "node:assert/strict";
import test from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { DEFAULT_MIMETYPES, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

class FixtureEngine extends Engine {
    documents: Array<{ pathname: string; content: string }> = [];

    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return this.documents;
    }
}

test("{§schemes-self-doc-materialization} worker documentation materialization removes stale generated entries", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            owner_id: workerId,
            scheme: "worker",
            authority: "",
            pathname,
        });

        engine.documents = [
            { pathname: "/_plurnk/skills/plurnk/retired.md", content: "# Retired" },
            { pathname: "/_plurnk/skills/plurnk/tool-retired.md", content: "# Retired tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.notEqual(await entry("/_plurnk/skills/plurnk/retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/skills/plurnk/tool-retired.md"), undefined);

        engine.documents = [
            { pathname: "/_plurnk/skills/plurnk/current.md", content: "# Current" },
            { pathname: "/_plurnk/skills/plurnk/tool-current.md", content: "# Current tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.equal(await entry("/_plurnk/skills/plurnk/retired.md"), undefined);
        assert.equal(await entry("/_plurnk/skills/plurnk/tool-retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/skills/plurnk/current.md"), undefined);
        assert.notEqual(await entry("/_plurnk/skills/plurnk/tool-current.md"), undefined);
    } finally {
        await db.close();
    }
});

test("{§schemes-self-doc-materialization} an unchanged generated surface dispatches nothing on re-materialization", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-idem-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        engine.documents = [
            { pathname: "/_plurnk/skills/plurnk/stable.md", content: "# Stable" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const before = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: workerId });

        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const after = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: workerId });
        assert.equal(after?.id, before?.id, "the unchanged surface re-dispatches nothing — no new _plurnk turn, no 304 churn");
    } finally {
        await db.close();
    }
});
