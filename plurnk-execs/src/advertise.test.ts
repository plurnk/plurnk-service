import test from "node:test";
import { strict as assert } from "node:assert";
import Advertise from "./advertise.ts";
import type { ExecInfo, ExecRegistry } from "./types.ts";

const info = (runtime: string): ExecInfo => ({
    runtime,
    glyph: "•",
    example: `<<EXEC[${runtime}]:…:EXEC`,
    documentation: "",
    packageName: `@plurnk/plurnk-execs-${runtime}`,
});

const registry = (...tags: string[]): ExecRegistry => new Map(tags.map((t) => [t, info(t)]));

test("contribute: zero permitted runtimes yields the single teaching notice, no runtime lines", () => {
    const { permitted, notice } = Advertise.contribute(registry("sh", "jq", "search"), () => false);
    assert.deepEqual(permitted, []);
    assert.equal(notice, "No EXEC operations permitted");
    assert.equal(notice, Advertise.NO_EXECS_NOTICE, "the notice is the framework's single source of truth");
});

test("contribute: any surviving runtime suppresses the notice — the sheet lists, it does not apologize", () => {
    const { permitted, notice } = Advertise.contribute(registry("sh", "jq", "search"), (t) => t === "search");
    assert.deepEqual(permitted.map((i) => i.runtime), ["search"]);
    assert.equal(notice, null);
});

test("contribute: one contributor, both cases — permitted and notice are mutually exclusive by construction", () => {
    const reg = registry("sh", "node");
    const full = Advertise.contribute(reg, () => true);
    assert.equal(full.notice, null, "a non-empty sheet never carries a notice");
    assert.equal(full.permitted.length, 2);
    const none = Advertise.contribute(reg, () => false);
    assert.ok(none.notice !== null && none.permitted.length === 0, "an empty sheet always carries the notice");
});

test("contribute: cause-agnostic — the same empty result whether policy or a host bar zeroed the set", () => {
    const reg = registry("sh", "node", "python");
    const policyZeroed = Advertise.contribute(reg, () => false);                        // e.g. PLURNK_EXECS_ONLY= (nothing)
    const hostBarred = Advertise.contribute(reg, () => false);                          // e.g. every tag is host-effect, barred
    assert.equal(policyZeroed.notice, hostBarred.notice, "the line does not encode which gate emptied the set");
});

test("contribute: the filter is the registry tag — a predicate keyed on runtime drives exactly which survive", () => {
    const kept = new Set(["sh", "jq"]);
    const { permitted, notice } = Advertise.contribute(registry("sh", "node", "jq", "search"), (t) => kept.has(t));
    assert.deepEqual(permitted.map((i) => i.runtime).sort(), ["jq", "sh"]);
    assert.equal(notice, null);
});
