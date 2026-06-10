import test from "node:test";
import { strict as assert } from "node:assert";
import BaseExecutor from "../BaseExecutor.ts";
import SubprocessExecutor from "../SubprocessExecutor.ts";
import type { ChannelDecl, Effect, ExecArgs, ExecResult } from "../types.ts";

// plurnk-service#182 — effect() proposal gating. Asserts the agreed contract:
// pure + synchronous + cheap; classifies the TARGET only (never the command);
// conservative `host` default; subprocess always host.

class Bare extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> { return {}; }
    async run(_a: ExecArgs): Promise<ExecResult> { return { status: 200 }; }
}

test("C1: default effect is the conservative `host`, for any target", () => {
    const ex = new Bare({ runtime: "x", glyph: "•" });
    assert.equal(ex.effect(null), "host");
    assert.equal(ex.effect("/anything"), "host");
});

test("C2: effect() is synchronous (not a Promise) — it runs on the propose hot path", () => {
    const out: Effect = new Bare({ runtime: "x", glyph: "•" }).effect(null);
    assert.equal(typeof out, "string");
    assert.equal(out, "host");
});

test("C3: subprocess runtimes are always host (regardless of target)", () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.equal(ex.effect(null), "host");
    assert.equal(ex.effect("/work/dir"), "host");
});
