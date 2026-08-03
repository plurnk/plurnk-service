import test from "node:test";
import assert from "node:assert/strict";
import { seedDemoFixture } from "../demo/_fixture.ts";
import { insertWorkspace, openMigrated } from "./_helpers.ts";

test("the demo fixture registers every project member under the non-null file identity", async () => {
    const fixture = await seedDemoFixture(`identity-${crypto.randomUUID()}`);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `demo-fixture-${crypto.randomUUID()}`);
        await fixture.addToCatalog(db, workspaceId);
        const rows = await db.test_list_entry_schemes.all<{ scheme: string }>();
        assert.ok(rows.length > 0, "the fixture registers its project members");
        assert.ok(rows.every(({ scheme }) => scheme === "file"), "every project member persists as scheme='file'");
    } finally {
        await db.close();
        await fixture.cleanup();
    }
});
