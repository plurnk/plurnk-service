import test from "node:test";
import { strict as assert } from "node:assert";
import RequestFields from "./RequestFields.ts";
import { scopeEnvToAlias } from "./env.ts";
import { withProviderDefaults } from "./defaults.ts";

const declaration = {
    PLURNK_PROVIDERS_REASONING_FALLBACK: "high",
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_OUTPUT_PATH: "/max_completion_tokens",
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_EFFORT_PATH: "/reasoning_effort",
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_BUDGET_PATH: "/thinking_budget",
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_EFFORTS: "low,medium,xhigh",
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_CONTROLS: "exclusive",
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_ON_BODY: '{"enable_thinking":true}',
    PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_OFF_BODY: '{"enable_thinking":false}',
};

test("{§provider-reasoning-policy} adaptive prefers the configured fallback without escalating or disabling reasoning", () => {
    const facts = {
        reasoning: true,
        reasoningOptions: [
            { type: "toggle" as const },
            { type: "effort" as const, values: ["low", "medium", "high", "xhigh", "max"] as const },
        ],
    };
    const configured = {
        ...declaration,
        PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_EFFORTS: "",
        PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_TOGGLE_BODY: '{"reasoning_effort":true}',
    };
    for (const [overrides, expected] of [
        [{}, { reasoning_effort: "high" }],
        [{ PLURNK_PROVIDERS_REASONING_FALLBACK: "medium" }, { reasoning_effort: "medium" }],
        [{ PLURNK_PROVIDERS_REASONING_FALLBACK: "" }, { reasoning_effort: true }],
        [{ PLURNK_PROVIDERS_REASONING_TRANSPORT_EFFORTS: "low,xhigh,max" }, { reasoning_effort: true }],
        [{ PLURNK_PROVIDERS_REASONING_ADAPTIVE_BODY: "{}" }, {}],
        [{ PLURNK_PROVIDERS_REASONING_ADAPTIVE_BODY: '{"thinking":{"type":"adaptive"}}' }, { thinking: { type: "adaptive" } }],
    ] as const) {
        const fields = new RequestFields("example", { ...configured, ...overrides }, facts);
        assert.deepEqual(fields.body("adaptive", 32768, null), {
            enable_thinking: true, ...expected, max_completion_tokens: 32768,
        }, JSON.stringify(overrides));
    }
    const missingHigh = new RequestFields("example", configured, {
        reasoning: true,
        reasoningOptions: [{ type: "effort", values: ["low", "medium", "xhigh"] }],
    });
    assert.deepEqual(missingHigh.body("adaptive", 32768, null), {
        enable_thinking: true, max_completion_tokens: 32768,
    }, "missing high preserves activation without selecting xhigh");
});

test("{§provider-wire-declaration} retired style selectors fail at the selected configuration boundary", () => {
    for (const key of ["PLURNK_PROVIDERS_REASONING_STYLE", "PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_STYLE"]) {
        assert.throws(() => new RequestFields("example", { ...declaration, [key]: "thinking_effort" }), /REASONING_STYLE is retired.*request-field declarations/);
        assert.throws(() => RequestFields.assertNative("example", { [key]: "thinking_effort" }), /REASONING_STYLE is retired.*request-field declarations/);
    }
    assert.throws(() => scopeEnvToAlias({ PLURNK_PROVIDERS_REASONING_STYLE_MY_BOX: "effort" }, "my_box"), /REASONING_STYLE_MY_BOX is retired/);
    assert.doesNotThrow(() => new RequestFields("example", {
        ...declaration, PLURNK_PROVIDERS_PROVIDER_OTHER_REASONING_STYLE: "effort",
    }));
    assert.doesNotThrow(() => scopeEnvToAlias({ PLURNK_PROVIDERS_REASONING_STYLE_OTHER: "effort" }, "my_box"));
});

test("{§provider-wire-declaration} a declaration, not a provider identity, determines projection", () => {
    const renamed = Object.fromEntries(Object.entries(declaration).map(([key, value]) => [key.replace("EXAMPLE", "UNLISTED"), value]));
    const first = new RequestFields("example", declaration);
    const second = new RequestFields("unlisted", renamed);
    assert.deepEqual(first.policies, ["off", "adaptive", "low", "medium", "xhigh"]);
    assert.deepEqual(second.policies, first.policies);
    const expected = { enable_thinking: true, reasoning_effort: "medium", max_completion_tokens: 32768 };
    assert.deepEqual(first.body("medium", 32768, null), expected);
    assert.deepEqual(second.body("medium", 32768, null), expected);
    assert.deepEqual(first.body("adaptive", 32768, 8192), {
        enable_thinking: true, thinking_budget: 8192, max_completion_tokens: 32768,
    });
    assert.deepEqual(first.body("off", 32768, null), { enable_thinking: false, max_completion_tokens: 32768 });
});

test("{§provider-wire-declaration} an unrepresentable explicit control fails instead of disappearing", () => {
    const wire = new RequestFields("example", declaration);
    assert.throws(() => wire.body("medium", 32768, 8192), /reasoning effort and budget are exclusive/);
    assert.throws(() => wire.body("high", 32768, null), /reasoning policy 'high' is unsupported/);
    const noBudget = new RequestFields("example", { ...declaration, PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_BUDGET_PATH: "" });
    assert.throws(() => noBudget.body("adaptive", 32768, 8192), /REASONING_BUDGET_PATH/);
    const combined = new RequestFields("example", { ...declaration, PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_CONTROLS: "combined" });
    assert.deepEqual(combined.body("medium", 32768, 8192), {
        enable_thinking: true, reasoning_effort: "medium", thinking_budget: 8192, max_completion_tokens: 32768,
    });
});

