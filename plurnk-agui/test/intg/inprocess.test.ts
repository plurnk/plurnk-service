// THE go-live smoke (plurnk-agui#2): the in-process transport module, activated
// through the daemon's boot plug-point (registerModule → the CoreSeam handle), drives
// a REAL model run through the AG-UI+ single interface — no WebSocket, no bridge
// process, no DaemonClient. Gated on a configured model (~/.plurnk/.env via the env
// the runner loads); skips clean when absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Module from "../../src/Module.ts";
import type { DaemonSeam } from "../../src/DaemonSeam.ts";
import type { AguiEvent } from "../../src/types.ts";

const SERVICE = resolve(import.meta.dirname, "../../../plurnk-service");

// Needs a configured model AND the service's provider env (layer .env.example from
// plurnk-service + ~/.plurnk/.env — see the file header). Skips clean otherwise.
const gated = (process.env.PLURNK_MODEL ?? "") === "" || (process.env.PLURNK_PROVIDERS_FETCH_TIMEOUT ?? "") === "";

test("[§agui-daemon-client][§agui-run-endpoint][§agui-thread-is-session] in-process module: boot plug-point → AG-UI+ run → real model → SSE", { skip: gated, timeout: 180_000 }, async () => {
    const { openMigrated } = await import(join(SERVICE, "test/intg/_helpers.ts"));
    const { liveProvider } = await import(join(SERVICE, "test/_live-harness.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));

    const db = await openMigrated();
    const provider = await liveProvider();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    const sandbox = await mkdtemp(join(tmpdir(), "agui-inproc-"));

    // Hook D — the plug-point. The daemon hands the module its seam handle at boot;
    // the module opens its own listener. This IS the daughter-module activation.
    let module: Module | null = null;
    daemon.registerModule(async (seam: DaemonSeam) => {
        module = await Module.init({ host: "127.0.0.1", port: 0, sessionPrefix: "agui" })(seam);
    });
    await daemon.start({ host: "127.0.0.1", port: 0 });
    assert.ok(module !== null, "the plug-point activated the module at boot");
    const addr = (module as Module).address();

    try {
        const res = await fetch(`http://${addr.host}:${addr.port}/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "inproc-smoke",
                runId: "run-1",
                messages: [{ role: "user", content: "Reply with exactly one short sentence: say pong." }],
                forwardedProps: { plurnk: { projectRoot: sandbox, flags: { yolo: true }, maxTurns: 6 } },
            }),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

        const events: AguiEvent[] = [];
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
                const frame = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as AguiEvent);
            }
        }

        const types = events.map((e) => e.type);
        assert.equal(types[0], "RUN_STARTED", "the run opens");
        assert.equal(types[1], "STATE_SNAPSHOT", "reads ride STATE on connect (AG-UI+)");
        const snap = events[1] as { snapshot: { plurnk: { providers: Array<{ active: boolean }> } } };
        assert.ok(snap.snapshot.plurnk.providers.some((p) => p.active), "the active provider is in STATE");
        assert.ok(types.includes("TEXT_MESSAGE_CONTENT"), "the model's reply rendered as assistant speech");
        const speech = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => (e as { delta: string }).delta).join("");
        assert.match(speech, /pong/i, "the reply answers the prompt");
        assert.equal(types[types.length - 1], "RUN_FINISHED", "the run closes clean");
    } finally {
        await (module as Module | null)?.close();
        await daemon.stop();
        await db.close();
        await rm(sandbox, { recursive: true, force: true });
    }
});
