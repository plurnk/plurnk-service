import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { parsePath, Validator } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { liveWorkspace } from "../_live-harness.ts";
import { readStmt } from "./_dsl.ts";

test("{§service-worker-composition} live workspaces expose the default worker references and management families", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const workspace = await liveWorkspace({ name: "harness-reference-composition" });
    try {
        const workerId = await workspace.daemon.ensureModelWorker(workspace.workspaceId);
        const read = (target: string) => workspace.daemon.dispatchAsClient({
            workspaceId: workspace.workspaceId,
            workerId,
            functionalityWorkerId: workerId,
            statement: readStmt(parsePath(target), { marks: [1, -1] }),
        });

        const skill = await read("skill://plurnk/SKILL.md");
        assert.equal(skill.status, 200);
        for (const reference of ["worker", "members", "skills", "mcp", "agents", "a2a", "sh"]) {
            const result = await read(`worker://~/_plurnk/plurnk/${reference}.md`);
            assert.equal(result.status, 200, `${reference}.md is READ-able in the worker's actual generated tree`);
            assert.match(String(result.content), /\S/, `${reference}.md contains its contract`);
        }
        for (const family of ["skills", "mcp", "agents", "members"]) {
            const result = Validator.assertFunctionalityListResult(
                await workspace.invokeWorkerAction(`worker.${family}.list`, {}),
            );
            assert.equal(result.family, family, `${family} management belongs to the same composed worker`);
        }
        assert.equal(inference.mock.callCount(), 0, "capability discovery never requires inference");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
});
