import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string | null; pathname: string; scheme: string | null; origin: string; status_rx: number };
const mock = () => new Mock({ contextWindow: 100000, responses: [makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 50)] });

// {§worker-initialization-entry} — the prompt entry is the archive; turn 0 copies nothing into scratch.
test("{§worker-initialization-entry}: turn 0 archives nothing; the prompt entry is the durable copy", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompt-no-archive" });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "first prompt" });
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            assert.equal(rows.find((r) => r.op === "COPY"), undefined, "no archiving COPY rides turn 0");
            const prompt = rows.find((r) => r.op === "prompt");
            assert.ok(prompt !== undefined, "the prompt row is published");
            assert.equal(prompt.scheme, "prompt", "the publication names the prompt entry");
            const scratch = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/prompts.md", scheme: "worker", name: "body" });
            assert.equal(scratch, undefined, "no prompts.md scratch entry exists");
        } finally { ws.close(); }
    });
});
