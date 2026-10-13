// {§a2a-inbound-exposure} {§a2a-outbound-turn-rhythm} — both halves of A2A on one daemon, a real
// model on both ends. The researcher workspace is hosted as an A2A agent on the daemon's own
// listener; the writer workspace holds it as an outbound definition. The writer is asked for a fact
// only the researcher's files hold, so the answer can only come back through the protocol: a
// Task-backed SEND that returns 102, a Task answered by a model child in the researcher workspace,
// and the writer's loop woken by the result. Graded on the reply and the wire, never on the words.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Exposure as A2aExposure, OutboundModule } from "@plurnk/plurnk-a2a";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveProvider, liveRun } from "../_live-harness.ts";
import { failAfterCleanup } from "../live-failure.ts";
import Daemon from "../../src/server/Daemon.ts";
import { A2A_EXPOSURE, a2aCard, bindListener, serviceUrl } from "../intg/_a2a.ts";
import { openMigrated } from "../intg/_db.ts";
import { connect, rpcCall } from "../intg/_rpc.ts";
import WorldState from "../intg/world-state.ts";
import { initializeDemoRepository } from "./_git.ts";

const CODENAME = "velvet-harbor-19";
const HOST_OWNER = { address: "test://host", tools: [] as string[], interactive: false };

test("a2a: two workers in different roles coordinate over A2A — the writer asks the hosted researcher for a fact only it holds", { timeout: 600_000 }, async (t) => {
    const researcherRoot = await mkdtemp(join(tmpdir(), "plurnk-a2a-researcher-"));
    const writerRoot = await mkdtemp(join(tmpdir(), "plurnk-a2a-writer-"));
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(async () => { await rm(writerRoot, { recursive: true, force: true }); });
    lifetime.defer(async () => { await rm(researcherRoot, { recursive: true, force: true }); });
    try {
        await writeFile(join(researcherRoot, "notes.md"), `# Research notes\n\nThe project codename is: ${CODENAME}\n`);
        initializeDemoRepository(researcherRoot, "researcher");
        await writeFile(join(writerRoot, "README.md"), "# Writer\n\nThis workspace holds no research of its own.\n");
        initializeDemoRepository(writerRoot, "writer");

        // One daemon, its one listener, a real model, and both A2A halves registered before start.
        const run = await liveRun("demo-a2a-closed-loop");
        const db = await openMigrated(run.dbPath);
        const provider = await liveProvider();
        const http = await bindListener();
        const daemon = new Daemon({ db, provider, hostPaths: run.hostPaths, http });
        daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
        const researcher = await daemon.createWorkspace({ name: "researcher", projectRoot: researcherRoot });
        await daemon.registerWorkerOwner(researcher.workspaceId, HOST_OWNER);
        const host = await daemon.createConversationWorker({ workspaceId: researcher.workspaceId, name: "researcher-host", owner: HOST_OWNER.address });
        // {§a2a-worker-ownership} — every Task the exposure admits becomes a model child of this host.
        daemon.registerModule(A2aExposure.init({
            ...A2A_EXPOSURE, parentWorker: host.workerName,
            workspace: { name: researcher.workspaceName, projectRoot: researcherRoot }, card: a2aCard(),
        }), "researcher-exposure");
        lifetime.defer(async () => { run.finish(); });
        lifetime.defer(async () => { await db.close(); });
        lifetime.defer(async () => { await http.close(); });
        lifetime.defer(async () => { await daemon.stop(); });
        await daemon.start();
        const ws = await connect({ daemon });
        lifetime.defer(async () => { ws.close(); });

        // The writer: an ordinary workspace whose outbound alias is the daemon's own hosted agent.
        const writer = (await rpcCall(ws, 1, "workspace.create", { name: "writer", projectRoot: writerRoot })).result as { id: number };
        const added = await daemon.invokeModuleAction("workspace.a2a.add", {
            alias: "researcher", definition: { name: "researcher", url: serviceUrl(daemon) },
        }, { scope: "workspace", workspaceId: writer.id }) as { status: number; problem?: unknown };
        assert.equal(added.status, 201, `the outbound definition was admitted: ${JSON.stringify(added.problem ?? added)}`);
        await daemon.settleFunctionality(writer.id);

        const loop = await liveLoop({ ws, db }, 2, {
            prompt: `The researcher agent is reachable over A2A as a2a://researcher. Ask it what the project codename is, then tell me the codename.`,
            maxTurns: 12,
        }, { signal: t.signal });

        assert.deepEqual(await WorldState.check(db), [], "the world stays lawful");
        assert.equal(loop.finalStatus, 200, "the writer's loop concludes");
        assert.equal(loop.hitMaxTurns, false, "without exhausting its turns");
        assert.ok(loop.lastContent.includes(CODENAME), `the writer reports the fact only the researcher's files hold; got: ${loop.lastContent.slice(0, 300)}`);

        // The wire: a Task-backed SEND to the alias that returned 102, settled by the remote result.
        const rows = (await Promise.all(loop.turnIds.map((turnId) =>
            db.test_log_entries_by_turn.all<{ op: string | null; scheme: string | null; hostname: string | null; status_rx: number }>({ turn_id: turnId }),
        ))).flat();
        assert.ok(rows.some((row) => row.op === "SEND" && row.scheme === "a2a" && row.hostname === "researcher" && row.status_rx === 102),
            `the writer opened a Task on a2a://researcher; rows: ${JSON.stringify(rows.filter((row) => row.scheme === "a2a").map(({ op, status_rx }) => `${op} ${status_rx}`))}`);

        // The other end: the researcher workspace answered through a model child of its host.
        const children = await daemon.listWorkers(researcher.workspaceId, { origin: "model" });
        assert.ok(children.length >= 1, "the exposure admitted the Task as a model worker in the researcher workspace");
    } catch (error) {
        await failAfterCleanup(error, () => lifetime.disposeAsync());
    }
    await lifetime.disposeAsync();
});
