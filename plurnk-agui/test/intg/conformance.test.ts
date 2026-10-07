// {§agui-official-client-conformance} Optional real-model counterpart of the
// deterministic official-client gate in conformance-fixture.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";
const gated = (process.env.PLURNK_MODEL ?? "") === "" || (process.env.PLURNK_PROVIDERS_FETCH_TIMEOUT ?? "") === "";

test("the official @ag-ui/client accepts the full stream (create-ag-ui-app conformance)", { skip: gated, timeout: 180_000 }, async () => {
    await import(join(SERVICE, "test/floor.ts"));
    const { liveProvider } = await import(join(SERVICE, "test/_live-harness.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { HttpAgent } = await import("@ag-ui/client");

    const db = await openTestDatabase();
    const provider = await liveProvider();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules"), http });
    await daemon.start();
    const addr = http.httpAddress();
    assert.ok(addr !== undefined);
    const sandbox = await mkdtemp(join(tmpdir(), "agui-conf-"));

    try {
        const agent = new HttpAgent({ url: `http://${addr.host}:${addr.port}/agui`, threadId: "conformance" });
        agent.messages = [{ id: "m1", role: "user", content: "Reply with exactly one short sentence: say pong." }];
        const seen = new Set<string>();
        await agent.runAgent({ forwardedProps: { plurnk: { workspace: "conformance", projectRoot: sandbox, policy: { proposals: "accept" }, maxTurns: 6 } } }, {
            onEvent: ({ event }: { event: { type: string } }) => { seen.add(event.type); },
        });
        // Their verifier throwing = rejection; reaching here = the stream validated.
        assert.ok(seen.has("RUN_FINISHED"), "the worker completed through their client");
        assert.ok(seen.has("TEXT_MESSAGE_CONTENT"), "assistant speech flowed through their parser");
        const last = agent.messages.findLast(({ role }) => role === "assistant");
        assert.ok(last, "their message-builder assembled the reply alongside plan activity");
        assert.match(String(last.content ?? ""), /pong/i, "the reply answers the prompt");
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(sandbox, { recursive: true, force: true });
    }
});
