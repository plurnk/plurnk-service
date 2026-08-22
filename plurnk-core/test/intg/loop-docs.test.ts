import assert from "node:assert/strict";
import test from "node:test";
import Engine from "../../src/core/Engine.ts";
import Owner from "../../src/core/Owner.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { DEFAULT_MIMETYPES, insertWorkspace, openMigrated } from "./_helpers.ts";

class FixtureEngine extends Engine {
    documents: Array<{ pathname: string; content: string }> = [];

    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return this.documents;
    }
}

test("{§schemes-self-doc-materialization} kernel documentation materialization removes stale generated entries", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-${crypto.randomUUID()}`);
        const ownerId = await Owner.kernelId(db, workspaceId);
        const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            owner_id: ownerId,
            scheme: "worker",
            authority: "",
            pathname,
        });

        engine.documents = [
            { pathname: "/skills/plurnk/retired.md", content: "# Retired" },
            { pathname: "/skills/plurnk/tool-retired.md", content: "# Retired tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.notEqual(await entry("/skills/plurnk/retired.md"), undefined);
        assert.notEqual(await entry("/skills/plurnk/tool-retired.md"), undefined);

        engine.documents = [
            { pathname: "/skills/plurnk/current.md", content: "# Current" },
            { pathname: "/skills/plurnk/tool-current.md", content: "# Current tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await entry("/skills/plurnk/retired.md"), undefined);
        assert.equal(await entry("/skills/plurnk/tool-retired.md"), undefined);
        assert.notEqual(await entry("/skills/plurnk/current.md"), undefined);
        assert.notEqual(await entry("/skills/plurnk/tool-current.md"), undefined);
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
        engine.documents = [
            { pathname: "/skills/plurnk/stable.md", content: "# Stable" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        const plurnkWorker = await db.envelope_get_worker_by_name.get<{ id: number }>({
            workspace_id: workspaceId,
            name: "plurnk",
        });
        const before = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: plurnkWorker!.id });

        await LoopDocs.materialize(engine, db, workspaceId);
        const after = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: plurnkWorker!.id });
        assert.equal(after?.id, before?.id, "the unchanged surface re-dispatches nothing — no new plurnk loop, no 304 churn");
    } finally {
        await db.close();
    }
});
