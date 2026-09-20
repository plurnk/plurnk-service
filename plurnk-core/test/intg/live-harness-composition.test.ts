import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import { Validator, type OperationResult } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as ScheduleModule } from "@plurnk/plurnk-schedule";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { liveWorkspace } from "../_live-harness.ts";
import { readStmt } from "./_dsl.ts";
import { lastReply } from "./_helpers.ts";
import { makeMockResponse, waitFor, waitForDb } from "./_rpc.ts";

test("{§service-worker-composition} live workspaces expose the default worker references and management families", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const workspace = await liveWorkspace({ name: "harness-reference-composition" });
    try {
        const workerId = await workspace.daemon.ensureModelWorker(workspace.workspaceId);
        const read = (target: string) => workspace.daemon.dispatchAsClient({
            workspaceId: workspace.workspaceId,
            workerId,
            statement: readStmt(parsePath(target), { marks: [1, -1] }),
        });

        const skill = await read("skill://plurnk/SKILL.md");
        assert.equal(skill.status, 200);
        for (const reference of ["worker", "members", "skills", "mcp", "a2a", "sh", "schedule"]) {
            const result = await read(`worker:///_plurnk/plurnk/${reference}.md`);
            assert.equal(result.status, 200, `${reference}.md is READ-able in the worker's actual generated tree`);
            assert.match(String(result.content), /\S/, `${reference}.md contains its contract`);
        }
        for (const family of ["skills", "mcp", "a2a", "members", "schedule"]) {
            const result = Validator.assertFunctionalityListResult(
                await workspace.invokeWorkspaceAction(`workspace.${family}.list`, {}),
            );
            assert.equal(result.family, family, `${family} management belongs to the same composed worker`);
        }
        assert.equal(inference.mock.callCount(), 0, "capability discovery never requires inference");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
});

test("{§service-worker-composition} specimen schedules deliver and shut down without activating operator rules", async (t) => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [makeMockResponse("````SEND\nScheduled message received.\n````", 10)],
    });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const profile = parseEnv(await readFile(new URL("../../.env.test", import.meta.url), "utf8"));
    const environment = {
        PLURNK_SCHEDULE_ENABLED: profile.PLURNK_SCHEDULE_ENABLED!,
        PLURNK_SCHEDULE_fixture: JSON.stringify({ rule: "FREQ=HOURLY", target: "worker://operator", prompt: "Operator work." }),
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    Object.assign(process.env, environment);

    let now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const armed = new Map<number, () => void>();
    let nextTimer = 0;
    const init = ScheduleModule.init;
    t.mock.method(ScheduleModule, "init", (options = {}) => init({
        ...options,
        clock: () => now,
        timers: {
            set: (callback) => { const id = ++nextTimer; armed.set(id, callback); return id; },
            clear: (id) => { armed.delete(id as number); },
        },
    }));
    const workspace = await liveWorkspace({ name: "harness-schedule-composition" });
    try {
        const workerId = await workspace.daemon.ensureModelWorker(workspace.workspaceId);
        const worker = (await workspace.daemon.listWorkers(workspace.workspaceId)).find(({ id }) => id === workerId)!;
        const list = async () => Validator.assertFunctionalityListResult(await workspace.invokeWorkspaceAction("workspace.schedule.list", {}));
        const mutate = async (verb: string, params: Record<string, unknown>) => Validator.assertFunctionalityMutationResult(
            await workspace.invokeWorkspaceAction(`workspace.schedule.${verb}`, params),
        );
        assert.equal((await list()).definitions.find(({ alias }) => alias === "fixture")?.state, "disabled");
        assert.equal(armed.size, 0, "operator rules remain disabled under the real-model gate profile");
        const discovered = Validator.assertFunctionalityDiscoverResult(await workspace.invokeWorkspaceAction("workspace.schedule.discover", {
            source: "FREQ=HOURLY;COUNT=1",
        }));
        assert.equal(discovered.candidates.length, 1);
        assert.match(discovered.candidates[0]!.summary ?? "", /now .+next/u);
        const definition = {
            ...discovered.candidates[0]!.definition,
            target: `worker://${worker.name}`,
            prompt: "Take the scheduled message.",
            policy: { proposals: "accept" },
        };
        const completed: Array<{ loopId: number; result: OperationResult }> = [];
        const unsubscribe = workspace.daemon.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === workspace.workspaceId && method === "loop/terminated") {
                completed.push(params as { loopId: number; result: OperationResult });
            }
        });
        t.after(unsubscribe);
        assert.equal((await mutate("add", { alias: "beat", definition })).status, 201);
        assert.equal(armed.size, 1);
        now += 1000;
        const due = [...armed.values()];
        armed.clear();
        for (const callback of due) callback();
        await waitFor(() => completed, (events) => events.length === 1, { timeoutMs: 15_000 });
        assert.equal(completed[0]!.result.status, 200);
        assert.equal(await lastReply(workspace.db, completed[0]!.loopId), "Scheduled message received.");
        assert.equal(inference.mock.callCount(), 1, "only the explicitly added fixture scheduled inference");
        const rows = await workspace.db.test_log_entries_by_loop.all<{ op: string; origin: string; source: string | null }>({ loop_id: completed[0]!.loopId });
        assert.equal(rows.filter(({ op, origin, source }) => op === "SEND" && origin === "_plurnk" && source === "schedule://beat").length, 1,
            "the occurrence arrives through ordinary source-attributed worker messaging");
        await waitForDb(list, ({ definitions }) =>
            (definitions.find(({ alias }) => alias === "beat")?.detail as { exhausted?: boolean } | undefined)?.exhausted === true);
        assert.equal(armed.size, 0, "the one-shot rule is exhausted");
        assert.equal((await list()).definitions.find(({ alias }) => alias === "fixture")?.state, "disabled");
        assert.equal((await mutate("remove", { alias: "beat" })).status, 200);
        assert.ok(!(await list()).definitions.some(({ alias }) => alias === "beat"));
        assert.equal((await mutate("add", { alias: "later", definition: { ...definition, rule: "FREQ=HOURLY;COUNT=2" } })).status, 201);
        assert.equal(armed.size, 1, "shutdown has an armed rule to dispose");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
    assert.equal(armed.size, 0, "liveWorkspace cleanup closes the actual scheduling module");
});
