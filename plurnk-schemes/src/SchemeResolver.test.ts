import test from "node:test";
import { strict as assert } from "node:assert";
import SchemeResolver from "./SchemeResolver.ts";
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
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
    flags,
});

const handlers = (entries: Array<[string, object]>) => new Map(entries);

test("SchemeResolver.forLoop: schemes without manifest.flags are always active", () => {
    const m = handlers([
        ["a", makeScheme("a", baseManifest("a"))],
        ["b", makeScheme("b", baseManifest("b"))],
    ]);
    const active = SchemeResolver.forLoop(m, DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...active].sort(), ["a", "b"]);
});

test("SchemeResolver.forLoop: an instance manifest supports dynamically derived schemes", () => {
    const manifest = baseManifest("dynamic");
    const m = handlers([
        ["dynamic", { manifest }],
    ]);
    const active = SchemeResolver.forLoop(m, DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...active], ["dynamic"]);
});

test("SchemeResolver.forLoop: a handler without any manifest is rejected", () => {
    const m = handlers([["bare", {}]]);
    assert.throws(() => SchemeResolver.forLoop(m, DEFAULT_LOOP_FLAGS), /must declare a static or instance manifest/);
});

test("SchemeResolver.forLoop: excludedInAsk filters in ask mode only", () => {
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

test("SchemeResolver.forLoop: requiresWeb filters under noWeb", () => {
    const m = handlers([
        ["http", makeScheme("http", baseManifest("http", { requiresWeb: true }))],
    ]);
    const flags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, noWeb: true };
    assert.deepEqual([...SchemeResolver.forLoop(m, flags)], []);
});

test("SchemeResolver.forLoop: requiresInteraction filters under noInteraction", () => {
    const m = handlers([
        ["ask_user", makeScheme("ask_user", baseManifest("ask_user", { requiresInteraction: true }))],
    ]);
    const flags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, noInteraction: true };
    assert.deepEqual([...SchemeResolver.forLoop(m, flags)], []);
});

test("SchemeResolver.forLoop: noProposals does not change scheme affinity (#165)", () => {
    const m = handlers([
        ["http", makeScheme("http", baseManifest("http", { requiresWeb: true }))],
    ]);
    const flags: LoopFlags = { ...DEFAULT_LOOP_FLAGS, noProposals: true };
    assert.deepEqual([...SchemeResolver.forLoop(m, flags)], ["http"]);
});
