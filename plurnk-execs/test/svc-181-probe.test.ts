import test from "node:test";
import { strict as assert } from "node:assert";
import BaseExecutor from "../src/BaseExecutor.ts";
import SubprocessExecutor from "../src/SubprocessExecutor.ts";
import type { ChannelDecl, ExecArgs, ExecResult } from "../src/types.ts";

// plurnk-service#181 — probe() availability check. Asserts the agreed contract:
// {available, detail?}, default available, env-aware, may reject (consumer
// catches → unavailable), distinct from discover()'s package-installed.

class Bare extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> { return {}; }
    async run(_a: ExecArgs): Promise<ExecResult> { return { status: 200 }; }
}
class Bin extends SubprocessExecutor {
    #bin: string;
    constructor(bin: string) { super({ runtime: bin, glyph: "•" }); this.#bin = bin; }
    protected override get binary(): string { return this.#bin; }
}

test("C1: default probe is available (pure/in-process runtimes)", async () => {
    assert.deepEqual(await new Bare({ runtime: "x", glyph: "•" }).probe(), { available: true });
});

test("C2: an external binary present → available with version detail", async () => {
    const r = await new Bin("node").probe();
    assert.equal(r.available, true);
    assert.match(String(r.detail), /^v?\d+\./);
});

test("C3: a missing binary → unavailable with actionable, model-facing detail", async () => {
    const r = await new Bin("definitely-not-a-real-binary-xyz").probe();
    assert.equal(r.available, false);
    assert.match(String(r.detail), /not found on PATH/);
});

test("C4: probe returns a settled result for the expected miss (no throw needed)", async () => {
    await assert.doesNotReject(() => new Bin("definitely-not-a-real-binary-xyz").probe());
});
