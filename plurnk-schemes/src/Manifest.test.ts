import test from "node:test";
import assert from "node:assert/strict";
import Manifest from "./Manifest.ts";
import MessageAttachments from "./MessageAttachments.ts";
import MetadataOptions from "./MetadataOptions.ts";
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
        () => Manifest.of({ manifest: { ...ownerManifest, undeclared: true } }, "owner"),
        /unknown field 'undeclared'/,
    );
    assert.throws(
        () => Manifest.of({ manifest: { ...ownerManifest, glyph: "" } }, "owner"),
        /glyph.*non-empty/,
    );
});

test("{§slot-order} MetadataOptions.read retains ordered scalars and objects for their owning contract", () => {
    assert.deepEqual(MetadataOptions.read(null, "message:reply"), { elements: [] });
    assert.deepEqual(MetadataOptions.read(['200,{"attachments":["workspace:///report.txt"]}'], "message:reply"),
        { elements: [200, { attachments: ["workspace:///report.txt"] }] });
    const refused = MetadataOptions.parse(["200"], "scheme:test");
    assert.ok("failure" in refused, "the object-options contract still rejects scalars");
    assert.equal(refused.failure.problem?.type, "https://problems.plurnk.xyz/scheme/test/metadata-invalid");
});

test("{§slot-order} MetadataOptions.parse merges option objects left to right", () => {
    const read = MetadataOptions.parse(['{"a": 1}, {"b": 2, "a": 3}'], "scheme:test");
    assert.deepEqual(read, { options: { a: 3, b: 2 } });
});

test("{§slicer-text-algebra} MetadataOptions.parse fails malformed blocks as the owner's 400 without echoing the input", () => {
    const read = MetadataOptions.parse(['{"secret": '], "scheme:test");
    assert.ok("failure" in read);
    assert.equal(read.failure.status, 400);
    assert.equal(read.failure.problem?.detail, "[metadata] must be a JSON array.");
    const scalar = MetadataOptions.parse(['"cwd"'], "scheme:test");
    assert.ok("failure" in scalar);
    assert.match(String(scalar.failure.problem?.type), /metadata-invalid$/);
    const repeated = MetadataOptions.parse(['{"a": 1}', '{"b": 2}'], "scheme:test");
    assert.ok("failure" in repeated);
    assert.match(String(repeated.failure.problem?.type), /metadata-repeated$/);
});

test("{§manifest}: exactly the declared service keys are withheld from an owner, each surfaced raw", () => {
    assert.deepEqual([...MetadataOptions.SERVICE_KEYS], ["lifetime"]);
    const read = MetadataOptions.parse(['{"cwd": "src", "lifetime": "30m", "other": 1}'], "scheme:test");
    assert.deepEqual(read, { options: { cwd: "src", other: 1 }, lifetime: "30m" });
    assert.deepEqual(MetadataOptions.parse(['{"cwd": "src"}'], "scheme:test"), { options: { cwd: "src" } }, "absent stays absent");
});

test("{§op-methods-op-dispatch}: message metadata validates before acquisition and preserves selection order", async () => {
    const calls: (readonly string[])[] = [];
    const resources: ResourceCaps = { async capture(targets) { calls.push(targets); return { attachments: [] }; } };
    for (const value of [null, false, 7, "file.txt", [null], [""], [{}]]) {
        const result = await MessageAttachments.capture([JSON.stringify({ attachments: value })], resources, "scheme:test");
        assert.ok("failure" in result);
        assert.equal(result.failure.status, 400);
        assert.match(result.failure.problem!.type, /attachments-invalid$/u);
    }
    const unknown = await MessageAttachments.capture(['{"headers":{}}'], resources, "scheme:test");
    assert.ok("failure" in unknown);
    assert.match(unknown.failure.problem!.type, /metadata-unsupported$/u);
    assert.deepEqual(calls, [], "invalid options never acquire a resource");
    assert.deepEqual(await MessageAttachments.capture(null, resources, "scheme:test"), { attachments: [] });
    await MessageAttachments.capture(['{"attachments":["a"]},{"attachments":["b","a#readable"]}'], resources, "scheme:test");
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
