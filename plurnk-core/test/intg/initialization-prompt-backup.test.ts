import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string | null; pathname: string; scheme: string | null; hostname: string | null; sequence: number; turn_id: number; signal: string | null; status_rx: number; tx: string; rx: string; origin: string };
const mock = () => new Mock({ contextWindow: 100000, responses: [makeMockResponse("## SEND0 [200]\ndone", 50), makeMockResponse("## SEND0 [200]\ndone", 50)] });

test("{§worker-initialization-entry}: turn 0 archives the prompt into worker://~/prompts.md by COPY <-1>", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompt-backup" });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "first prompt" }) as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const copies = rows.filter((r) => r.op === "COPY");
            const prompt = rows.find((r) => r.op === "prompt");
            assert.equal(copies.length, 1, "turn 0 foists exactly one COPY");
            const [copy] = copies;
            assert.ok(prompt !== undefined, "the prompt row is published");
            assert.equal(copy.scheme, "prompt");
            assert.equal(copy.pathname, prompt.pathname, "the COPY source is this loop's prompt entry");
            assert.equal(copy.origin, "_plurnk");
            assert.ok(copy.turn_id < prompt.turn_id, "the archive precedes the model turn that publishes the prompt row");
            assert.equal(copy.status_rx, 201, "COPY <-1> onto the absent private entry creates it");
            assert.deepEqual(JSON.parse(copy.signal ?? "null"), ["+_plurnk", "+backup"]);
            assert.deepEqual(
                (JSON.parse(copy.rx) as { effects: unknown[] }).effects,
                [{ target: "worker://~/prompts.md", action: "create" }],
                "the receipt names the private address the program typed",
            );
            const tx = JSON.parse(copy.tx) as { body: { target: { raw: string } } };
            assert.equal(tx.body.target.raw, "worker://~/prompts.md", "the destination path excludes its scope whitespace");
            const body = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/prompts.md", scheme: "worker", name: "body" });
            assert.equal(body?.content, "first prompt", "COPY <-1> onto the absent private entry created it with the prompt");

            const { loopId: second } = await runLoopToTerminal(ws, 3, { prompt: "second prompt" }) as { loopId: number };
            const rows2 = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: second });
            assert.equal(rows2.find((r) => r.op === "COPY"), undefined, "initialization is once per worker: a later loop archives nothing");
            const body2 = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/prompts.md", scheme: "worker", name: "body" });
            assert.equal(body2?.content, "first prompt");
        } finally { ws.close(); }
    });
});
