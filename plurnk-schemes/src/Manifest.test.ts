import test from "node:test";
import assert from "node:assert/strict";
import Manifest from "./Manifest.ts";
import type { SchemeManifest } from "./types.ts";

const manifest = (name: string): SchemeManifest => ({
    name,
    authority: "namespace",
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    entryOwner: "commons",
    inherit: "none",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

test("Manifest.of resolves static and instance manifests", () => {
    class Static { static manifest = manifest("static"); }
    assert.equal(Manifest.of(new Static(), "static").name, "static");
    assert.equal(Manifest.of({ manifest: manifest("dynamic") }, "dynamic").name, "dynamic");
});

test("Manifest.of rejects missing and mismatched identities", () => {
    assert.throws(() => Manifest.of({}, "missing"), /must declare a static or instance manifest/);
    assert.throws(() => Manifest.of({ manifest: manifest("other") }, "expected"), /identity mismatch/);
});

test("Manifest.of validates dispatch-critical fields", () => {
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("authority"), authority: "guess" } }, "authority"),
        /authority.*namespace.*resource.*owner/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("unsafe"), writableBy: ["system"] } }, "unsafe"),
        /writableBy/,
    );
    assert.doesNotThrow(
        () => Manifest.of({ manifest: { ...manifest("immutable"), writableBy: [] } }, "immutable"),
        "an empty writer set is a valid immutable scheme",
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("channels"), defaultChannel: "missing" } }, "channels"),
        /defaultChannel/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("case"), channels: { Body: "text/plain" }, defaultChannel: "Body" } }, "case"),
        /lowercase channel names/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("null-storage"), storedScheme: null } }, "null-storage"),
        /storedScheme/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("stale-affinity"), flags: { proposes: true } } }, "stale-affinity"),
        /unknown field 'flags'/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("invalid-traits"), traits: ["WEB"] } }, "invalid-traits"),
        /traits.*lowercase/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("duplicate-traits"), traits: ["web", "web"] } }, "duplicate-traits"),
        /traits.*unique/,
    );
    assert.doesNotThrow(
        () => Manifest.of({ manifest: { ...manifest("traits"), traits: ["web", "interaction"] } }, "traits"),
    );
    const { entryOwner: _entryOwner, ...ownerless } = manifest("ownerless");
    assert.throws(
        () => Manifest.of({ manifest: ownerless }, "ownerless"),
        /entryOwner.*commons.*worker.*resolved/,
    );
    const { inherit: _inherit, ...inheritless } = manifest("inheritless");
    assert.throws(
        () => Manifest.of({ manifest: inheritless }, "inheritless"),
        /inherit.*none.*snapshot.*rederive/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("resolved"), entryOwner: "resolved" } }, "resolved"),
        /resolved entry ownership.*resolveEntryAddress/,
    );
    assert.doesNotThrow(() => Manifest.of({
        manifest: { ...manifest("resolved"), entryOwner: "resolved" },
        resolveEntryAddress() {},
    }, "resolved"));
    assert.throws(
        () => Manifest.of({ manifest: {
            ...manifest("logging-owner"),
            category: "logging",
            entryOwner: "worker",
            inherit: "snapshot",
        } }, "logging-owner"),
        /non-data.*must not declare.*entryOwner.*inherit/,
    );
});

test("Manifest.of admits only declared top-level fields", () => {
    const ownerManifest = manifest("owner");
    assert.doesNotThrow(() => Manifest.of({ manifest: ownerManifest }, "owner"));
    assert.equal(
        Manifest.of({ manifest: { ...ownerManifest, glyph: "🦊" } }, "owner").glyph,
        "🦊",
    );
    assert.equal(
        Manifest.of({ manifest: { ...ownerManifest, textEditScopes: true } }, "owner").textEditScopes,
        true,
    );
    assert.equal(
        Manifest.of({ manifest: { ...ownerManifest, lineAnchors: true } }, "owner").lineAnchors,
        true,
    );
    assert.equal(
        Manifest.of({ manifest: { ...ownerManifest, metadataModifier: true } }, "owner").metadataModifier,
        true,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, textEditScopes: "yes" } }, "owner"),
        /textEditScopes.*boolean/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, lineAnchors: "yes" } }, "owner"),
        /lineAnchors.*boolean/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, metadataModifier: "yes" } }, "owner"),
        /metadataModifier.*boolean/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, scope: "worker" } }, "owner"),
        /unknown.*scope/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, glyph: "" } }, "owner"),
        /glyph.*non-empty/,
    );
});
