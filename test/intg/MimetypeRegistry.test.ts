import test from "node:test";
import assert from "node:assert/strict";
import MimetypeRegistry from "../../src/core/MimetypeRegistry.ts";
import TextPlain from "../../src/mimetypes/TextPlain.ts";
import TextMarkdown from "@plurnk/plurnk-mimetypes-text-markdown";
import type { MimetypeHandler } from "../../src/mimetypes/_types.ts";

class FakeXml implements MimetypeHandler {
    readonly mimetype = "application/xml";
    readonly glyph = "📰";
    validate(_content: string): void {}
    symbols(_content: string): string { return ""; }
    preview(content: string, budget: number): string { return content.slice(0, budget); }
}

// Builds a registry pre-populated with the standard bundled+discovered set
// used by most tests: text/plain (bundled) + text/markdown (via the npm
// package, which the daemon's plugin scan registers in production).
const standardRegistry = (): MimetypeRegistry => {
    const r = new MimetypeRegistry();
    r.register(new TextMarkdown());
    return r;
};

test("MimetypeRegistry: constructor registers ONLY text/plain (universal fallback)", () => {
    const r = new MimetypeRegistry();
    assert.deepEqual(r.list(), ["text/plain"]);
});

test("MimetypeRegistry: get returns the registered handler instance", () => {
    const r = standardRegistry();
    assert.ok(r.get("text/plain") instanceof TextPlain);
    assert.ok(r.get("text/markdown") instanceof TextMarkdown);
});

test("MimetypeRegistry: get throws on unregistered mimetype (no defaults)", () => {
    const r = new MimetypeRegistry();
    assert.throws(
        () => r.get("application/xml"),
        /no handler registered for mimetype 'application\/xml'/,
    );
});

test("MimetypeRegistry: has reflects registration state without throwing", () => {
    const r = standardRegistry();
    assert.equal(r.has("text/plain"), true);
    assert.equal(r.has("text/markdown"), true);
    assert.equal(r.has("application/xml"), false);
});

test("MimetypeRegistry: register on duplicate mimetype fails hard", () => {
    const r = new MimetypeRegistry();
    assert.throws(
        () => r.register(new TextPlain()),
        /mimetype 'text\/plain' is already registered/,
    );
});

test("MimetypeRegistry: register accepts new handlers", () => {
    const r = new MimetypeRegistry();
    r.register(new FakeXml());
    assert.equal(r.has("application/xml"), true);
    assert.ok(r.get("application/xml") instanceof FakeXml);
});

test("MimetypeRegistry: list is sorted lexicographically", () => {
    const r = standardRegistry();
    r.register(new FakeXml());
    assert.deepEqual(r.list(), ["application/xml", "text/markdown", "text/plain"]);
});

test("MimetypeRegistry: bundled+discovered handlers expose required glyphs", () => {
    const r = standardRegistry();
    assert.equal(r.get("text/plain").glyph, "📄");
    assert.equal(r.get("text/markdown").glyph, "📝");
});

test("MimetypeRegistry: two independent registries don't share state", () => {
    const r1 = new MimetypeRegistry();
    const r2 = new MimetypeRegistry();
    r1.register(new FakeXml());
    assert.equal(r1.has("application/xml"), true);
    assert.equal(r2.has("application/xml"), false);
});
