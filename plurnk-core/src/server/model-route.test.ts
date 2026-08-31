// {§worker-reasoning-policy} — effort rides the client-visible route; a model without
// a reasoning dimension carries none.
import test from "node:test";
import assert from "node:assert/strict";
import { projectModelRoute } from "./model-route.ts";

test("{§worker-reasoning-policy} projectModelRoute carries the durable policy; a dimensionless model omits it", () => {
    assert.deepEqual(
        projectModelRoute({ alias: "fireox", provider: "fireworks", model: "accounts/fireworks/models/glm-5p3-flash" }, "low"),
        { alias: "fireox", provider: "fireworks", model: "accounts/fireworks/models/glm-5p3-flash", reasoningPolicy: "low" },
    );
    // Catalog reasoning: false — no reasoning dimension, no policy on the route.
    assert.deepEqual(
        projectModelRoute({ provider: "openrouter", model: "tencent/hy-mt2-30b-a3b" }, "low"),
        { provider: "openrouter", model: "tencent/hy-mt2-30b-a3b" },
    );
    // An uncataloged (custom rail) model keeps the operator's configured policy.
    assert.equal(projectModelRoute({ provider: "openai", model: "custom.gguf" }, "adaptive").reasoningPolicy, "adaptive");
    // No policy given (legacy caller) — nothing attaches.
    assert.equal("reasoningPolicy" in projectModelRoute({ provider: "deepseek", model: "deepseek-v4-flash" }), false);
});
