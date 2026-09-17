// {§client-metadata} — the workspace's self-identified client id (the originating frontend, e.g.
// "@plurnk/plurnk-tui/1.4.0") is stored with the workspace and validated on write. It reaches no
// provider: the retired first-party endpoint was its only consumer (#697). The attribution sibling
// lives in attribution.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, withDaemon, rpcCall, rpcProblem, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// Run a loop against a provider whose generate() is shadowed, with the workspace created carrying
// settings.client, and report whether any `client` field reached the provider call.
const captureClient = async (clientId: string | null): Promise<string | undefined> => {
    const mock = new Mock({ contextWindow: 100000, responses: [makeMockResponse("```SEND\ndone\n```", 5)] });
    let captured: string | undefined;
    let seen = false;
    const real = mock.generate.bind(mock);
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

test("a stored client id never reaches the provider call", async () => {
    assert.equal(await captureClient("@plurnk/plurnk-tui/1.4.0"), undefined, "the client id stays inside the daemon");
});

test("workspace.create refuses an empty client id", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "workspace.create", { name: "bad-client", settings: { client: "" } });
            const problem = rpcProblem(r);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(problem.field, "settings.client");
            assert.equal(problem.recovery, "Provide the client identifier.");
        } finally { ws.close(); }
    });
});
