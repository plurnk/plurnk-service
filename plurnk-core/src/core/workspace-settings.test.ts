import test from "node:test";
import assert from "node:assert/strict";
import WorkspaceSettings from "./workspace-settings.ts";

test("workspace open context: known knobs map, unknown fields read as null, and the retired mdDocs channel is inert", async () => {
    const read = WorkspaceSettings.read as unknown as (db: {
        workspace_get_settings: {
            get: (query: object) => Promise<{ settings: string } | undefined>;
        };
    }, workspaceId: number) => Promise<Record<string, unknown>>;
    const result = await read({
        workspace_get_settings: {
            get: async () => ({
                settings: JSON.stringify({
                    filesItems: 3,
                    git: false,
                    fileCreateScope: "root",
                    mdDocs: [{ alias: "POLICY", content: "# Policy" }],
                }),
            }),
        },
    }, 1);
    assert.equal(result.filesItems, 3);
    assert.equal(result.git, false);
    assert.equal(result.fileCreateScope, "root");
    assert.equal(result.maxCommands, null);
    assert.equal(result.client, null);
    assert.equal(result.execs, null);
    assert.equal("mdDocs" in result, false, "the retired channel contributes nothing");
});
