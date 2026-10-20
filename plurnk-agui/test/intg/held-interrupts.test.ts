// {§agui-held-interrupts} {§agui-proposal-resolve} — two views of one worker on the real daemon. The official HttpAgent
// holds its interrupt on a connection while its person decides; another view answers, or the loop is cancelled, and the held
// connection finishes, clearing the official client's pending interrupts; the gate settles once and a late answer of the
// held interrupt is refused. One another view answered before its client connected again finishes that connection at once.
// Simultaneous answers settle the gate once.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

// The official client reattaches by running with nothing new ({§agui-owner-connection}).
class Viewer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run(input); }
}

interface Frame {
    type: string;
    outcome?: { type: string; interrupts?: Array<{ id: string }> };
    metadata?: { plurnk?: { problem?: { status: number } } };
}
const frames = (body: string): Frame[] => body.split("\n\n")
    .filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as Frame);

const until = async (what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// A daemon whose model runs one shell command, which its owner reviews, then answers; the owner's thread is `operator`.
const boot = async (t: TestContext, workspace: string, command = "echo held-once") => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, nodeModulesPath: join(SERVICE, "node_modules"), provider: new Mock({ contextWindow: 32768, responses: [
        makeMockResponse(`\`\`\`\`sh\n${command}\n\`\`\`\``), makeMockResponse("````SEND [200]\nDone.\n````"),
    ] }) });
    const agents: HttpAgent[] = [];
    const cancellation = new AbortController();
    t.after(async () => {
        cancellation.abort();
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/agui`;
    const forwardedProps = { plurnk: { workspace, control: true, interactive: true } };
    const post = async (path: string, input: Record<string, unknown> = {}): Promise<Frame[]> => frames(await (await fetch(`${url}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: cancellation.signal,
        body: JSON.stringify({ threadId: "operator", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], forwardedProps, ...input }),
    })).text());
    const viewer = (): Viewer => { const made = new Viewer({ url, threadId: "operator" }); agents.push(made); return made; };
    // How the shell command's gate settled: its row's status, below 400 once it ran.
    const settled = async (): Promise<number> => {
        const [{ id: workspaceId }] = await daemon.listWorkspaces();
        const { id: workerId } = await daemon.readWorker({ workspaceId, identity: { name: "operator" } });
        const rows = (await daemon.readLog({ workspaceId, workerId })).filter(({ op }: { op: string }) => op === "sh");
        assert.equal(rows.length, 1, "one operation, one row");
        return (rows[0] as { status_rx: number }).status_rx;
    };
    return { daemon, url, forwardedProps, post, viewer, settled };
};

const accept = (interruptId: string) => ({ resume: [{ interruptId, status: "resolved", payload: { decision: "accept" } }] });

for (const settledBy of ["another view's answer", "the loop's cancellation"] as const) {
    test(`{§agui-held-interrupts}: the official client holding its interrupt on a connection converges when ${settledBy} settles it`, { timeout: 60_000 }, async (t) => {
        const { daemon, forwardedProps, post, viewer, settled } = await boot(t, `held-${settledBy === "another view's answer" ? "answer" : "cancel"}`);
        const holder = viewer();
        holder.messages = [{ id: "m1", role: "user", content: "Run the shell command." }];
        await holder.runAgent({ forwardedProps });
        const [held] = holder.pendingInterrupts;
        assert.ok(held !== undefined, "the gate ends the message Run with its interrupt");

        // A second view of the worker is presented the same gate under its own id.
        const presented = (await post("/connect")).at(-1);
        assert.equal(presented?.outcome?.type, "interrupt");
        const other = presented?.outcome?.interrupts?.[0];
        assert.ok(other !== undefined && other.id !== held.id);

        // The first view's client connects again, holding its interrupt while its person decides.
        let snapshot = false;
        let finished: string | undefined;
        const holding = holder.connectAgent({ forwardedProps: { plurnk: { ...forwardedProps.plurnk, interrupts: holder.pendingInterrupts.map(({ id }) => id) } } }, {
            onMessagesSnapshotEvent: () => { snapshot = true; },
            onRunFinishedEvent: ({ event }) => { finished = event.outcome?.type; },
        });
        await until("the held connection's snapshot", () => snapshot);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(finished, undefined, "the held connection stays open: the gate is not presented again");

        if (settledBy === "another view's answer") {
            const answered = await post("", accept(other.id));
            assert.equal(answered.at(-1)?.outcome?.type, "success", "the answering view follows the work to its end");
        } else {
            const [{ id: workspaceId }] = await daemon.listWorkspaces();
            const { id: workerId } = await daemon.readWorker({ workspaceId, identity: { name: "operator" } });
            await daemon.cancelWorker({ workspaceId, workerId });
        }
        await holding;
        assert.equal(finished, "success", "the held connection finishes when its gate settles, however it settled");
        assert.deepEqual(holder.pendingInterrupts, [], "and the official client's pending interrupts are clear");
        const status = await settled();
        assert.equal(status < 400, settledBy === "another view's answer", `the gate settled once, as ${settledBy} settled it (${status})`);

        const late = (await post("", accept(held.id))).at(-1);
        assert.deepEqual([late?.type, late?.metadata?.plurnk?.problem?.status], ["RUN_ERROR", 409], "a late answer of the held interrupt is refused");
        assert.equal(await settled(), status, "and settles nothing");
    });
}

