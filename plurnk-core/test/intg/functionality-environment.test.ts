import assert from "node:assert/strict";
import { test } from "node:test";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Module as ScheduleModule } from "@plurnk/plurnk-schedule";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";

test("{§resource-environment} disabled definitions stay inspectable through workspace listing and inert discovery", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const definitions = {
        mcp: { name: "other", type: "streamable-http", url: "https://mcp.example", headers: { "X-Tenant": "${TENANT}" } },
        schedule: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY", target: "session://bot", prompt: "Check in." },
    };
    try {
        const workspaceId = await insertWorkspace(db, "resource-definitions");
        daemon.registerModule(McpModule.init({
            env: {
                ...process.env,
                PLURNK_MCP_other: JSON.stringify(definitions.mcp),
                PLURNK_MCP_ENABLED: "1",
                PLURNK_MCP_other_ENABLED: "0",
            },
        }), "@plurnk/plurnk-mcp");
        const schedule = ScheduleModule.init({
            env: {
                ...process.env,
                TZ: "UTC",
                PLURNK_SCHEDULE_other: JSON.stringify(definitions.schedule),
                PLURNK_SCHEDULE_ENABLED: "1",
                PLURNK_SCHEDULE_other_ENABLED: "0",
            },
            timers: { set: () => assert.fail("disabled schedules must not arm"), clear: () => {} },
        });
        daemon.registerModule(schedule, "@plurnk/plurnk-schedule");
        await daemon.start();
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        for (const family of ["mcp", "schedule"] as const) {
            const result = await invoke(family, "list") as FunctionalityListResult;
            assert.deepEqual(result.definitions.map(({ alias, state, origin }) => ({ alias, state, origin })), [
                { alias: "other", state: "disabled", origin: "service" },
            ], family);
            assert.deepEqual(result.definitions[0]?.definition, definitions[family], "disabling preserves the complete inspectable definition");
            assert.deepEqual(result.definitions[0]?.provenance,
                { kind: "environment", source: `PLURNK_${family.toUpperCase()}_other` }, "the adapter carries the source through validation and projection");
            await assert.rejects(() => invoke(family, "enable", { alias: "absent" }), (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                const { problem } = error.result;
                assert.equal(problem.status, 404);
                assert.match(problem.type, /\/alias-unknown$/u);
                return true;
            });
        }
        const discovered = await invoke("schedule", "discover", { source: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY" }) as { candidates: Array<{ alias: string; definition: unknown }> };
        assert.equal(discovered.candidates.length, 1);
        const listed = await invoke("schedule", "list") as FunctionalityListResult;
        assert.deepEqual(listed.definitions.map(({ alias, state, definition }) => ({ alias, state, definition })), [
            { alias: "other", state: "disabled", definition: definitions.schedule },
        ], "discovery does not change workspace state");
        assert.deepEqual(schedule.functionality.scheduler.armed(workspaceId), []);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
