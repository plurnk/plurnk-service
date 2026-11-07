import test from "node:test";
import assert from "node:assert/strict";
import Manifest from "./Manifest.ts";
import MessageAttachments from "./MessageAttachments.ts";
import OutputScheme from "./OutputScheme.ts";
import type { ResourceCaps } from "./ctx.ts";
import type { SchemeManifest } from "./types.ts";

const manifest = (name: string): SchemeManifest => ({
    name,
    authority: "namespace",
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

test("{§manifest} Manifest.of resolves static and instance manifests", () => {
    class Static { static manifest = manifest("static"); }
    assert.equal(Manifest.of(new Static(), "static").name, "static");
    assert.equal(Manifest.of({ manifest: manifest("dynamic") }, "dynamic").name, "dynamic");
});

test("{§manifest} Manifest.of rejects missing and mismatched identities", () => {
    assert.throws(() => Manifest.of({}, "missing"), /must declare a static or instance manifest/);
    assert.throws(() => Manifest.of({ manifest: manifest("other") }, "expected"), /identity mismatch/);
});

test("{§manifest} Manifest.of validates dispatch-critical fields", () => {
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("authority"), authority: "guess" } }, "authority"),
        /manifest\.authority must be namespace or resource/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("unsafe"), writableBy: ["system"] } }, "unsafe"),
        /writableBy/,
    );
    assert.doesNotThrow(
        () => Manifest.of({ manifest: { ...manifest("unwritten"), writableBy: [] } }, "unwritten"),
        "an empty writer set declares a scheme no operation writes",
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
    assert.doesNotThrow(() => Manifest.of({ manifest: manifest("resource") }));
});

test("{§manifest} a dynamic default channel composes with typed sibling channels", () => {
    for (const channels of [{}, { readable: "text/markdown" }]) {
        const declared = { ...manifest("dynamic"), channels };
        assert.equal(Manifest.of({ manifest: declared }), declared);
        assert.equal(declared.defaultChannel, "body");
        assert.equal(Object.hasOwn(declared.channels, "body"), false);
    }
    assert.throws(
        () => Manifest.of({ manifest: { ...manifest("case"), channels: {}, defaultChannel: "Body" } }),
        /defaultChannel.*lowercase/,
    );
});

test("{§manifest} Manifest.of admits only declared top-level fields", () => {
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
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, textEditScopes: "yes" } }, "owner"),
        /textEditScopes.*boolean/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, lineAnchors: "yes" } }, "owner"),
        /lineAnchors.*boolean/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, undeclared: true } }, "owner"),
        /unknown field 'undeclared'/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, glyph: "" } }, "owner"),
        /glyph.*non-empty/,
    );
});

test("{§op-methods-op-dispatch}: message attachments validate before acquisition and preserve selection order", async () => {
    const calls: (readonly string[])[] = [];
    const resources: ResourceCaps = { async capture(targets) { calls.push(targets); return { attachments: [] }; } };
    for (const value of [false, 7, "file.txt", [null], [""], [{}]]) {
        const result = await MessageAttachments.capture(value as unknown as readonly string[], resources, "scheme:test");
        assert.ok("failure" in result);
        assert.equal(result.failure.status, 400);
        assert.match(result.failure.problem!.type, /attachments-invalid$/u);
    }
    assert.deepEqual(calls, [], "invalid options never acquire a resource");
    assert.deepEqual(await MessageAttachments.capture(null, resources, "scheme:test"), { attachments: [] });
    assert.deepEqual(await MessageAttachments.capture([], resources, "scheme:test"), { attachments: [] });
    await MessageAttachments.capture(["b", "a#readable"], resources, "scheme:test");
    assert.deepEqual(calls, [["b", "a#readable"]]);
});

test("{§op-methods-op-dispatch}: receipts contain descriptors, not payloads", () => {
    assert.deepEqual(MessageAttachments.receipts([{ name: "report.pdf", mediaType: "application/pdf", contentHash: "hash", target: "report.pdf", bytes: new Uint8Array([42]) }]), [
        { name: "report.pdf", mediaType: "application/pdf", contentHash: "hash", target: "report.pdf" },
    ]);
});

test("{§network-address} manifestFromRuntime: derives a read-only-output manifest from the runtime decl", () => {
    const runtime = {
        name: "sh", glyph: "🐚",
        channels: { stdout: "text/plain", stderr: "text/plain" }, defaultChannel: "stdout",
    };
    const m = OutputScheme.manifestFromRuntime(runtime);
    assert.equal(m.name, "sh");
    assert.equal(m.glyph, "🐚");
    assert.deepEqual(m.channels, { stdout: "text/plain", stderr: "text/plain" });
    assert.equal(m.defaultChannel, "stdout");
    assert.equal(m.category, "data");
    assert.deepEqual(m.writableBy, []);
    assert.equal(m.volatile, true);
    assert.equal(m.modelVisible, true);
});

test("{§network-address} manifestFromRuntime: presentation is optional", () => {
    const m = OutputScheme.manifestFromRuntime({ name: "bc", channels: { stdout: "text/plain" }, defaultChannel: "stdout" });
    assert.equal(m.name, "bc");
    assert.equal(m.glyph, undefined);
    assert.equal(m.modelVisible, true);
});

test("{§manifest} manifestFromRuntime preserves policy traits without interpreting them", () => {
    const declared = OutputScheme.manifestFromRuntime({
        name: "asker",
        channels: { results: "text/plain" },
        defaultChannel: "results",
        traits: ["interaction"],
    });
    assert.deepEqual(declared.traits, ["interaction"]);
    assert.equal(
        OutputScheme.manifestFromRuntime({ name: "plain", channels: {}, defaultChannel: "" }).traits,
        undefined,
    );
});
