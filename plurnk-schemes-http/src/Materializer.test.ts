import test from "node:test";
import assert from "node:assert/strict";
import MaterializerRegistry, { type HttpMaterializer } from "./Materializer.ts";

test("{§http-materializer-plugins} a native module registers and releases a materializer in the same registry", async () => {
    const registry = await new MaterializerRegistry().discover({ packageDirs: [] });
    const implementation: HttpMaterializer = {
        id: "fixture",
        eligible: () => "fixture:v1",
        extract: async () => ({ outcome: "success", body: "native body", identity: "fixture:v1", evidence: [] }),
    };
    const release = registry.register("fixture-plugin", implementation);
    const found = registry.materializerFor("fixture");
    assert.ok(found);
    assert.equal(await found.eligible("https://example.com/", {}), "fixture:v1");
    assert.deepEqual(await found.extract("https://example.com/", {}), {
        outcome: "success", body: "native body", identity: "fixture:v1", evidence: [],
    });
    assert.throws(() => registry.register("competing-plugin", implementation), /claimed by both fixture-plugin and competing-plugin/);
    release();
    assert.equal(registry.materializerFor("fixture"), null);
    const replacement = registry.register("replacement-plugin", implementation);
    release();
    assert.ok(registry.materializerFor("fixture"), "a stale release cannot remove a later registration");
    replacement();
});
