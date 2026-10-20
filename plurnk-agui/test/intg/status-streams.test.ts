// {§agui-status-streams} {§agui-snapshot} — a worker's open executions through the official client. The model holds two
// commands open, one that has written and one that never has. A client attached before them and a fresh one attached
// while they are silent hold both in the gauge, every channel included; a client of another worker holds none. However
// they end, by exiting, exiting nonzero or the loop's cancellation, each client's census empties as their conclusions
// arrive, and a client attaching afterward is given an explicit empty one. Real core, real subprocesses, stock HttpAgent.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import type { ApplicationStream, LogEntryWire } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

class Observer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run(input); }
}

interface Conclusion { readonly entryId: number; readonly result: { readonly status: number; readonly exitCode?: number } }

const until = async (what: string, predicate: () => boolean, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// The census as the official client's state carries it, and the stream activity its events carry.
const watch = () => {
    let streams: ApplicationStream[] | null = null;
    let written = false;
    const conclusions: Conclusion[] = [];
    const census = (state: unknown): ApplicationStream[] | undefined =>
        (state as { plurnk?: { status?: { streams?: ApplicationStream[] } } }).plurnk?.status?.streams;
    return {
        streams: () => streams,
        written: () => written,
        conclusions: () => conclusions,
        subscriber: {
            onStateSnapshotEvent: ({ event }: { event: { snapshot: unknown } }) => { streams = census(event.snapshot) ?? null; },
            onStateDeltaEvent: ({ event }: { event: { delta: unknown } }) => {
                for (const op of event.delta as Array<{ path: string; value?: unknown }>) {
                    if (op.path === "/plurnk/status") streams = (op.value as { streams?: ApplicationStream[] }).streams ?? null;
                    if (op.path === "/plurnk/status/streams") streams = op.value as ApplicationStream[];
                }
            },
            onCustomEvent: ({ event }: { event: { name: string; value: unknown } }) => {
                if (event.name !== "plurnk.stream") return;
                const value = event.value as { channel?: string; contentLength?: number; result?: Conclusion["result"]; entryId: number };
                if (value.channel === "stdout" && (value.contentLength ?? 0) > 0) written = true;
                if (value.result !== undefined) conclusions.push({ entryId: value.entryId, result: value.result });
            },
        },
    };
};

for (const ending of ["exits", "exits nonzero", "is cancelled"] as const) {
    test(`{§agui-status-streams} a worker's open streams reach every client of it until each ${ending}`, { timeout: 90_000 }, async (t) => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { serverProposals }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")), import(join(SERVICE, "test/intg/_approval.ts")),
        ]);
        serverProposals(t, "accept");
        const dir = await mkdtemp(join(tmpdir(), "status-streams-"));
        const release = join(dir, "release");
        const hold = `while [ ! -e ${release} ]; do sleep 0.05; done; exit ${ending === "exits nonzero" ? 3 : 0}`;
        const provider = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse(`\`\`\`\`sh\nprintf 'live stdout\\n'; ${hold}\n\`\`\`\`\n\n\`\`\`\`sh\n${hold}\n\`\`\`\`\n\n\`\`\`\`WAIT [60]\nWaiting on both.\n\`\`\`\``),
            makeMockResponse("````SEND [200]\nDone.\n````"),
        ] });
        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({ db, http, nodeModulesPath: join(SERVICE, "node_modules"), provider });
        const agents: HttpAgent[] = [];
        t.after(async () => {
            await writeFile(release, "");
            for (const agent of agents) agent.abortRun();
            await daemon.stop();
            await http.close();
            await db.close();
            await rm(dir, { recursive: true, force: true });
        });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "streams" });
        const { workerId } = await daemon.createWorker({ workspaceId, name: "main" });
        await daemon.createWorker({ workspaceId, name: "bystander" });
        const { host, port } = http.httpAddress();
        const observe = async (threadId: string) => {
            const agent = new Observer({ url: `http://${host}:${port}/agui/connect`, threadId });
            agents.push(agent);
            const watched = watch();
            void agent.connectAgent({ forwardedProps: { plurnk: { workspace: "streams" } } }, watched.subscriber);
            await until(`${threadId}'s snapshot`, () => watched.streams() !== null);
            return watched;
        };

        const before = await observe("main");
        assert.deepEqual(before.streams(), [], "nothing is open yet, and the census says so");
        await daemon.runLoop({ workspaceId, workerId, prompt: "Hold two commands open." });
        await until("both streams on the connected client's gauge, the first one written", () => before.streams()?.length === 2 && before.written());

        const fresh = await observe("main");
        const streams = fresh.streams()!;
        assert.deepEqual(streams, before.streams(), "a client attaching while they are silent holds what a connected one does");
        const rows = (await daemon.readLog({ workspaceId, workerId }) as LogEntryWire[]).filter(({ op }) => op === "sh");
        for (const stream of streams) {
            assert.match(stream.target, /^sh:\/\/\/[0-9a-f]{8}$/u);
            assert.equal(stream.workerId, workerId);
            assert.equal(stream.lifetime, "loop");
            const opened = rows.find(({ attrs }) => (attrs as { stream?: string } | null)?.stream === stream.target);
            assert.ok(opened, "a row announced each one");
            assert.deepEqual([stream.loop_seq, stream.turn_seq, stream.sequence], [opened.loop_seq, opened.turn_seq, opened.sequence]);
            assert.deepEqual(stream.channels.map(({ channel, state }) => ({ channel, state })),
                [{ channel: "stderr", state: "active" }, { channel: "stdout", state: "active" }], "every channel, written or not");
        }
        const bystander = await observe("bystander");
        assert.deepEqual(bystander.streams(), [], "another worker's client holds none of them");

        if (ending === "is cancelled") assert.equal(daemon.cancelDrain(workerId), true, "Stop cancels the worker's loop");
        else await writeFile(release, "");
        await until("each client's census to empty", () => before.streams()?.length === 0 && fresh.streams()?.length === 0);
        for (const [name, client] of [["the connected client", before], ["the fresh client", fresh]] as const) {
            assert.deepEqual(client.conclusions().map(({ entryId }) => entryId).toSorted((a, b) => a - b),
                streams.map(({ entryId }) => entryId).toSorted((a, b) => a - b), `${name} heard each conclusion`);
            for (const { result } of client.conclusions()) {
                if (ending === "is cancelled") assert.equal(result.status, 499, `${name}: a cancellation is no exit`);
                else assert.equal(result.exitCode, ending === "exits" ? 0 : 3, `${name}: the exit as the command made it`);
            }
        }
        assert.deepEqual(bystander.streams(), [], "and the bystander's census never moved");
        const after = await observe("main");
        assert.deepEqual(after.streams(), [], "a client attaching afterward is told none is open");
    });
}
