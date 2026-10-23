// {§agui-place-hiding} — through the official HttpAgent against the real daemon: hiding a worker or a workspace takes it
// out of the directories and out of a connected overview, the directories include it again when asked, and showing it
// brings it back.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

// HttpAgent leaves AbstractAgent's connect() to its subclasses: a standing observer is the official client's own run
// pipeline pointed at /agui/connect.
class Observer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run(input); }
}

interface OverviewState { workspaces: Record<string, { name: string }>; workers: Record<string, { name: string }> }
const overviewOf = (agent: HttpAgent): OverviewState | undefined => (agent.state as { plurnk?: { overview?: OverviewState } }).plurnk?.overview;

const byName = ([a]: [string, boolean], [b]: [string, boolean]): number => a.localeCompare(b);

const until = async (what: string, ready: () => boolean): Promise<void> => {
    for (const deadline = Date.now() + 20_000; !ready();) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

test("{§agui-place-hiding} {§agui-overview-updates} the official client hides a worker and a workspace out of the directories and a connected overview, and shows them again", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules") });
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/agui`;

    const places = await daemon.createWorkspace({ name: "places" });
    const elsewhere = await daemon.createWorkspace({ name: "elsewhere" });
    const kept = await daemon.createWorker({ workspaceId: places.workspaceId, name: "kept" });
    const gone = await daemon.createWorker({ workspaceId: places.workspaceId, name: "gone" });
    const far = await daemon.createWorker({ workspaceId: elsewhere.workspaceId, name: "far" });

    const act = async (workspace: string, kind: string, params: Record<string, unknown> = {}) => {
        const agent = new HttpAgent({ url, threadId: "operator" });
        const { result } = await agent.runAgent({ forwardedProps: { plurnk: { workspace, action: { kind, ...params } } } });
        const outcome = result as { ok: boolean; result: Record<string, unknown> };
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        return outcome.result;
    };
    const workers = async (params: Record<string, unknown> = {}) =>
        ((await act("places", "workspace.workers", params)).workers as Array<{ name: string; hidden_at: string | null }>)
            .filter(({ name }) => name === "kept" || name === "gone").map(({ name, hidden_at }): [string, boolean] => [name, hidden_at !== null]).toSorted(byName);
    const workspaces = async (params: Record<string, unknown> = {}) =>
        ((await act("places", "workspace.list", params)).workspaces as Array<{ name: string; hidden_at: string | null }>)
            .map(({ name, hidden_at }): [string, boolean] => [name, hidden_at !== null]).toSorted(byName);

    const observer = new Observer({ url: `${url}/connect`, threadId: "overview" });
    t.after(() => observer.abortRun());
    void observer.connectAgent({ forwardedProps: { plurnk: { overview: {} } } }).catch(() => undefined);
    const held = (id: number) => overviewOf(observer)?.workers[String(id)] !== undefined;
    await until("the overview's places", () => held(kept.workerId) && held(gone.workerId) && held(far.workerId));

    const hiddenWorker = await act("places", "worker.hidden.set", { hidden: true, workerId: gone.workerId });
    assert.deepEqual(hiddenWorker.workerIds, [gone.workerId]);
    await until("the hidden worker leaving the overview", () => !held(gone.workerId));
    assert.deepEqual(await workers(), [["kept", false]], "the directory leaves the hidden worker out");
    assert.deepEqual(await workers({ includeHidden: true }), [["gone", true], ["kept", false]], "and includes it, marked, when asked");

    await act("elsewhere", "workspace.hidden.set", { hidden: true });
    await until("the hidden workspace leaving the overview", () => !held(far.workerId) && overviewOf(observer)?.workspaces[String(elsewhere.workspaceId)] === undefined);
    assert.deepEqual(await workspaces(), [["places", false]]);
    assert.deepEqual(await workspaces({ includeHidden: true }), [["elsewhere", true], ["places", false]]);

    await act("places", "worker.hidden.set", { hidden: false, workerId: gone.workerId });
    await act("elsewhere", "workspace.hidden.set", { hidden: false });
    await until("both coming back", () => held(gone.workerId) && held(far.workerId));
    assert.deepEqual(await workers(), [["gone", false], ["kept", false]]);
    assert.deepEqual(await workspaces(), [["elsewhere", false], ["places", false]]);
});
