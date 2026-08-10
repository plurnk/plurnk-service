import assert from "node:assert/strict";
import test from "node:test";
import { authoritativeChargeNormalizer } from "./accounting.ts";

const evidence = ({ providerMetadata, usage }: { providerMetadata?: unknown; usage?: unknown }) => ({
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
    ...(usage === undefined ? {} : { usage }),
    response: { id: "response-1" },
});

test("xAI response ticks normalize to an exact provider-authoritative charge", () => {
    const normalize = authoritativeChargeNormalizer("@ai-sdk/xai");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { cost_in_usd_ticks: 15_493_500 } })), {
        kind: "authoritative",
        amount: { amount: "15493500", currency: "USDTICK" },
        usdEquivalent: "0.00154935",
        source: "xAI response usage.cost_in_usd_ticks",
    });
});

test("OpenRouter response cost normalizes without rate reconstruction", () => {
    const normalize = authoritativeChargeNormalizer("@openrouter/ai-sdk-provider");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ providerMetadata: { openrouter: { usage: { cost: 3.2e-7 } } } })), {
        kind: "authoritative",
        amount: { amount: "0.00000032", currency: "USD" },
        usdEquivalent: "0.00000032",
        source: "OpenRouter response usage.cost",
    });
});

test("DeepInfra's documented response estimate wins over local rate reconstruction", () => {
    const normalize = authoritativeChargeNormalizer("@ai-sdk/deepinfra");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { estimated_cost: 5.04e-5 } })), {
        kind: "authoritative",
        amount: { amount: "0.0000504", currency: "USD" },
        usdEquivalent: "0.0000504",
        source: "DeepInfra response usage.estimated_cost",
    });
});

test("response cost normalization is an explicit adapter capability", () => {
    assert.equal(authoritativeChargeNormalizer("@ai-sdk/anthropic"), undefined);
    assert.equal(
        authoritativeChargeNormalizer("@ai-sdk/xai")!(evidence({ usage: {} })),
        undefined,
    );
    assert.throws(
        () => authoritativeChargeNormalizer("@ai-sdk/xai")!(evidence({ usage: { cost_in_usd_ticks: "1" } })),
        /cost_in_usd_ticks must be numeric/,
    );
    assert.throws(
        () => authoritativeChargeNormalizer("@ai-sdk/deepinfra")!(evidence({ usage: { estimated_cost: "1" } })),
        /estimated_cost must be numeric/,
    );
});
