import test from "node:test";
import { strict as assert } from "node:assert";
import SchemeResolver from "./resolveForLoop.ts";
import { DEFAULT_LOOP_FLAGS } from "./types.ts";
import type { LoopFlags, SchemeManifest } from "./types.ts";

const makeScheme = (name: string, manifest?: SchemeManifest) => {
    const klass = class {
        static manifest = manifest;
    };
    Object.defineProperty(klass, "name", { value: name });
    return new klass();
};

const baseManifest = (name: string, flags?: SchemeManifest["flags"]): SchemeManifest => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    scope: "session",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
    flags,
});

const handlers = (entries: Array<[string, object]>) => new Map(entries);

test("resolveForLoop: schemes without manifest.flags are always active", () => {
    const m = handlers([
        ["a", makeScheme("a", baseManifest("a"))],
        ["b", makeScheme("b", baseManifest("b"))],
    ]);
    const active = SchemeResolver.forLoop(m, DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...active].sort(), ["a", "b"]);
});

test("resolveForLoop: handler without static manifest is always active", () => {
    const m = handlers([
        ["bare", makeScheme("bare")],
    ]);
    const active = SchemeResolver.forLoop(m, DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...active], ["bare"]);
});

test("resolveForLoop: excludedInAsk filters in ask mode only", () => {
    const m = handlers([
        ["always", makeScheme("always", baseManifest("always"))],
        ["readonly_safe", makeScheme("readonly_safe", baseManifest("readonly_safe", { excludedInAsk: true }))],
    ]);
    const askFlags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, mode: "ask" };
    const askActive = SchemeResolver.forLoop(m, askFlags);
    assert.deepEqual([...askActive], ["always"]);
    const actActive = SchemeResolver.forLoop(m, DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...actActive].sort(), ["always", "readonly_safe"]);
});

test("resolveForLoop: requiresWeb filters under noWeb", () => {
    const m = handlers([
        ["http", makeScheme("http", baseManifest("http", { requiresWeb: true }))],
    ]);
    const flags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, noWeb: true };
    assert.deepEqual([...SchemeResolver.forLoop(m, flags)], []);
});

test("resolveForLoop: requiresInteraction filters under noInteraction", () => {
    const m = handlers([
        ["ask_user", makeScheme("ask_user", baseManifest("ask_user", { requiresInteraction: true }))],
    ]);
    const flags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, noInteraction: true };
    assert.deepEqual([...SchemeResolver.forLoop(m, flags)], []);
});

test("resolveForLoop: proposes filters under noProposals", () => {
    const m = handlers([
        ["exec", makeScheme("exec", baseManifest("exec", { proposes: true }))],
    ]);
    const flags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, noProposals: true };
    assert.deepEqual([...SchemeResolver.forLoop(m, flags)], []);
});
