import assert from "node:assert/strict";
import { test } from "node:test";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { OutboundModule as A2aModule } from "@plurnk/plurnk-a2a";
import { Module as ScheduleModule } from "@plurnk/plurnk-schedule";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";

test("{§operator-config-precedence} empty environment definitions stay absent through workspace discovery, listing and enablement", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const workspaceId = await insertWorkspace(db, "empty-definitions");
        daemon.registerModule(A2aModule.init({
            PLURNK_A2A_ERROR_DETAIL_LIMIT: "512",
            PLURNK_A2A_MASKED: "",
            PLURNK_A2A_MASKED_HEADERS: "not JSON",
            PLURNK_A2A_OTHER: "https://agent.example",
            PLURNK_A2A_ENABLED: '["masked"]',
        }));
        daemon.registerModule(ScheduleModule.init({ env: {
            TZ: "UTC",
            PLURNK_SCHEDULE_MASKED: "",
            PLURNK_SCHEDULE_OTHER: '{"rule":"FREQ=HOURLY","target":"worker://bot","prompt":"Check in."}',
            PLURNK_SCHEDULE_ENABLED: '["masked"]',
        } }));
        await daemon.start();
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        for (const family of ["a2a", "schedule"]) {
            const result = await invoke(family, "list") as FunctionalityListResult;
            assert.deepEqual(result.definitions.map(({ alias, state, origin }) => ({ alias, state, origin })), [
                { alias: "other", state: "disabled", origin: "service" },
            ], family);
            await assert.rejects(() => invoke(family, "enable", { alias: "masked" }), (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                const { problem } = error.result;
                assert.equal(problem.status, 404);
                assert.match(problem.type, /\/alias-unknown$/u);
                return true;
            });
        }
        for (const [family, configuration] of [
            ["a2a", { PLURNK_A2A_OTHER: "", PLURNK_A2A_OTHER_HEADERS: "not JSON" }],
        ] as const) {
            const result = await invoke(family, "discover", { configuration }) as { candidates: unknown[] };
            assert.deepEqual(result.candidates, [], family);
            const listed = await invoke(family, "list") as FunctionalityListResult;
            assert.deepEqual(listed.definitions.map(({ alias }) => alias), ["other"], "inert discovery did not change workspace state");
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});
