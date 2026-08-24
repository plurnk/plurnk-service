// {§methods-loop-run-model}: per-loop model resolution precedence and parse contract.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveLoopRoute } from "./loop-model.ts";
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
    assert.equal(resolveLoopRoute(undefined, DECLARED), null);
});

test("an exact model selector remains an alias-free route", () => {
    assert.deepEqual(resolveLoopRoute("openrouter/qwen/qwen3-coder", DECLARED),
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        "the model id keeps its inner slashes; only the first splits provider");
});

test("a named alias resolves from the declared cascade, case-folded", () => {
    assert.deepEqual(resolveLoopRoute("FIRESLOW", DECLARED), DECLARED[0], "alias lookup is case-insensitive");
    assert.deepEqual(resolveLoopRoute("local", DECLARED), DECLARED[1], "the baseUrl override rides through");
});

test("a malformed exact model selector throws legibly", () => {
    for (const model of ["/leading", "trailing/"]) {
        const { result } = failureFrom(() => resolveLoopRoute(model, DECLARED));
        assert.equal(result.problem.type, "https://problems.plurnk.xyz/daemon/provider/model-spec-invalid");
        assert.equal(result.problem.status, 400);
        assert.equal(result.problem.selector, model);
        assert.equal(result.problem.stage, "provider-selection");
        assert.equal(result.problem.retryable, false);
    }
});

test("an undeclared alias throws - never a silent wrong-model worker", () => {
    const { result } = failureFrom(() => resolveLoopRoute("ghost", DECLARED));
    assert.equal(result.problem.type, "https://problems.plurnk.xyz/daemon/provider/alias-not-found");
    assert.equal(result.problem.status, 404);
    assert.equal(result.problem.selector, "ghost");
    assert.equal(result.problem.retryable, false);
});
