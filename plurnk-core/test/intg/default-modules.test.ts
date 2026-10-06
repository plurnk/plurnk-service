// {§module-discovery} — a daemon with nothing registered composes the installed default modules
// by discovery alone, as the service does.
import assert from "node:assert/strict";
import test from "node:test";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";

const VERBS = ["add", "disable", "discover", "enable", "list", "remove"];

test("{§mcp-module} {§schedule-module} {§a2a-module} a bare daemon discovers the MCP, schedule and A2A families", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const names = daemon.listModuleActions().map(({ name }) => name);
    for (const family of ["mcp", "schedule", "a2a"]) {
        assert.deepEqual(
            names.filter((name) => name.startsWith(`workspace.${family}.`)).map((name) => name.slice(`workspace.${family}.`.length)).filter((verb) => VERBS.includes(verb)).toSorted(),
            VERBS,
            `the ${family} family arrives without explicit composition`,
        );
    }
});

test("{§agui-daemon-client} {§module-http-mounts} a bare daemon with a listener discovers the client interface at its root", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const response = await fetch(`http://127.0.0.1:${http.httpAddress().port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            threadId: "discover", runId: "discover", state: {}, messages: [], tools: [], context: [],
            forwardedProps: { plurnk: { action: { kind: "discover" } } },
        }),
    });
    assert.equal(response.status, 200);
    const result = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as { type: string; name?: string; value?: { ok?: boolean } })
        .find(({ type, name }) => type === "CUSTOM" && name === "plurnk.action.result");
    assert.equal(result?.value?.ok, true, "the discovered client interface answers discover");
});

test("{§a2a-module} {§module-contained-configuration} an invalid exposure setting is reported and outbound A2A keeps working", async (t) => {
    const prior = process.env.PLURNK_A2A_EXPOSE;
    process.env.PLURNK_A2A_EXPOSE = "yes";
    t.after(() => { if (prior === undefined) delete process.env.PLURNK_A2A_EXPOSE; else process.env.PLURNK_A2A_EXPOSE = prior; });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.listModuleActions().some(({ name }) => name === "workspace.a2a.list"), "the outbound family is registered");
    assert.deepEqual(
        daemon.configurationNotices().filter(({ owner }) => owner === "module:@plurnk/plurnk-a2a").map(({ key }) => key),
        ["PLURNK_A2A_EXPOSE"],
        "the contained setting is the module's own configuration notice",
    );
});
