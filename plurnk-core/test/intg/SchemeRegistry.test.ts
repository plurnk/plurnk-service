import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";

test("{§extension-namespace-arbitration} SchemeRegistry: constructor registers the engine-owned scheme roster", () => {
    const r = new SchemeRegistry();
    assert.deepEqual(r.list().toSorted(), ["exec", "file", "log", "message", "note", "ops", "reasoning", "worker"], "the engine roster is exact; skill belongs to the daemon's skills lifecycle");
});

test("{§extension-namespace-arbitration} SchemeRegistry: register(name) on already-registered name fails hard", () => {
    const r = new SchemeRegistry();
    assert.throws(
        () => r.register("worker", new Worker()),
        /scheme name 'worker' is reserved by core package '@plurnk\/plurnk-service'; programmatic scheme 'worker' cannot claim it/,
    );
});

test("{§manifest-capability-traits} SchemeRegistry exposes scheme traits without owning capability admission", () => {
    const r = new SchemeRegistry();
    class Http {
        static manifest: SchemeManifest = {
            name: "https",
            channels: {},
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            traits: ["web"],
        };
    }
    r.register("https", new Http());
    assert.deepEqual(r.manifestFor("https")?.traits, ["web"]);
    assert.equal(r.has("https"), true, "registration is topology; CapabilityResolver owns admission");
});
