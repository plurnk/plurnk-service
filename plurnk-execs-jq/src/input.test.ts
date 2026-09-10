import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Jq from "./Jq.ts";
import type { ExecInputReceiver } from "@plurnk/plurnk-execs";

test("{§executor-stdin}: jq receives SEND values and publishes results before EOF", { timeout: 5_000 }, async (t) => {
    const executor = new Jq({ runtime: "jq", glyph: "j" });
    const availability = await executor.probe();
    if (!availability.available) { t.skip(availability.detail); return; }
    const ready = Promise.withResolvers<void>();
    const output = Promise.withResolvers<void>();
    const controller = new AbortController();
    let receiver: ExecInputReceiver | undefined;
    let resultBody = "";
    const completion = executor.run({ runtime: "jq", body: ".value * 2", metadata: ["stdin=open"], cwd: null, target: null,
        signal: controller.signal, registerInput: (input) => { receiver = input; ready.resolve(); },
        write: (_channel, body) => { resultBody += body; if (resultBody.includes("42\n")) output.resolve(); },
        setState: () => {}, emit: () => {}, interact: async () => ({ status: "cancelled" }),
    });
    t.after(async () => { controller.abort(); await completion; });
    await ready.promise;
    assert.ok(receiver);
    assert.equal((await receiver({ body: '{"value":21}\n', metadata: null, signal: controller.signal })).status, 200);
    await output.promise;
    assert.equal(resultBody, "42\n");
    assert.equal((await receiver({ body: "", metadata: ["eof=true"], signal: controller.signal })).status, 200);
    assert.equal((await completion).status, 200);
});

test("{§executor-stdin}: jq processes a target file before subsequent live values", { timeout: 5_000 }, async (t) => {
    const executor = new Jq({ runtime: "jq", glyph: "j" });
    const availability = await executor.probe();
    if (!availability.available) { t.skip(availability.detail); return; }
    const directory = await mkdtemp(join(tmpdir(), "jq-input-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = join(directory, "values.json");
    await writeFile(target, '{"value":3}\n');
    const controller = new AbortController();
    const ready = Promise.withResolvers<ExecInputReceiver>();
    let output = "";
    const completion = executor.run({ runtime: "jq", body: ".value * 2", metadata: ["stdin=open"], cwd: directory, target,
        signal: controller.signal, registerInput: ready.resolve,
        write: (_channel, body) => { output += body; },
        setState: () => {}, emit: () => {}, interact: async () => ({ status: "cancelled" }),
    });
    t.after(async () => { controller.abort(); await completion; });
    const receiver = await ready.promise;
    const delivered = await receiver({ body: '{"value":21}\n', metadata: ["eof=true"], signal: controller.signal });
    assert.equal(delivered.status, 200);
    assert.equal((await completion).status, 200);
    assert.equal(output, "6\n42\n");
});
