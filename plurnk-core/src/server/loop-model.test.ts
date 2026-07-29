// [methods-loop-run-model] - #414 per-loop model resolution precedence + parse contract.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveLoopAlias } from "./loop-model.ts";
import type { ProviderAlias } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../core/results.ts";

const DECLARED: ProviderAlias[] = [
    { alias: "fireslow", provider: "fireworks", model: "deepseek-v4" },
    { alias: "local", provider: "openai", model: "gemma", baseUrl: "http://127.0.0.1:11435" },
];

const failureFrom = (run: () => unknown): OperationFailureError => {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof OperationFailureError);
        return error;
    }
    assert.fail("Expected operation failure.");
};

test("neither alias nor model -> null (the daemon's boot default)", () => {
    assert.equal(resolveLoopAlias(undefined, undefined, DECLARED), null);
    assert.equal(resolveLoopAlias("", "", DECLARED), null);
});

test("model wins over alias - the client-resolved spec is authoritative (#90)", () => {
    const r = resolveLoopAlias("fireslow", "anthropic/claude-opus", DECLARED);
    assert.deepEqual(r, { alias: "fireslow", provider: "anthropic", model: "claude-opus" }, "the alias name rides along but the model spec decides the provider+model");
});

test("a bare model spec synthesizes its own alias name", () => {
    assert.deepEqual(resolveLoopAlias(undefined, "openrouter/qwen/qwen3-coder", DECLARED),
        { alias: "openrouter/qwen/qwen3-coder", provider: "openrouter", model: "qwen/qwen3-coder" },
        "the model id keeps its inner slashes; only the first splits provider");
});

test("a named alias resolves from the declared cascade, case-folded", () => {
    assert.deepEqual(resolveLoopAlias("FIRESLOW", undefined, DECLARED), DECLARED[0], "alias lookup is case-insensitive");
    assert.deepEqual(resolveLoopAlias("local", undefined, DECLARED), DECLARED[1], "the baseUrl override rides through");
});

test("a malformed model spec throws legibly", () => {
    for (const model of ["no-slash", "/leading"]) {
        const { result } = failureFrom(() => resolveLoopAlias(undefined, model, DECLARED));
        assert.equal(result.problem.type, "https://problems.plurnk.dev/daemon/provider/model-spec-invalid");
        assert.equal(result.problem.status, 400);
        assert.equal(result.problem.model, model);
        assert.equal(result.problem.stage, "provider-selection");
        assert.equal(result.problem.retryable, false);
    }
});

test("an undeclared alias throws - never a silent wrong-model worker", () => {
    const { result } = failureFrom(() => resolveLoopAlias("ghost", undefined, DECLARED));
    assert.equal(result.problem.type, "https://problems.plurnk.dev/daemon/provider/alias-not-found");
    assert.equal(result.problem.status, 404);
    assert.equal(result.problem.alias, "ghost");
    assert.equal(result.problem.retryable, false);
});
