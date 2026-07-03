// #235 — discover carries a `versions` block for the client's update notifier:
// service.installed (the daemon's honest package.json self-report) + best-effort npm
// `latest` for service & client. The poll is cached + best-effort; here we suppress it
// (a huge TTL) to assert the deterministic self-report without a network round-trip — the
// `latest` half is best-effort by contract (omitted offline) and not asserted.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

test("[§discovery-versions] discover advertises the daemon's installed version (npm latest best-effort) (#235)", async () => {
    const prev = process.env.PLURNK_SERVICE_VERSION_POLL_TTL;
    process.env.PLURNK_SERVICE_VERSION_POLL_TTL = "999999999999999"; // suppress the background poll for a hermetic assertion
    try {
        const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:ok:SEND", 50)] });
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const resp = await rpcCall(ws, 1, "discover", {});
                const r = resp.result as { protocolVersion?: string; versions?: { service?: { installed?: string }; client?: object } };
                assert.ok(typeof r.protocolVersion === "string", "the existing protocol version still rides discover");
                assert.ok(r.versions !== undefined, "discover carries a versions block");
                assert.match(r.versions!.service!.installed ?? "", /^\d+\.\d+\.\d+/, "service.installed is the daemon's semver self-report");
                assert.ok("client" in r.versions!, "versions.client is present (its latest is best-effort, omitted offline)");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_VERSION_POLL_TTL; else process.env.PLURNK_SERVICE_VERSION_POLL_TTL = prev;
    }
});
