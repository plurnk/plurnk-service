import assert from "node:assert/strict";
import { test } from "node:test";
import { Problems, type FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { OutboundModule as A2aModule } from "@plurnk/plurnk-a2a";
import { Module as ScheduleModule } from "@plurnk/plurnk-schedule";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";

test("{§resource-environment} disabled definitions stay inspectable through workspace listing and inert discovery", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const definitions = {
        a2a: { name: "other", url: "https://agent.example", headers: { "X-Tenant": "${TENANT}" } },
        schedule: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY", target: "worker://bot", prompt: "Check in." },
    };
    try {
        const workspaceId = await insertWorkspace(db, "resource-definitions");
        daemon.registerModule(A2aModule.init({
            PLURNK_A2A_ERROR_DETAIL_LIMIT: "512",
            PLURNK_A2A_other: JSON.stringify(definitions.a2a),
            PLURNK_A2A_ENABLED: "1",
            PLURNK_A2A_other_ENABLED: "0",
        }));
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
        daemon.registerModule(schedule);
        await daemon.start();
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        for (const family of ["a2a", "schedule"] as const) {
            const result = await invoke(family, "list") as FunctionalityListResult;
            assert.deepEqual(result.definitions.map(({ alias, state, origin }) => ({ alias, state, origin })), [
                { alias: "other", state: "disabled", origin: "service" },
            ], family);
            assert.deepEqual(result.definitions[0]?.definition, definitions[family], "disabling preserves the complete inspectable definition");
            await assert.rejects(() => invoke(family, "enable", { alias: "absent" }), (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                const { problem } = error.result;
                assert.equal(problem.status, 404);
                assert.match(problem.type, /\/alias-unknown$/u);
                return true;
            });
        }
        const candidate = { name: "candidate", url: "https://candidate.example" };
        const discovered = await invoke("a2a", "discover", { configuration: {
            PLURNK_A2A_candidate: JSON.stringify(candidate), PLURNK_A2A_candidate_ENABLED: "0",
        } }) as { candidates: Array<{ alias: string; definition: unknown }> };
        assert.deepEqual(discovered.candidates.map(({ alias, definition }) => ({ alias, definition })), [{ alias: "candidate", definition: candidate }]);
        for (const value of ["", " \t"]) {
            await assert.rejects(() => invoke("a2a", "discover", { configuration: { PLURNK_A2A_other: value } }), (error: unknown) => {
                const problem = Problems.fromError(error);
                assert.ok(problem);
                assert.equal(problem.status, 400);
                assert.equal(problem.type, "https://problems.plurnk.xyz/a2a/functionality/configuration-invalid");
                return true;
            });
        }
        const listed = await invoke("a2a", "list") as FunctionalityListResult;
        assert.deepEqual(listed.definitions.map(({ alias, state, definition }) => ({ alias, state, definition })), [
            { alias: "other", state: "disabled", definition: definitions.a2a },
        ], "neither successful nor rejected discovery changes workspace state");
        assert.deepEqual(schedule.functionality.scheduler.armed(workspaceId), []);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
