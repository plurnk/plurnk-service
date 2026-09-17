// {§env-option} — the heading's environment on WORK: the child starts with the parent's copy plus the
// names the heading gives it as its own, and its first command sees them. Through the real loop:
// the parent's WORK proposes and is accepted, the child runs, the parent collects.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitForDb } from "./_rpc.ts";

test("{§env-option} WORK hands the child an environment of its own, seen by its first command", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("```WORK (worker://kid) [{\"env\": {\"KID_ONLY\": \"1\"}}]\nPrint KID_ONLY and conclude.\n```\n\n```WAIT\nwaiting\n```", 10),
        makeMockResponse("```sh\necho kid=[$KID_ONLY]\n```\n\n```NOTE\nprinted\n```", 10),
        makeMockResponse("```SEND\nprinted\n```", 10),
        makeMockResponse("```SEND\ndone\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "env-modifier" });
            const workspaceId = 1;
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "delegate", policy: { proposals: "accept" } }, { timeoutMs: 20_000 });
            assert.equal(finalStatus, 200);

            const kid = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "kid" });
            assert.ok(kid, "the child exists");
            const state = await db.worker_module_state_get.get<{ state: string }>({ worker_id: kid.id, namespace_owner: "@plurnk/plurnk-service" });
            const definitions = (JSON.parse(state!.state) as { definitions: Record<string, unknown> }).definitions;
            assert.deepEqual(definitions.KID_ONLY, { origin: "worker", enabled: true, definition: { value: "1" } },
                "the heading's name is the child's own entry — not inherited, since the child set nothing and the parent never had it");

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
