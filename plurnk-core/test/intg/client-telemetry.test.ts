// {§client-metadata} — the workspace's self-identified client id (the originating frontend, e.g. "plurnk.nvim/1.4.0")
// is forwarded per turn on generate({ client }); only the plurnk provider emits it (Plurnk-Client).
// This proves the service half end-to-end: workspace.create persists it (validated), the engine reads
// it per turn and passes it to the provider call — omitted entirely when unset. The attribution
// sibling lives in attribution.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, withDaemon, rpcCall, rpcProblem, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// Run a loop against a provider whose generate() is shadowed to capture the `client` arg, with the
// workspace created carrying settings.client = clientId (or no client setting when null).
const captureClient = async (clientId: string | null): Promise<string | undefined> => {
    const mock = new Mock({ contextWindow: 100000, responses: [makeMockResponse("<<SEND[200]:done:SEND", 5)] });
    let captured: string | undefined;
    let seen = false;
    const real = mock.generate.bind(mock);
    // Mock's generate() param type omits `client` (narrower than the Provider interface); the engine
    // passes it at runtime — read it through a cast, same as attribution.test.ts does for attributions.
    mock.generate = (req) => { captured = (req as { client?: string }).client; seen = true; return real(req); };

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const settings = clientId !== null ? { client: clientId } : {};
            await rpcCall(ws, 1, "workspace.create", { name: `client-${clientId ?? "none"}`, settings });
            await runLoopToTerminal(ws, 2, { prompt: "go" });
        } finally { ws.close(); }
    });
    assert.ok(seen, "generate() was called");
    return captured;
};

test("the workspace's client id reaches generate()", async () => {
    assert.equal(await captureClient("plurnk.nvim/1.4.0"), "plurnk.nvim/1.4.0", "the workspace-stable client id reaches the provider wire");
});

test("no client setting → generate's client field is omitted (undefined), not empty", async () => {
    assert.equal(await captureClient(null), undefined, "a workspace without a client id sends no client field");
});

test("workspace.create refuses an empty client id", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "workspace.create", { name: "bad-client", settings: { client: "" } });
            const problem = rpcProblem(r);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/input/setting-invalid");
            assert.equal(problem.field, "settings.client");
            assert.equal(problem.recovery, "Provide the client identifier.");
        } finally { ws.close(); }
    });
});
