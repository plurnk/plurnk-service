import { serverProposals } from "./_approval.ts";
// {§env-option} — WORK/FORK override the parent's copied environment before the child's first command.
import test from "node:test";
import assert from "node:assert/strict";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

for (const op of ["WORK", "FORK"]) for (const inherited of ["absent", "active", "disabled"] as const)
test(`{§env-option} ${op} replaces the child's ${inherited} inherited value before its first command`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse(`\`\`\`\`${op} (worker://kid) [{"env": {"KID_ONLY": "1"}}]\nPrint KID_ONLY and conclude.\n\`\`\`\`\n\n\`\`\`\`WAIT\nwaiting\n\`\`\`\``, 10),
        makeMockResponse("````sh\necho kid=[$KID_ONLY]\n````\n\n````NOTE\nprinted\n````", 10),
        makeMockResponse("````SEND [200]\nprinted\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "env-modifier" });
            const { id: workspaceId } = created.result as { id: number };
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`worker.env.${verb}`, params, { scope: "worker", workspaceId, workerId });
            if (inherited !== "absent") {
                await invoke("add", { alias: "KID_ONLY", definition: { value: "parent" } });
                if (inherited === "disabled") await invoke("disable", { alias: "KID_ONLY" });
            }
            const parentBefore = await invoke("list") as FunctionalityListResult;
            const { finalStatus } = await runLoopToTerminal(ws, 2, { workerId, prompt: "delegate" }, { timeoutMs: 20_000 });
            assert.equal(finalStatus, 200);

            const kid = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "kid" });
            assert.ok(kid, "the child exists");
            const state = await db.worker_module_state_get.get<{ state: string }>({ worker_id: kid.id, namespace_owner: "@plurnk/plurnk-service" });
            const definitions = (JSON.parse(state!.state) as { definitions: Record<string, unknown> }).definitions;
            assert.deepEqual(definitions.KID_ONLY, { origin: "worker", enabled: true, definition: { value: "1" } },
                "an explicit child override is its own enabled value, even when the copied definition was disabled");
            assert.deepEqual(await invoke("list"), parentBefore, "the override never mutates the parent's definition or enabledness");

            const outputs = await db.test_entries_by_scheme_prefix.all<{ id: number; pathname: string }>({ workspace_id: workspaceId, scheme: "sh", prefix: "/%" });
            assert.equal(outputs.length, 1, "the child's one command");
            const stdout = await waitForDb(async () => {
                const channel = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: outputs[0]!.id, name: "stdout" });
                return channel?.state === "closed" ? channel.content : null;
            }, (content) => content !== null, { timeoutMs: 10_000 });
            assert.match(stdout ?? "", /kid=\[1\]/u, "the child's first command sees the environment the heading gave it");
            const output = await db.crud_find_workspace_entry.get<{ attributes: string }>({ workspace_id: workspaceId, scheme: "sh", authority: "", pathname: outputs[0]!.pathname });
            assert.deepEqual((JSON.parse(output!.attributes) as { env: Record<string, unknown> }).env.KID_ONLY, { source: "worker", value: "1" },
                "recorded as the child's own: it entered the registry, unlike a fence's modifier");
        } finally { ws.close(); }
    });
});
