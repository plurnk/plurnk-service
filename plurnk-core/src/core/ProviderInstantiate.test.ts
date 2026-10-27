import assert from "node:assert/strict";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import test, { describe } from "node:test";
import { createServer, type AddressInfo } from "node:net";
import { Mock } from "@plurnk/plurnk-providers";
import { requestUrl } from "../../../scripts/lib/test-fetch.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveOperatorGrammarPath } from "./TurnRunner.ts";

describe("ProviderInstantiate", () => {
// A loopback port the kernel just handed out and this process released: closed, by evidence.
const releasedPort = (): Promise<number> => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
    });
});

test("{§observability-boundary} provider identity is independent of its configuration alias", () => {
    for (const alias of [undefined, "potato"]) {
        const provider = new Mock({ contextWindow: 16_384, responses: [] });
        ProviderInstantiate.registerInstance(provider, { provider: "openai", model: "local", alias });
        assert.equal(ProviderInstantiate.providerIdOf(provider), "openai");
        assert.equal(ProviderInstantiate.aliasOf(provider), alias);
        ProviderInstantiate.registerConfigurationScope(provider, "different-tuning");
        assert.equal(ProviderInstantiate.providerIdOf(provider), "openai");
        assert.equal(ProviderInstantiate.aliasOf(provider), "different-tuning");
    }
    const foreign = new Mock({ contextWindow: 16_384, responses: [] });
    ProviderInstantiate.registerConfigurationScope(foreign, "potato");
    assert.equal(ProviderInstantiate.providerIdOf(foreign), undefined, "an alias alone does not identify a provider");
});

// A per-alias baseUrl (PLURNK_BASEURL_<alias>) reaches endpoint resolution ahead of
// OPENAI_BASE_URL. Here alias.baseUrl and OPENAI_BASE_URL point at different ports;
// the construction probe must hit the alias's port, never the env's.
test("{§provider-resolution} instantiateProvider threads alias.baseUrl past an ambient OPENAI_BASE_URL", async () => {
    const hit: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((u: string | URL | Request, ...rest: unknown[]) => {
        hit.push(requestUrl(u));
        return (realFetch as (...a: unknown[]) => Promise<Response>)(u, ...rest);
    });
    // Both endpoints are ports this process bound and released a moment ago, so each is closed by
    // evidence rather than by assumption — we assert routing, not a live response, so the probe's
    // connection failure is expected and irrelevant.
    const [aliasPort, ambientPort] = await Promise.all([releasedPort(), releasedPort()]);
    try {
        await ProviderInstantiate.instantiateProvider(
            { alias: "probe", provider: "openai", model: "m", baseUrl: `http://127.0.0.1:${aliasPort}/v1` },
            { ...process.env, OPENAI_BASE_URL: `http://127.0.0.1:${ambientPort}`, PLURNK_PROVIDERS_FETCH_TIMEOUT: "1500" },
        ).catch(() => {});
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.ok(hit.some((u) => u.startsWith(`http://127.0.0.1:${aliasPort}`)), `probe must use alias.baseUrl; hit: ${hit.join(", ")}`);
    assert.ok(!hit.some((u) => u.startsWith(`http://127.0.0.1:${ambientPort}`)), `probe must NOT fall through to OPENAI_BASE_URL; hit: ${hit.join(", ")}`);
});

test("{§operator-config-precedence} an alias-scoped provider knob binds at construction — the per-alias CONTEXT_WINDOW pin is promoted, not dropped", async () => {
    // {§operator-config-precedence}: PLURNK_PROVIDERS_CONTEXT_WINDOW_<alias> reaches the
    // factory, so min(cap, served) binds.
    const provider = await ProviderInstantiate.instantiateProvider(
        { alias: "pinbox", provider: "openai", model: "test-model", baseUrl: "http://127.0.0.1:9" },
        { ...process.env, OPENAI_API_KEY: "k", PLURNK_PROVIDERS_FETCH_TIMEOUT: "1500", PLURNK_PROVIDERS_CONTEXT_WINDOW_PINBOX: "8000", PLURNK_PROVIDERS_PROBE_NCTX: "0" },
    );
    assert.equal(provider.contextWindow, 8000, "the alias-scoped pin binds — min(cap, served) has a cap to bind with");
    assert.equal(ProviderInstantiate.providerIdOf(provider), "openai");
    assert.equal(ProviderInstantiate.aliasOf(provider), "pinbox");
});

test("{§provider-surface} a pollable provider exposes the lower operator-capped window and derives its generation envelope from it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
        if (requestUrl(input).endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{
                    id: "served.gguf",
                    meta: { n_ctx: 49_152 },
                }],
            }), { status: 200 });
        }
        if (requestUrl(input).endsWith("/props")) {
            return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        }
        throw new Error(`unexpected request: ${requestUrl(input)}`);
    });
    try {
        const provider = await ProviderInstantiate.instantiateProvider(
            { alias: "tight", provider: "openai", model: "local", baseUrl: "http://local.test/v1" },
            {
                ...process.env,
                PLURNK_PROVIDERS_CONTEXT_WINDOW_TIGHT: "32000",
                PLURNK_PROVIDERS_OUTPUT_BUDGET_TIGHT: "35%",
                PLURNK_PROVIDERS_REASONING_BUDGET_TIGHT: "10%",
                PLURNK_PROVIDERS_FETCH_TIMEOUT: "1500",
                PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
                PLURNK_PROVIDERS_PROBE_DELAY: "0",
            },
        );
        assert.equal(provider.contextWindow, 32_000);
        assert.equal(provider.outputBudget, 11_200);
        assert.equal(provider.reasoningBudget, 3_200);
        assert.equal(provider.inputCapacity, 20_800);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("{§provider-instantiation} the process cache separates aliases and provider tuning for the same wire model", async () => {
    const realFetch = globalThis.fetch;
    const key = "PLURNK_PROVIDERS_CONTEXT_WINDOW_cachecap";
    const previous = process.env[key];
    globalThis.fetch = (async (input: string | URL | Request) => {
        if (requestUrl(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "served.gguf", meta: { n_ctx: 49_152 } }] }), { status: 200 });
        }
        if (requestUrl(input).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        throw new Error(`unexpected request: ${requestUrl(input)}`);
    });
    const spec = { alias: "cachecap", provider: "openai", model: "local", baseUrl: "http://cache.test/v1" };
    try {
        process.env[key] = "32000";
        const first = await ProviderInstantiate.instantiateProvider(spec);
        process.env[key] = "16000";
        const second = await ProviderInstantiate.instantiateProvider(spec);
        assert.equal(first.contextWindow, 32_000);
        assert.equal(second.contextWindow, 16_000);
        assert.notEqual(first, second);
    } finally {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
        globalThis.fetch = realFetch;
    }
});

