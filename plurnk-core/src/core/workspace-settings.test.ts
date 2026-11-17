import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";

test("{§operator-config-workspace-settings}: workspace proposalPolicy and standing permissions default cleanly and reject invalid persisted values", async () => {
    const read = (settings: string) => WorkspaceSettings.read({
        workspace_get_settings: { get: async () => ({ settings }) },
    } as unknown as Db, 17);
    const defaults = await read("{}");
    assert.equal(defaults.proposalPolicy, null);
    assert.deepEqual(defaults.permissions, {});

    const configured = await read(JSON.stringify({
        proposalPolicy: "accept",
        permissions: { "runtime:sh": "allow_always", "op:edit:none": "reject_always" },
    }));
    assert.equal(configured.proposalPolicy, "accept");
    assert.deepEqual(configured.permissions, {
        "runtime:sh": "allow_always",
        "op:edit:none": "reject_always",
    });

    for (const proposalPolicy of [false, 123, "", "sometimes", [], {}]) {
        await assert.rejects(read(JSON.stringify({ proposalPolicy })), {
            message: "Workspace 17 has invalid persisted proposal policy.",
        });
    }
    for (const permissions of [null, false, [], { "runtime:sh": "maybe" }, { "": "allow_always" }]) {
        await assert.rejects(read(JSON.stringify({ permissions })), {
            message: "Workspace 17 has invalid persisted permissions.",
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
