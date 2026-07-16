// [§methods-loop-run-model] — #414 per-loop model resolution precedence + parse contract.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveLoopAlias } from "./loop-model.ts";
import type { ProviderAlias } from "@plurnk/plurnk-providers";

const DECLARED: ProviderAlias[] = [
    { alias: "fireslow", provider: "fireworks", model: "deepseek-v4" },
    { alias: "local", provider: "openai", model: "gemma", baseUrl: "http://127.0.0.1:11435" },
];

test("[§methods-loop-run-model] neither alias nor model → null (the daemon's boot default)", () => {
    assert.equal(resolveLoopAlias(undefined, undefined, DECLARED), null);
    assert.equal(resolveLoopAlias("", "", DECLARED), null);
});

test("[§methods-loop-run-model] model wins over alias — the client-resolved spec is authoritative (#90)", () => {
    const r = resolveLoopAlias("fireslow", "anthropic/claude-opus", DECLARED);
    assert.deepEqual(r, { alias: "fireslow", provider: "anthropic", model: "claude-opus" }, "the alias name rides along but the model spec decides the provider+model");
});

test("[§methods-loop-run-model] a bare model spec synthesizes its own alias name", () => {
    assert.deepEqual(resolveLoopAlias(undefined, "openrouter/qwen/qwen3-coder", DECLARED),
        { alias: "openrouter/qwen/qwen3-coder", provider: "openrouter", model: "qwen/qwen3-coder" },
        "the model id keeps its inner slashes; only the first splits provider");
});

test("[§methods-loop-run-model] a named alias resolves from the declared cascade, case-folded", () => {
    assert.deepEqual(resolveLoopAlias("FIRESLOW", undefined, DECLARED), DECLARED[0], "alias lookup is case-insensitive");
    assert.deepEqual(resolveLoopAlias("local", undefined, DECLARED), DECLARED[1], "the baseUrl override rides through");
});

test("[§methods-loop-run-model] a malformed model spec throws legibly", () => {
    assert.throws(() => resolveLoopAlias(undefined, "no-slash", DECLARED), /<provider>\/<model>/);
    assert.throws(() => resolveLoopAlias(undefined, "/leading", DECLARED), /<provider>\/<model>/);
});

test("[§methods-loop-run-model] an undeclared alias throws — never a silent wrong-model worker", () => {
    assert.throws(() => resolveLoopAlias("ghost", undefined, DECLARED), /not declared/);
});
