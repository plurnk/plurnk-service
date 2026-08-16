import assert from "node:assert/strict";
import test from "node:test";
import Engine from "../../src/core/Engine.ts";
import Owner from "../../src/core/Owner.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { DEFAULT_MIMETYPES, insertWorkspace, openMigrated } from "./_helpers.ts";

class FixtureEngine extends Engine {
    documents: Array<{ name: string; content: string }> = [];

    override async docEntries(): Promise<Array<{ name: string; content: string }>> {
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
            pathname,
        });

        engine.documents = [{ name: "retired", content: "# Retired" }];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.notEqual(await entry("/docs/retired.md"), undefined);

        engine.documents = [{ name: "current", content: "# Current" }];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await entry("/docs/retired.md"), undefined);
        assert.notEqual(await entry("/docs/current.md"), undefined);
    } finally {
        await db.close();
    }
});
