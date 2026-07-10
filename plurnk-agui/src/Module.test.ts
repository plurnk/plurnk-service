// The module's HTTP surface against a mock seam (no daemon): §3 action runs execute
// via the seam and finish clean; unknown kinds error honestly; a resume tool-result
// resolves without driving a loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "./Module.ts";
import type { DaemonSeam, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";

const mockSeam = () => {
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const seam: DaemonSeam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => [],
        resolveProposal: (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            // The engine's continued loop terminating — closes the resume stream.
            setImmediate(() => handlers.forEach((h) => h(3, "loop/terminated", { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costPico: 0, contextTokens: 2, contextSize: 1000, meta: {} } })));
        },
        runLoop: async () => ({ action: "injected_next_turn", loopId: 9, turnSeq: 2 }),
        cancelDrain: () => true,
        dispatchAsClient: async () => ({ status: 200 }),
        readLog: async () => [{ id: 1, op: "SEND", origin: "model" }],
        listProviders: () => ({ aliases: [{ alias: "opus", provider: "anthropic", model: "claude", active: true, contextSize: 200000 }] }),
        createSession: async () => ({ sessionId: 3, sessionName: "agui-t", projectRoot: null, runId: 10, runName: "client-1", modelRunId: null, clientLoopId: null }),
        attachSession: async () => { throw new Error("unexpected attach"); },
        listSessions: async () => [],
        listRuns: async () => [{ id: 10, name: "client-1" }],
        ensureModelRun: async () => 20,
        listPrompts: async () => ["hi"],
        renameSession: async (_id, name) => ({ id: 3, name }),
        constrain: async (_id, effect, glob) => ({ effect, glob }),
        unconstrain: async (_id, effect, glob) => ({ effect, glob }),
        listConstraints: async () => [{ effect: "pick", glob: "src/**" }],
        readEntry: async () => ({ status: 200, entry: { body: "x" } }),
        forkRun: async () => ({ runId: 11, runName: "fork-1", parentRunId: 10 }),
        listMembers: async () => ({ members: [{ path: "a.ts", effect: "member" }], hidden: [] }),
        look: async () => ({ status: 200, content: "looked" }),
    };
    return { seam, resolves };
};

const post = async (port: number, body: object): Promise<AguiEvent[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    const text = await res.text();
    return text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
};

test("[§agui-management-plane] an action run executes via the seam: result custom + RUN_FINISHED, no loop", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const events = await post(mod.address().port, { threadId: "t1", runId: "r1", forwardedProps: { plurnk: { action: { kind: "providers.list" } } } });
        const result = events.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { kind: string; ok: boolean; result: { aliases: Array<{ alias: string }> } } };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.aliases[0].alias, "opus");
        assert.equal(events[events.length - 1].type, "RUN_FINISHED", "action run finishes clean");
        // inject rides the same surface
        const inj = await post(mod.address().port, { threadId: "t1", runId: "r2", forwardedProps: { plurnk: { action: { kind: "loop.inject", prompt: "steer" } } } });
        const ack = inj.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { action: string } } };
        assert.equal(ack.value.result.action, "injected_next_turn", "inject folds into the active drain via the unified runLoop");
        // an unknown kind errors honestly
        const bad = await post(mod.address().port, { threadId: "t1", runId: "r3", forwardedProps: { plurnk: { action: { kind: "nope.nothing" } } } });
        const err = bad.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; error: string } };
        assert.equal(err.value.ok, false);
        assert.match(err.value.error, /unknown action kind/);
    } finally { await mod.close(); }
});

test("[§agui-proposal-resolve] a resume tool-result resolves the paused proposal without driving a loop", async () => {
    const { seam, resolves } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "t2", runId: "r1",
            messages: [
                { role: "assistant", content: "" },
                { role: "tool", toolCallId: "prop:42", content: JSON.stringify({ decision: "accept", body: "edited" }) },
            ],
        });
        assert.equal(events[0].type, "RUN_STARTED");
        assert.deepEqual(resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited" } }, "the tool-result reached resolveProposal");
    } finally { await mod.close(); }
});

test("PLURNK PARADIGM: the name IS the identity — no prefix, no forging, attach is real", async () => {
    const created: Array<{ name?: string }> = [];
    const attached: number[] = [];
    const { seam } = mockSeam();
    const base = seam.createSession.bind(seam);
    seam.createSession = async (args) => { created.push(args); return { ...(await base(args)), sessionName: args.name ?? "session-1" }; };
    seam.attachSession = async (args) => { attached.push(args.sessionId); return { sessionId: args.sessionId, sessionName: "alpha", projectRoot: null, runId: 10, runName: "client-1", modelRunId: 20, clientLoopId: null }; };
    seam.listSessions = async () => [{ id: 4, name: "alpha" }];
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // 1) A thread named like an existing session attaches to IT — the exact name.
        const run = await post(mod.address().port, { threadId: "alpha", runId: "r1", forwardedProps: { plurnk: { action: { kind: "ping" } } } });
        assert.equal(run[run.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(attached, [4], "thread 'alpha' attached session 'alpha' — no agui- prefix lookup");
        // 2) A new thread creates a session with EXACTLY its name.
        await post(mod.address().port, { threadId: "beta", runId: "r2", forwardedProps: { plurnk: { action: { kind: "ping" } } } });
        assert.deepEqual(created.map((c) => c.name), ["beta"], "created verbatim — never 'agui-beta', never a uuid");
        // 3) session.attach is a REAL action kind returning the envelope.
        const att = await post(mod.address().port, { threadId: "alpha", runId: "r3", forwardedProps: { plurnk: { action: { kind: "session.attach", id: 4 } } } });
        const result = att.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { id: number; name: string } } };
        assert.equal(result.value.ok, true, "session.attach is wired, not unknown-kind");
        assert.equal(result.value.result.name, "alpha");
    } finally { await mod.close(); }
});