// The ordering a view that holds its review can meet: another view answers between the gate's presentation and this client's
// connecting again, through either reattachment ({§agui-owner-connection}), whether the work that answer let go has ended by
// then or still runs.
for (const reattach of ["running with nothing new", "the connect endpoint"] as const) for (const work of ["has ended", "still runs"] as const) {
    test(`{§agui-held-interrupts}: an interrupt another view settled before its client reattached by ${reattach} finishes that Run at once, while the work ${work}`, { timeout: 60_000 }, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "held-settled-"));
        const release = join(dir, "release");
        t.after(async () => { await writeFile(release, ""); await rm(dir, { recursive: true, force: true }); });
        const command = work === "still runs" ? `while [ ! -e ${release} ]; do sleep 0.05; done; echo held-once` : "echo held-once";
        const { daemon, url, forwardedProps, post, viewer, settled } = await boot(t, `held-before-${reattach === "the connect endpoint" ? "connect" : "run"}-${work === "has ended" ? "ended" : "running"}`, command);
        const holder = viewer();
        holder.messages = [{ id: "m1", role: "user", content: "Run the shell command." }];
        await holder.runAgent({ forwardedProps });
        const [held] = holder.pendingInterrupts;
        assert.ok(held !== undefined, "the gate ends the message Run with its interrupt");

        const other = (await post("/connect")).at(-1)?.outcome?.interrupts?.[0];
        assert.ok(other !== undefined && other.id !== held.id, "a second view is presented the same gate under its own id");
        const answered = post("", accept(other.id));
        const [{ id: workspaceId }] = await daemon.listWorkspaces();
        const { id: workerId } = await daemon.readWorker({ workspaceId, identity: { name: "operator" } });
        if (work === "has ended") assert.equal((await answered).at(-1)?.outcome?.type, "success", "the answering view follows the work to its end");
        else await until("the accepted command to run", async () => (await daemon.readStreams({ workspaceId, workerId })).length > 0);
        assert.deepEqual(await daemon.pendingProposals(workspaceId), [], "the gate settled before its holder connects again");

        let finished: string | undefined;
        if (reattach === "the connect endpoint") holder.url = `${url}/connect`;
        const holding = holder.connectAgent({ forwardedProps: { plurnk: { ...forwardedProps.plurnk, interrupts: [held.id] } } }, {
            onRunFinishedEvent: ({ event }) => { finished = event.outcome?.type; },
        });
        await until("the holding connection to finish", () => finished !== undefined);
        await holding;
        assert.equal(finished, "success", "the Run finishes as at a settlement, presenting nothing");
        assert.deepEqual(holder.pendingInterrupts, [], "and the official client's pending interrupts are clear");
        if (work === "still runs") {
            assert.equal((await daemon.readStreams({ workspaceId, workerId })).length, 1, "while the work it let go still runs");
            await writeFile(release, "");
            assert.equal((await answered).at(-1)?.outcome?.type, "success", "which the answering view follows to its end");
        }
        assert.ok(await settled() < 400, "the gate settled once, by the other view's answer");
    });
}

test("{§agui-held-interrupts} {§agui-proposal-resolve}: two views answering at once settle the gate once; the other answer is refused", { timeout: 60_000 }, async (t) => {
    const { post, settled } = await boot(t, "held-race");
    const first = (await post("", { messages: [{ id: "m1", role: "user", content: "Run the shell command." }] })).at(-1)?.outcome?.interrupts?.[0];
    const second = (await post("/connect")).at(-1)?.outcome?.interrupts?.[0];
    assert.ok(first !== undefined && second !== undefined && first.id !== second.id, "two presentations of one gate");
    const ends = (await Promise.all([first, second].map(async ({ id }) => (await post("", accept(id))).at(-1))))
        .map((end) => end?.type === "RUN_ERROR" ? end.metadata?.plurnk?.problem?.status : end?.outcome?.type);
    assert.deepEqual(ends.toSorted((left, right) => String(left).localeCompare(String(right))), [409, "success"],
        "one answer settles the gate and follows its work; the other is refused");
    assert.ok(await settled() < 400, "the accepted command ran");
});
