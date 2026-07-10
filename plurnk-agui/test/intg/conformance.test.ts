// The standard's own client as the conformance gate (plurnk-agui#2 WS-5): HttpAgent
// from @ag-ui/client — the exact engine under `npx create-ag-ui-app` frontends —
// drives a REAL model run against the in-process module. Their verifier validates
// every event; a spec drift is THEIR rejection, not our opinion. Env-gated like the
// go-live smoke; devDep only (the runtime stays family-internal, §agui-zero-dep).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Module from "../../src/Module.ts";
import type { DaemonSeam } from "../../src/DaemonSeam.ts";

const SERVICE = resolve(import.meta.dirname, "../../../plurnk-service");
const gated = (process.env.PLURNK_MODEL ?? "") === "" || (process.env.PLURNK_PROVIDERS_FETCH_TIMEOUT ?? "") === "";

test("[§agui-projection][§agui-run-endpoint] the official @ag-ui/client accepts the full stream (create-ag-ui-app conformance)", { skip: gated, timeout: 180_000 }, async () => {
    const { openMigrated } = await import(join(SERVICE, "test/intg/_helpers.ts"));
    const { liveProvider } = await import(join(SERVICE, "test/_live-harness.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { HttpAgent } = await import("@ag-ui/client");

    const db = await openMigrated();
    const provider = await liveProvider();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    let module: Module | null = null;
    daemon.registerModule(async (seam: DaemonSeam) => {
        module = await Module.init({ host: "127.0.0.1", port: 0, sessionPrefix: "agui" })(seam);
    });
    await daemon.start({ host: "127.0.0.1", port: 0 });
    const addr = (module as Module | null)?.address();
    assert.ok(addr !== undefined);
    const sandbox = await mkdtemp(join(tmpdir(), "agui-conf-"));

    try {
        const agent = new HttpAgent({ url: `http://${addr.host}:${addr.port}/`, threadId: "conformance" });
        agent.messages = [{ id: "m1", role: "user", content: "Reply with exactly one short sentence: say pong." }];
        const seen = new Set<string>();
        await agent.runAgent({ forwardedProps: { plurnk: { projectRoot: sandbox, flags: { yolo: true }, maxTurns: 6 } } }, {
            onEvent: ({ event }: { event: { type: string } }) => { seen.add(event.type); },
        });
        // Their verifier throwing = rejection; reaching here = the stream validated.
        assert.ok(seen.has("RUN_FINISHED"), "the run completed through their client");
        assert.ok(seen.has("TEXT_MESSAGE_CONTENT"), "assistant speech flowed through their parser");
        const last = agent.messages.at(-1) as { role: string; content?: string };
        assert.equal(last.role, "assistant", "their message-builder assembled the reply");
        assert.match(String(last.content ?? ""), /pong/i, "the reply answers the prompt");
    } finally {
        await (module as Module | null)?.close();
        await daemon.stop();
        await db.close();
        await rm(sandbox, { recursive: true, force: true });
    }
});
