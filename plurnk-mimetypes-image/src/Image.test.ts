import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Image from "./Image.ts";

const handler = (mimetype: string, extensions: readonly string[]): Image => new Image({ mimetype, glyph: "🖼️", extensions });
const png = handler("image/png", [".png"]);
const jpeg = handler("image/jpeg", [".jpg", ".jpeg"]);
const gif = handler("image/gif", [".gif"]);
const webp = handler("image/webp", [".webp"]);

// Headers only: the handler decodes nothing, so a header is a complete specimen.
const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x02, 0x80, 0x00, 0x00, 0x01, 0xe0, // 640 × 480
    0x08, 0x06, 0x00, 0x00, 0x00,
]);
const JPEG = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, // APP0, 16 bytes
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x01, 0x2c, 0x03, // SOF0: height 100, width 300
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00, 0x80, 0x00, 0x00]); // 16 × 32
const WEBP_VP8X = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x1e, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0x03, 0x00, 0x7f, 0x02, 0x00, // canvas 1024 × 640 (minus one)
]);

describe("Image — validate", () => {
    it("accepts each format by its header magic and refuses garbage", () => {
        assert.doesNotThrow(() => png.validate(PNG));
        assert.doesNotThrow(() => jpeg.validate(JPEG));
        assert.doesNotThrow(() => gif.validate(GIF));
        assert.doesNotThrow(() => webp.validate(WEBP_VP8X));
        assert.throws(() => png.validate(JPEG), /Not a PNG image/);
        assert.throws(() => jpeg.validate(new Uint8Array([0, 1, 2])), /Not a JPEG image/);
        assert.throws(() => gif.validate(PNG), /Not a GIF image/);
        assert.throws(() => webp.validate(GIF), /Not a WebP image/);
    });
    it("refuses text content: a binary handler receives bytes", () => {
        assert.throws(() => png.validate("not bytes" as never), /Uint8Array/);
    });
});

describe("Image — facts and body", () => {
    it("reads dimensions from each header and states them as the body", () => {
        assert.deepEqual(png.facts(PNG), { format: "png", width: 640, height: 480, bytes: PNG.length });
        assert.equal(png.content(PNG), `PNG image, 640×480 px, ${PNG.length} bytes`);
        assert.deepEqual(jpeg.facts(JPEG), { format: "jpeg", width: 300, height: 100, bytes: JPEG.length });
        assert.deepEqual(gif.facts(GIF), { format: "gif", width: 16, height: 32, bytes: GIF.length });
        assert.deepEqual(webp.facts(WEBP_VP8X), { format: "webp", width: 1024, height: 640, bytes: WEBP_VP8X.length });
    });
    it("states size alone when a header carries no dimensions", () => {
        const truncated = PNG.subarray(0, 12);
        assert.deepEqual(png.facts(truncated), { format: "png", width: null, height: null, bytes: 12 });
        assert.equal(png.content(truncated), "PNG image, 12 bytes");
    });
    it("the summary is the body and deepJson is the facts", () => {
        assert.equal(gif.summary(GIF), gif.content(GIF));
        assert.deepEqual(gif.deepJson(GIF), gif.facts(GIF));
    });
});
