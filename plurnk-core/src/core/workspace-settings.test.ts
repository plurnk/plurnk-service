import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";

test("{§workspace-capability-policy}: absent workspace capabilities are unrestricted; invalid persisted policies fail at their owner", async () => {
    const read = (settings: string) => WorkspaceSettings.read({
        workspace_get_settings: { get: async () => ({ settings }) },
    } as unknown as Db, 17);
    assert.deepEqual((await read("{}")).capabilities, {});
    assert.deepEqual((await read('{"capabilities":{"deny":[{"runtime":"sh"}]}}')).capabilities, {
        deny: [{ runtime: "sh" }],
    });
    for (const capabilities of [null, false, [], { deny: [{}] }]) {
        await assert.rejects(read(JSON.stringify({ capabilities })), (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "Workspace 17 has invalid persisted capability policy.");
            assert.ok(error.cause instanceof Error);
            return true;
        });
    }
    for (const settings of ["null", "[]", "{"]) {
        await assert.rejects(read(settings), (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "Workspace 17 has invalid persisted settings.");
            assert.ok(error.cause instanceof Error);
            return true;
        });
    }
});
