import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "./SchemeRegistry.ts";
import type { SchemeManifest } from "./scheme-types.ts";
import { SchemeDiscovery } from "@plurnk/plurnk-schemes";

const manifest = (name: string): SchemeManifest => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

const handler = (name: string, behavior: object = {}): object => ({ manifest: manifest(name), ...behavior });

// discoverExternal scans cwd/node_modules/@plurnk for plurnk.kind:"scheme"
// siblings. @plurnk/plurnk-schemes-http is installed, so it's found, registered
// by its declared name ("http"). Agnostic by kind — the package name is never
// hardcoded (#195).
test("SchemeRegistry.discoverExternal registers the http sibling (#195)", async () => {
    const registry = new SchemeRegistry();
    assert.equal(registry.has("http"), false, "not registered until discovery runs");

    await registry.discoverExternal();

    assert.equal(registry.has("http"), true, "the external http sibling is discovered + registered");
});

test("SchemeRegistry consumes one discovered package attribution without reopening its manifest", async (t: TestContext) => {
    t.mock.method(SchemeDiscovery, "discover", async () => ({
        schemes: [{ name: "http", packageName: "@plurnk/plurnk-schemes-http" }],
        skipped: [],
        packageAttributions: new Map([["@plurnk/plurnk-schemes-http", ["@plurnk/http"]]]),
    }));
    const registry = new SchemeRegistry();

    await registry.discoverExternal();
    await registry.discoverExternal();

    assert.deepEqual(registry.attributions(), ["@plurnk/http"], "idempotent scans retain one package fact");
});

// #240 — the built-in scheme names are reserved namespace-wide; a discovered executor
// claiming one fails the boot HARD rather than being silently shadowed (in-tree precedence
// hid a collision that, for a security-relevant name like file/worker, must surface loudly).
type RegistryArg = Parameters<SchemeRegistry["registerRuntimeSchemes"]>[0];

test("registerRuntimeSchemes: an executor tag shadowing a reserved built-in fails hard (#240)", () => {
    const registry = new SchemeRegistry();
    const shadows = { availableRuntimes: () => ["file"], entry: () => ({ executor: { manifest: { name: "file", channels: {}, defaultChannel: "body" } } }) } as unknown as RegistryArg;
    assert.throws(
        () => registry.registerRuntimeSchemes(shadows),
        /collides with a reserved built-in/,
        "a runtime tag claiming 'file' must fail-hard, never silently shadow the built-in",
    );
});

test("registerRuntimeSchemes: a non-reserved executor tag registers its own per-tag face (#240)", () => {
    const registry = new SchemeRegistry();
    const real = {
        availableRuntimes: () => ["sh"],
        entry: () => ({ executor: { manifest: manifest("sh") } }),
    } as unknown as RegistryArg;
    registry.registerRuntimeSchemes(real);
    assert.ok(registry.has("sh"), "the sh per-tag face is registered under its tag");
});

test("registerRuntimeSchemes: a tag colliding with an already-claimed (non-reserved) scheme fails hard — one name, one owner (#240)", () => {
    const registry = new SchemeRegistry();
    registry.register("figma", handler("figma")); // an external scheme sibling claims the name first
    const collides = { availableRuntimes: () => ["figma"], entry: () => ({ executor: { manifest: { name: "figma", channels: {}, defaultChannel: "results" } } }) } as unknown as RegistryArg;
    assert.throws(
        () => registry.registerRuntimeSchemes(collides),
        /one name, one owner/,
        "a runtime tag colliding with an external scheme must fail-hard, not silently first-wins-skip (cross-family namespace)",
    );
});

test("registerRuntimeSchemes: re-scanning the same runtime tag is idempotent, not a collision (#240)", () => {
    const registry = new SchemeRegistry();
    const real = {
        availableRuntimes: () => ["sh"],
        entry: () => ({ executor: { manifest: manifest("sh") } }),
    } as unknown as RegistryArg;
    registry.registerRuntimeSchemes(real);
    assert.doesNotThrow(() => registry.registerRuntimeSchemes(real), "a second scan of an already-registered runtime tag skips (idempotent re-scan), never throws");
    assert.ok(registry.has("sh"));
});

test("lifecycle hooks run once per unique handler object identity", async () => {
    const registry = new SchemeRegistry();
    let name = "resource-a";
    let probes = 0;
    let closes = 0;
    const shared = {
        get manifest() { return manifest(name); },
        async ready() { probes++; },
        async close() { closes++; },
    };
    registry.register(name, shared);
    name = "resource-alias";
    registry.register(name, shared);
    registry.register("stateless", handler("stateless"));

    await registry.ready();
    await registry.ready();
    await registry.close();
    await registry.close();

    assert.equal(probes, 1, "aliases and repeated readiness passes probe one handler object once");
    assert.equal(closes, 1, "aliases and repeated shutdown passes close one handler object once");
});

