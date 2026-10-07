import test from "node:test";
import assert from "node:assert/strict";
import { Validator } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";

test("{§model-catalog}: AG-UI delivers route reasoning choices without creating a workspace or worker", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const query = { provider: "google", search: "gemini-3.7-flash", availability: "all" as const };
    const response = await fetch(`http://127.0.0.1:${http.httpAddress().port}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            threadId: "catalog-only",
            runId: "catalog",
            state: {}, messages: [], tools: [], context: [],
            forwardedProps: { plurnk: { action: { kind: "models.list", ...query } } },
        }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = (await response.text()).split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)));
    const result = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result")?.value;
    assert.equal(result?.ok, true, JSON.stringify(result));
    const page = Validator.assertModelCatalogPage(result.result);
    assert.deepEqual(page, daemon.listModels(query));
    const model = page.items.find(({ model }) => model === "gemini-3.7-flash");
    assert.ok(model);
    assert.deepEqual(model.capabilities.efforts, ["adaptive", "low", "medium", "high"]);
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    assert.deepEqual(await daemon.listWorkspaces(), []);
});
