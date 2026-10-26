import test from "node:test";
import assert from "node:assert/strict";
import { Validator } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_http.ts";
import { openMigrated } from "./_db.ts";

test("{§model-catalog}: ACP delivers route reasoning choices without creating a workspace or session", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/acp`;
    const initRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
        }),
    });
    assert.equal(initRes.status, 200);
    const connId = initRes.headers.get("acp-connection-id");
    assert.ok(connId);
    const sseAbort = new AbortController();
    t.after(() => sseAbort.abort());
    const sseRes = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream", "acp-connection-id": connId },
        signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    const query = { provider: "google", search: "gemini-3.7-flash", availability: "all" as const };
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "acp-connection-id": connId },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "_plurnk/action",
            params: { kind: "models.list", params: query },
        }),
    });
    assert.equal(response.status, 202);
    let rpc: { id?: number; result?: unknown; error?: unknown } | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of sseRes.body!) {
        buf += decoder.decode(chunk, { stream: true });
        for (const frame of buf.split("\n\n")) {
            if (!frame.startsWith("data: ")) continue;
            const parsed = JSON.parse(frame.slice(6)) as { id?: number; result?: unknown; error?: unknown };
            if (parsed.id === 1) {
                rpc = parsed;
                break;
            }
        }
        if (rpc !== undefined) break;
    }
    sseAbort.abort();
    assert.ok(rpc !== undefined);
    assert.equal(rpc.error, undefined, JSON.stringify(rpc));
    const page = Validator.assertModelCatalogPage(rpc.result);
    assert.deepEqual(page, daemon.listModels(query));
    const model = page.items.find((item) => item.model === "gemini-3.7-flash");
    assert.ok(model);
    assert.deepEqual(model.capabilities.efforts, ["adaptive", "low", "medium", "high"]);
    assert.deepEqual(await daemon.listWorkspaces(), []);
});
