// User Note 5 — plurnk:///manifest.json is catalogued by mtime (entries.updated_at),
// oldest-modified first / newest last, so the prompt-cache prefix (dormant entries)
// stays stable across turns and churn clusters at the tail. A re-edited entry moves
// to the tail while the rest hold their positions.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const mock = () => new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });

test("manifest catalog is mtime-ordered — a re-edited entry sorts to the tail, the rest hold their prefix", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "manifest-mtime" });
            await rpcCall(ws, 2, "op.edit", { target: "known:///a.md", content: "alpha" });
            await rpcCall(ws, 3, "op.edit", { target: "known:///b.md", content: "bravo" });
            await rpcCall(ws, 4, "op.edit", { target: "known:///c.md", content: "charlie" });
            // Re-edit a — now the most-recently-modified, so it must sort to the tail
            // (oldest-modified first); b and c keep their relative order at the front.
            await rpcCall(ws, 5, "op.edit", { target: "known:///a.md", content: "alpha-2" });
            await runLoopToTerminal(ws, 6, { prompt: "go" }); // a model turn rebuilds the catalog
            const body = await (db.test_get_channel_by_pathname_scheme as PrepMethod).get<{ content: string }>({
                pathname: "/manifest.json", scheme: "plurnk", name: "body",
            });
            const known = (JSON.parse(body?.content ?? "[]") as Array<{ path: string }>)
                .map((e) => e.path).filter((p) => p.startsWith("known:///"));
            assert.deepEqual(known, ["known:///b.md", "known:///c.md", "known:///a.md"],
                "b, c, then the re-edited a at the tail — oldest-modified first");
        } finally { ws.close(); }
    });
});
