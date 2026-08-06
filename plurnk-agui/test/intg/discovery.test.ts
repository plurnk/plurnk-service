import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Module from "../../src/Module.ts";
import type { DaemonSeam } from "../../src/DaemonSeam.ts";
import { Validator, type ClientDisplayCapabilities } from "@plurnk/plurnk-contracts";
import { openTestDatabase, SERVICE } from "./_helpers.ts";

test("discover composes installed scheme and MIME display metadata through the real daemon seam", async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules") });
    const started = Promise.withResolvers<Module>();
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({
        start: async (seam: DaemonSeam) => {
            const module = await registration.start(seam);
            started.resolve(module);
            return module;
        },
    });
    try {
        await daemon.start();
        const module = await started.promise;
        const { host, port } = module.address();
        const response = await fetch(`http://${host}:${port}/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "display-discovery",
                runId: "display-discovery-run",
                state: {},
                messages: [],
                tools: [],
                context: [],
                forwardedProps: { plurnk: { action: { kind: "discover" } } },
            }),
        });
        assert.equal(response.status, 200);
        const frames = (await response.text())
            .split("\n\n")
            .filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
        const event = frames.find((frame) => frame.type === "CUSTOM" && frame.name === "plurnk.action.result") as {
            value: { ok: boolean; result: { display: ClientDisplayCapabilities } };
        } | undefined;
        assert.equal(event?.value.ok, true);
        const display = Validator.assertClientDisplayCapabilities(event?.value.result.display ?? []);
        assert.deepEqual(
            display.find((capability) => capability.kind === "scheme" && capability.scheme === "http"),
            { kind: "scheme", scheme: "http", display: { glyph: "🌐" } },
        );
        assert.deepEqual(
            display.find((capability) => capability.kind === "scheme" && capability.scheme === "sqlite"),
            { kind: "scheme", scheme: "sqlite", display: { glyph: "🗃" } },
        );
        assert.deepEqual(
            display.find((capability) => capability.kind === "mimetype" && capability.mimetype === "text/html"),
            { kind: "mimetype", mimetype: "text/html", display: { glyph: "🌐" } },
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});