test("ready: a later registration probes only the newly registered handler", async () => {
    const registry = new SchemeRegistry();
    let firstProbes = 0;
    let secondProbes = 0;
    registry.register("resource-a", handler("resource-a", { async ready() { firstProbes++; } }));
    await registry.ready();
    registry.register("resource-b", handler("resource-b", { async ready() { secondProbes++; } }));

    await registry.ready();

    assert.equal(firstProbes, 1);
    assert.equal(secondProbes, 1);
});

test("ready: a failed probe is retained rather than invoked again", async () => {
    const registry = new SchemeRegistry();
    const failure = new Error("readiness failed");
    let probes = 0;
    let closes = 0;
    registry.register("partial", handler("partial", {
        async ready() {
            probes += 1;
            throw failure;
        },
        async close() { closes += 1; },
    }));

    await assert.rejects(() => registry.ready(), (error) => error === failure);
    await assert.rejects(() => registry.ready(), (error) => error === failure);
    await registry.close();

    assert.equal(probes, 1, "readiness is invoked once even when partial initialization fails");
    assert.equal(closes, 1, "a readiness failure does not exempt partial resources from shutdown");
});

test("close: attempts and awaits every handler, then aggregates every failure", async () => {
    const registry = new SchemeRegistry();
    const slow = Promise.withResolvers<void>();
    let slowSettled = false;
    let secondAttempted = false;
    registry.register("failure-a", handler("failure-a", {
        async close() { throw new Error("failure a"); },
    }));
    registry.register("slow", handler("slow", {
        async close() {
            await slow.promise;
            slowSettled = true;
        },
    }));
    registry.register("failure-b", handler("failure-b", {
        async close() {
            secondAttempted = true;
            throw new Error("failure b");
        },
    }));
    setImmediate(() => slow.resolve());

    await assert.rejects(
        () => registry.close(),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors.map((cause) => String(cause)), ["Error: failure a", "Error: failure b"]);
            return true;
        },
    );
    assert.equal(secondAttempted, true, "a prior failure does not skip a later closer");
    assert.equal(slowSettled, true, "shutdown waits for a slower closer before rejecting");
});

test("register requires one identity-matched static or instance manifest", () => {
    const registry = new SchemeRegistry();
    assert.throws(() => registry.register("missing", {}), /must declare a static or instance manifest/);
    assert.throws(() => registry.register("expected", handler("other")), /identity mismatch/);
    assert.doesNotThrow(() => registry.register("dynamic", handler("dynamic")));
});

// #240 — PLURNK_SERVICE_DOCS_EXCLUDE drops a name from BOTH the teaching oneliner and the materialized
// pull-doc, on load. A non-listed name is untouched; a stray name is inert (a filter, not a contract).
test("teach()/docs(): PLURNK_SERVICE_DOCS_EXCLUDE drops the oneliner + the doc; stray names inert (#240)", async () => {
    const registry = new SchemeRegistry();
    const prior = process.env.PLURNK_SERVICE_DOCS_EXCLUDE;
    try {
        process.env.PLURNK_SERVICE_DOCS_EXCLUDE = "log,nonsuch";
        const teaching = registry.teach();
        assert.doesNotMatch(teaching, /log:\/\/\//, "an excluded scheme contributes no oneliner");
        assert.match(teaching, /worker:\/\/\/notes\.md/, "a non-excluded scheme still teaches (stray 'nonsuch' is inert)");
        assert.equal((await registry.docs()).find((d) => d.name === "log"), undefined, "an excluded scheme materializes no doc");
        assert.ok((await registry.docs()).find((d) => d.name === "worker"), "a non-excluded scheme still materializes its doc");

        process.env.PLURNK_SERVICE_DOCS_EXCLUDE = "";
        assert.match(registry.teach(), /log:\/\/\//, "cleared exclude → log teaches again");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_DOCS_EXCLUDE;
        else process.env.PLURNK_SERVICE_DOCS_EXCLUDE = prior;
    }
});

test("docs(): absent manifest documentation is optional; present external documentation is the fallback", async () => {
    const registry = new SchemeRegistry();
    registry.register("undocumented", handler("undocumented"));
    registry.register("documented", {
        manifest: {
            ...manifest("documented"),
            documentation: "# documented\nExternal depth.",
        },
    });

    const docs = await registry.docs();

    assert.equal(docs.find((doc) => doc.name === "undocumented"), undefined, "an absent optional manifest document contributes nothing");
    assert.equal(docs.find((doc) => doc.name === "documented")?.content, "# documented\nExternal depth.", "an external manifest document materializes when meta owns no same-name source");
});