test("{§provider-instantiation} a registered handle cannot shadow changed provider tuning", async () => {
    const realFetch = globalThis.fetch;
    const key = "PLURNK_PROVIDERS_CONTEXT_WINDOW_registeredcap";
    const previous = process.env[key];
    const spec = { alias: "registeredcap", provider: "openai", model: "local", baseUrl: "http://registered.test/v1" };
    globalThis.fetch = (async (input: string | URL | Request) => {
        if (requestUrl(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "served.gguf", meta: { n_ctx: 49_152 } }] }), { status: 200 });
        }
        if (requestUrl(input).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        throw new Error(`unexpected request: ${requestUrl(input)}`);
    });
    try {
        process.env[key] = "32000";
        const injected = new Mock({ contextWindow: 32_000, responses: [] });
        ProviderInstantiate.registerInstance(injected, spec);
        assert.equal(await ProviderInstantiate.instantiateProvider(spec), injected);

        process.env[key] = "16000";
        const retuned = await ProviderInstantiate.instantiateProvider(spec);
        assert.notEqual(retuned, injected);
        assert.equal(retuned.contextWindow, 16_000);
    } finally {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
        globalThis.fetch = realFetch;
    }
});

test("{§provider-instantiation} the process cache separates durable efforts for one route", async () => {
    const spec = {
        alias: `reasoning-cache-${crypto.randomUUID()}`,
        provider: "mocktest",
        model: "same-model",
    };
    const adaptive = new Mock({ contextWindow: 32_000, responses: [] });
    const high = new Mock({ contextWindow: 32_000, responses: [] });
    ProviderInstantiate.registerInstance(adaptive, spec, process.env, "adaptive");
    ProviderInstantiate.registerInstance(high, spec, process.env, "high");

    assert.equal(await ProviderInstantiate.instantiateProvider(spec, process.env, "adaptive"), adaptive);
    assert.equal(await ProviderInstantiate.instantiateProvider(spec, process.env, "high"), high);
    assert.notEqual(adaptive, high);
});

test("{§session-effort} an exact route uses global provider tuning and never fabricates an alias scope", () => {
    const route = { provider: "mocktest", model: "same-model" };
    const env = {
        PLURNK_PROVIDERS_EFFORT: "adaptive",
        "PLURNK_PROVIDERS_EFFORT_mocktest/same-model": "high",
    };
    assert.equal(
        ProviderInstantiate.configuredEffort(route, env),
        "adaptive",
        "the exact route string is identity, not an alias-shaped tuning namespace",
    );
});

test("{§provider-instantiation} an exact-route handle never inherits the daemon default alias's configuration scope", () => {
    const provider = new Mock({ contextWindow: 32_000, responses: [] });
    ProviderInstantiate.registerInstance(provider, {
        provider: "mocktest",
        model: "direct-model",
    });
    const env = {
        PLURNK_MODEL: "defaultbox",
        PLURNK_MODEL_defaultbox: "openai/local-model",
        PLURNK_PROVIDERS_GBNF_defaultbox: "/operator/rails/defaultbox.gbnf",
    };

    assert.equal(ProviderInstantiate.aliasOf(provider), undefined);
    assert.equal(ProviderInstantiate.configurationAliasOf(provider, env), undefined);
    assert.doesNotThrow(
        () => ProviderInstantiate.validateGrammarConfiguration(provider, env),
        "the boot alias's GBNF does not constrain an independently selected exact route",
    );
});

test("{§provider-instantiation} route-scoped GBNF cannot bind to a provider with no route identity", () => {
    const provider = new Mock({ contextWindow: 32_000, responses: [] });
    assert.throws(
        () => ProviderInstantiate.validateGrammarConfiguration(provider, {
            PLURNK_PROVIDERS_GBNF_somewhere: "/operator/rails/somewhere.gbnf",
        }),
        /provider has no registered route and no active model route resolves/,
    );
});
});

describe("operator-grammar", () => {
// {§provider-instantiation}





test("{§provider-instantiation}: absolute, home-relative, and working-directory-relative paths resolve to files", () => {
    assert.equal(resolveOperatorGrammarPath("/operator/rails/custom.gbnf"), "/operator/rails/custom.gbnf");
    assert.equal(resolveOperatorGrammarPath("~/.config/plurnk/local.gbnf"), resolve(homedir(), ".config/plurnk/local.gbnf"));
    assert.equal(resolveOperatorGrammarPath("./rails/custom.gbnf"), resolve("rails/custom.gbnf"));
    assert.equal(resolveOperatorGrammarPath("rails/custom.gbnf"), resolve("rails/custom.gbnf"));
    assert.equal(resolveOperatorGrammarPath("custom.gbnf"), resolve("custom.gbnf"));
});
});
