// {§schedule-module} — the schedule family arrives by discovery like any installed module: it
// registers before durable lifecycle recovery and arms the coordinator's persisted rules at start.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";
import { waitForDb } from "./_rpc.ts";

// The discovered module reads the operator's environment, as the service's would.
const environment = (t: TestContext): void => {
    const values = { TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" };
    const prior = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
};

test("{§schedule-module} a discovered schedule rejects malformed persisted enabledness before arming", async (t) => {
    environment(t);
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "discovered-invalid-schedule");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId,
        namespace_owner: "@plurnk/plurnk-schedule",
        state: JSON.stringify({ version: 1, definitions: { beat: {
            origin: "workspace", enabled: "false",
            definition: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2", target: "worker://recipient", prompt: "Must not fire." },
        } } }),
    });
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await assert.rejects(daemon.start(), { name: "Error", message: "Functionality state for schedule alias 'beat' is malformed." });
});

test("{§schedule-module} a discovered schedule arms a persisted rule at restart and delivers it on time", { timeout: 30_000 }, async (t) => {
    environment(t);
    const db = await openMigrated();
    const first = new Daemon({ db, provider: null });
    await first.start();
    const { workspaceId } = await first.createWorkspace({ name: "discovered-schedule", projectRoot: null });
    const { workerName } = await first.createConversationWorker({ workspaceId, name: "recipient" });
    const due = new Date(Math.ceil((Date.now() + 4_000) / 1_000) * 1_000);
    const stamp = due.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "");
    const added = await first.invokeModuleAction("workspace.schedule.add", {
        alias: "once",
        definition: { rule: `DTSTART;TZID=UTC:${stamp}\nRRULE:FREQ=HOURLY;COUNT=1`, target: `worker://${workerName}`, prompt: "discovered-proof" },
    }, { scope: "workspace", workspaceId }) as { status: number };
    assert.equal(added.status, 201);
    await first.stop();

    const provider = new Mock({ contextWindow: 65_536, responses: [{ assistant: { content: "````KILL\nReceived.\n````", reasoning: null } }] });
    const second = new Daemon({ db, provider });
    t.after(async () => { await second.stop(); await db.close(); });
    await second.start();
    await waitForDb(async () => provider.received.length, (calls) => calls >= 1, { timeoutMs: 15_000 });
    assert.match(JSON.stringify(provider.received[0]), /discovered-proof/u, "the restarted daemon's discovered family delivered the persisted rule");
});
