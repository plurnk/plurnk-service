import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { loadActiveProvider } from "./ProviderRegistry.ts";

const baseEnv = {
    PLURNK_MODEL: "sample_box",
    PLURNK_MODEL_sample_box: "fireworks-ai/accounts/fireworks/models/kimi-k3",
    FIREWORKS_API_KEY: "test-key",
    OPENAI_API_KEY: "test-key",
    PLURNK_PROVIDERS_REASONING: "adaptive",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
    PLURNK_PROVIDERS_PROBE_DELAY: "0",
};

const installWire = () => {
    const calls: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return Response.json({ data: [{ id: "local", meta: { n_ctx: 8192 } }] });
        if (url.endsWith("/props")) return Response.json({ total_slots: 1 });
        if (url.endsWith("/input_tokens")) return Response.json({ input_tokens: 2 });
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response([
            `data: ${JSON.stringify({
                id: "sampling-test",
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });
    return calls;
};

const generateArgs = { workerId: "sampling-test", messages: [{ role: "user" as const, content: "hello" }] };
const samplingKeys = ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "seed"];
const samplingOf = (body: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => samplingKeys.includes(key)));

test.afterEach(() => mock.restoreAll());

for (const [name, route] of [
    ["catalog compatible", "fireworks-ai/accounts/fireworks/models/kimi-k3"],
    ["native OpenAI SDK", "openai/gpt-4.1-mini"],
    ["local compatible", "openai/local-sampling-test"],
] as const) {
    test(`{§provider-sampling-passthrough}: ${name} carries alias sampling to the wire and caller values win`, async () => {
        const calls = installWire();
        const topK = name === "native OpenAI SDK" ? {} : { PLURNK_PROVIDERS_TOP_K_SAMPLE_BOX: "40" };
        const provider = await loadActiveProvider({
            ...baseEnv,
            PLURNK_MODEL_sample_box: route,
            PLURNK_BASEURL_sample_box: "http://sampling.test/v1",
            PLURNK_PROVIDERS_TEMPERATURE: "0.6",
            PLURNK_PROVIDERS_TEMPERATURE_SAMPLE_BOX: "1",
            PLURNK_PROVIDERS_TOP_P: "0.95",
            PLURNK_PROVIDERS_TOP_P_SAMPLE_BOX: "1",
            ...topK,
            PLURNK_PROVIDERS_PRESENCE_PENALTY_SAMPLE_BOX: "0.25",
            PLURNK_PROVIDERS_FREQUENCY_PENALTY_SAMPLE_BOX: "-0.5",
            PLURNK_PROVIDERS_SEED_SAMPLE_BOX: "0",
        });
        assert.equal((await provider.generate(generateArgs)).assistant.content, "ok");
        assert.deepEqual(samplingOf(calls[0]), {
            temperature: 1,
            top_p: 1,
            ...(name === "native OpenAI SDK" ? {} : { top_k: 40 }),
            presence_penalty: 0.25,
            frequency_penalty: -0.5,
            seed: 0,
        });
        const sampling = {
            temperature: 0,
            top_p: 0.7,
            ...(name === "native OpenAI SDK" ? {} : { top_k: 10 }),
            presence_penalty: 0,
            frequency_penalty: 0,
            seed: 17,
        };
        await provider.generate({ ...generateArgs, sampling });
        assert.deepEqual(samplingOf(calls[1]), sampling);
    });

    test(`{§provider-sampling-passthrough}: ${name} omits unset sampling and ignores other aliases`, async () => {
        const calls = installWire();
        const provider = await loadActiveProvider({
            ...baseEnv,
            PLURNK_MODEL_sample_box: route,
            PLURNK_BASEURL_sample_box: "http://sampling.test/v1",
            PLURNK_PROVIDERS_TOP_P_other: "0.5",
            PLURNK_PROVIDERS_TOP_K_other: "20",
            PLURNK_PROVIDERS_PRESENCE_PENALTY_other: "1",
            PLURNK_PROVIDERS_SEED_other: "42",
        });
        await provider.generate(generateArgs);
        assert.deepEqual(samplingOf(calls[0]), {});
    });
}

test("{§provider-sampling-passthrough}: empty alias tuning retains the configured global value", async () => {
    const calls = installWire();
    const provider = await loadActiveProvider({ ...baseEnv, PLURNK_PROVIDERS_TOP_P: "0.8", PLURNK_PROVIDERS_TOP_P_sample_box: "" });
    await provider.generate(generateArgs);
    assert.deepEqual(samplingOf(calls[0]), { top_p: 0.8 });
});

test("{§provider-sampling-passthrough}: numeric boundaries remain values, not absence", async () => {
    const calls = installWire();
    for (const value of [-2, 2]) {
        const provider = await loadActiveProvider({
            ...baseEnv,
            PLURNK_PROVIDERS_TOP_P_sample_box: "0",
            PLURNK_PROVIDERS_TOP_K_sample_box: "0",
            PLURNK_PROVIDERS_PRESENCE_PENALTY_sample_box: String(value),
            PLURNK_PROVIDERS_FREQUENCY_PENALTY_sample_box: String(value),
            PLURNK_PROVIDERS_SEED_sample_box: "-1",
        });
        await provider.generate(generateArgs);
        assert.deepEqual(samplingOf(calls.at(-1)), {
            top_p: 0, top_k: 0, presence_penalty: value, frequency_penalty: value, seed: -1,
        });
    }
});

test("{§provider-sampling-passthrough}: native Google SDK maps supported controls and surfaces unsupported penalties", async () => {
    let config: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        config = (JSON.parse(String(init?.body)) as { generationConfig: Record<string, unknown> }).generationConfig;
        return new Response(`data: ${JSON.stringify({
            responseId: "sampling-gemini",
            candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const provider = await loadActiveProvider({
        ...baseEnv,
        PLURNK_MODEL_sample_box: "google/gemini-2.5-flash",
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_TEMPERATURE_sample_box: "0.6",
        PLURNK_PROVIDERS_TOP_P_sample_box: "0.9",
        PLURNK_PROVIDERS_TOP_K_sample_box: "40",
        PLURNK_PROVIDERS_PRESENCE_PENALTY_sample_box: "0.5",
        PLURNK_PROVIDERS_FREQUENCY_PENALTY_sample_box: "-0.5",
        PLURNK_PROVIDERS_SEED_sample_box: "42",
    });
    const result = await provider.generate(generateArgs);
    assert.equal(result.assistant.content, "ok");
    assert.ok(config);
    const { temperature, topP, topK, presencePenalty, frequencyPenalty, seed } = config;
    assert.deepEqual({ temperature, topP, topK, presencePenalty, frequencyPenalty, seed }, {
        temperature: 0.6, topP: 0.9, topK: 40, presencePenalty: undefined, frequencyPenalty: undefined, seed: 42,
    });
    assert.deepEqual(result.notices?.filter(({ kind }) => kind === "provider_warning").map(({ message }) => message).sort(), [
        "unsupported frequencyPenalty",
        "unsupported presencePenalty",
    ]);
});

for (const [knob, values] of [
    ["TOP_P", ["-0.1", "1.1", "NaN", "Infinity"]],
    ["TOP_K", ["-1", "1.5", "NaN", "9007199254740992"]],
    ["PRESENCE_PENALTY", ["-2.1", "2.1", "NaN"]],
    ["FREQUENCY_PENALTY", ["-2.1", "2.1", "NaN"]],
    ["SEED", ["1.5", "NaN", "9007199254740992"]],
] as const) {
    test(`{§provider-sampling-passthrough}: invalid ${knob} refuses before inference`, async () => {
        const calls = installWire();
        for (const value of values) {
            await assert.rejects(
                loadActiveProvider({ ...baseEnv, [`PLURNK_PROVIDERS_${knob}_sample_box`]: value }),
                new RegExp(`PLURNK_PROVIDERS_${knob} must`),
            );
        }
        assert.equal(calls.length, 0);
    });
}
