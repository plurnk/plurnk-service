// {§worker-effort} — effort rides the client-visible route; a model without
// a reasoning dimension carries none.
import test from "node:test";
import assert from "node:assert/strict";
import { projectModelRoute } from "./model-route.ts";

test("{§worker-effort} projectModelRoute carries the durable policy; a dimensionless model omits it", () => {
    assert.deepEqual(
        projectModelRoute({ alias: "fastroute", provider: "fireworks-ai", model: "accounts/fireworks/models/glm-5p3-flash" }, "low"),
        { alias: "fastroute", provider: "fireworks-ai", model: "accounts/fireworks/models/glm-5p3-flash", effort: "low", effortSource: "default" },
    );
    // Catalog reasoning: false — no reasoning dimension, no policy on the route.
    assert.deepEqual(
        projectModelRoute({ provider: "openrouter", model: "tencent/hy-mt2-30b-a3b" }, "low"),
        { provider: "openrouter", model: "tencent/hy-mt2-30b-a3b" },
    );
    // An uncataloged (custom rail) model keeps the operator's configured policy.
    assert.equal(projectModelRoute({ provider: "openai", model: "custom.gguf" }, "adaptive").effort, "adaptive");
    // No policy given (legacy caller) — nothing attaches.
    assert.equal("effort" in projectModelRoute({ provider: "deepseek", model: "deepseek-v4-flash" }), false);
});

test("{§worker-effort-source} projectModelRoute carries the source exactly when it carries the policy", () => {
    const explicit = projectModelRoute({ provider: "openai", model: "custom.gguf" }, "high", "explicit");
    assert.deepEqual([explicit.effort, explicit.effortSource], ["high", "explicit"]);
    const none = projectModelRoute({ provider: "openai", model: "custom.gguf" }, null, "explicit");
    assert.equal("effortSource" in none, false, "no policy, no source");
});
