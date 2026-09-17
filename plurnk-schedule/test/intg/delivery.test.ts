// {§schedule-delivery} — the module inside a real daemon: a worker adds a rule through the family
// action, the occurrence fires, and the target worker's log carries the message as an arrival row
// from `schedule://<alias>` ({§message-causal-source}); the family's list names the next occurrence.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Module from "../../src/Module.ts";
import type { SchedulerTimers } from "../../src/Scheduler.ts";

const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");
const NOW = Date.UTC(2026, 8, 16, 12, 30, 15, 250);
const FIRST = Date.UTC(2026, 8, 16, 12, 30, 16);

interface LogRow { readonly op: string; readonly origin: string; readonly source: string | null; readonly attrs: string }

test("a scheduled message reaches its worker as an arrival from schedule://<alias>", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { openMigrated, insertWorkspace, insertWorker, rootWorkspace }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_rpc.ts")),
        import(join(SERVICE, "test/intg/_helpers.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [makeMockResponse("```SEND\nBeat taken.\n```\n```DONE\n```", 10)],
    });
    const artifacts = resolve(import.meta.dirname, ".tmp");
    const db = await openMigrated(join(artifacts, `db-${crypto.randomUUID()}.db`));
    const root = await mkdtemp(join(tmpdir(), "plurnk-schedule-"));
    const workspaceId = await insertWorkspace(db, "scheduled");
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId, null, "recipient", "model");

    let now = NOW;
    const armed = new Map<number, () => void>();
    let nextTimer = 1;
    const timers: SchedulerTimers = {
        set: (callback) => { const id = nextTimer++; armed.set(id, callback); return id; },
        clear: (id) => { armed.delete(id as number); },
    };
    const module = Module.init({ env: { TZ: "UTC" }, clock: () => now, timers });
    let port: ApplicationPort | null = null;
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    daemon.registerModule({
        setup: (seam: Parameters<Module["setup"]>[0]) => { module.setup(seam); },
        start: async (seam: ApplicationPort) => { port = seam; await module.start(seam); },
        close: () => module.close(),
    });
    await daemon.start();
    try {
        const application = port as unknown as ApplicationPort;
        const terminated = new Promise<void>((resolveTerminated) => {
            application.subscribeToEvents((_workspaceId, method) => { if (method === "loop/terminated") resolveTerminated(); });
        });
        const added = await application.invokeModuleAction("workspace.schedule.add", {
            alias: "beat",
            definition: { rule: "FREQ=HOURLY;COUNT=2", target: "worker://recipient", prompt: "Take the beat.", policy: { proposals: "accept" } },
        }, { scope: "workspace", workspaceId }) as { status: number; alias: string; definition?: { state: string; detail?: { next: string | null; rule: string } } };
        assert.equal(added.status, 201);
        assert.equal(added.alias, "beat");
        assert.equal(added.definition?.state, "active");
        assert.equal(added.definition?.detail?.rule, "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2", "the stored rule is canonical");
        assert.equal(added.definition?.detail?.next, "2026-09-16T12:30:16+00:00[UTC]");
        assert.equal(armed.size, 1, "one occurrence armed");

        now = FIRST;
        for (const callback of [...armed.values()]) callback();
        await terminated;

        const rows = await db.test_log_entries_by_loop.all({ loop_id: (await db.test_all_loops.all() as Array<{ id: number; worker_id: number }>).find((loop) => loop.worker_id === workerId)!.id }) as LogRow[];
        const arrivals = rows.filter((row) => row.op === "SEND" && row.origin === "_plurnk" && (JSON.parse(row.attrs) as { kind?: string }).kind === "message");
        assert.equal(arrivals.length, 1, "the delivery published exactly one arrival row");
        assert.equal(arrivals[0]!.source, "schedule://beat", "the arrival names the schedule as its causal source");

        const deadline = Date.now() + 10_000;
        let next: string | null | undefined;
        while (Date.now() < deadline) {
            const listing = await application.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as { definitions: Array<{ alias: string; detail?: { next: string | null } }> };
            next = listing.definitions.find(({ alias }) => alias === "beat")?.detail?.next;
            if (next === "2026-09-16T13:30:16+00:00[UTC]") break;
            await sleep(50);
        }
        assert.equal(next, "2026-09-16T13:30:16+00:00[UTC]", "after the fire the family lists the following occurrence");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