test("{§provider-wire-declaration} route and alias declarations narrow provider declarations, including an empty body", () => {
    const scoped = scopeEnvToAlias({
        ...declaration,
        PLURNK_PROVIDERS_OUTPUT_PATH_sample: "/limits/output",
        PLURNK_PROVIDERS_REASONING_EFFORT_PATH_sample: "/thinking/level",
        PLURNK_PROVIDERS_REASONING_ON_BODY_sample: "{}",
    }, "sample");
    assert.deepEqual(new RequestFields("example", scoped).body("low", 10000, null), {
        thinking: { level: "low" }, limits: { output: 10000 },
    });
});

test("{§provider-wire-declaration} the catalog supplies efforts and numeric bounds without choosing wire fields", () => {
    const catalog = {
        reasoning: true,
        reasoningOptions: [
            { type: "toggle" as const },
            { type: "effort" as const, values: ["low" as const, "medium" as const] },
            { type: "budget_tokens" as const, min: 128, max: 4096 },
        ],
    };
    const wire = new RequestFields("example", {
        ...declaration, PLURNK_PROVIDERS_PROVIDER_EXAMPLE_REASONING_EFFORTS: "",
    }, catalog);
    assert.deepEqual(wire.policies, ["off", "adaptive", "low", "medium"]);
    assert.deepEqual(wire.body("adaptive", 10000, null), {
        enable_thinking: true, max_completion_tokens: 10000,
    });
    assert.throws(() => wire.body("adaptive", 10000, 127), /reasoning budget 127.*128/);
    assert.throws(() => wire.body("adaptive", 10000, 4097), /reasoning budget 4097.*4096/);
    const nonReasoning = new RequestFields("example", declaration, { reasoning: false });
    assert.deepEqual(nonReasoning.policies, ["off", "adaptive"]);
    assert.deepEqual(nonReasoning.body("adaptive", 10000, null), { max_completion_tokens: 10000 });
    assert.throws(() => nonReasoning.body("adaptive", 10000, 1024), /does not support reasoning/);
});

test("{§provider-wire-declaration} static adaptation cannot rewrite transport, sampling, or managed controls", () => {
    for (const body of ['{"messages":[]}', '{"temperature":1}', '{"thinking_budget":1}', '{"max_tokens":1}', '{"__proto__":{}}']) {
        assert.throws(() => new RequestFields("example", { ...declaration, PLURNK_PROVIDERS_REASONING_ON_BODY: body }), /REASONING_ON_BODY/);
    }
    for (const path of ["reasoning", "/messages/0", "/__proto__/x", "/x~2y", "/max_completion_tokens"]) {
        assert.throws(() => new RequestFields("example", { ...declaration, PLURNK_PROVIDERS_REASONING_BUDGET_PATH: path }), /REASONING_BUDGET_PATH/);
    }
    assert.throws(() => new RequestFields("example", { ...declaration, PLURNK_PROVIDERS_REASONING_CONTROLS: "guess" }), /REASONING_CONTROLS/);
});

test("{§provider-wire-declaration} pointers follow RFC 6901 and conflicting parents are refused", () => {
    const wire = new RequestFields("example", {
        ...declaration, PLURNK_PROVIDERS_REASONING_BUDGET_PATH: "/thinking/budget~1tokens~0",
    });
    assert.equal((wire.body("adaptive", 10000, 2000).thinking as Record<string, unknown>)["budget/tokens~"], 2000);
    assert.throws(() => new RequestFields("example", {
        ...declaration,
        PLURNK_PROVIDERS_REASONING_BUDGET_PATH: "/thinking/budget",
        PLURNK_PROVIDERS_REASONING_ON_BODY: '{"thinking":true}',
    }), /overlap/);
});

test("{§provider-wire-declaration} native option declarations retain control admission without writing an output field", () => {
    const fields = new RequestFields("renamed", {
        ...withProviderDefaults({}),
        PLURNK_PROVIDERS_PROVIDER_RENAMED_OPTIONS_NAMESPACE: "testSdk",
        PLURNK_PROVIDERS_PROVIDER_RENAMED_REASONING_EFFORT_PATH: "/reasoning/effort",
        PLURNK_PROVIDERS_PROVIDER_RENAMED_REASONING_BUDGET_PATH: "/reasoning/max_tokens",
        PLURNK_PROVIDERS_PROVIDER_RENAMED_REASONING_EFFORTS: "none,low,medium,high,max",
        PLURNK_PROVIDERS_PROVIDER_RENAMED_REASONING_TRANSPORT_EFFORTS: "none,low,high",
        PLURNK_PROVIDERS_PROVIDER_RENAMED_REASONING_CONTROLS: "exclusive",
    });
    assert.equal(fields.namespace, "testSdk");
    assert.deepEqual(fields.policies, ["off", "adaptive", "low", "high"]);
    assert.deepEqual(fields.body("high", 8192, null), { reasoning: { effort: "high" } });
    assert.deepEqual(fields.body("adaptive", 8192, 2048), { reasoning: { max_tokens: 2048 } });
    assert.throws(() => fields.body("medium", 8192, null), /reasoning policy 'medium' is unsupported/);
    assert.throws(() => new RequestFields("example", {
        ...declaration, PLURNK_PROVIDERS_OPTIONS_NAMESPACE: "testSdk",
    }), /OUTPUT_PATH.*native SDKs/);
});
