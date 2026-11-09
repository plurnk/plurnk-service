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

describe("{§mimetype-binary-input} validate checks the header magic and nothing else", () => {
    it("{§mimetype-binary-input} accepts each format by its header magic and refuses garbage", () => {
        assert.doesNotThrow(() => png.validate(PNG));
        assert.doesNotThrow(() => jpeg.validate(JPEG));
        assert.doesNotThrow(() => gif.validate(GIF));
        assert.doesNotThrow(() => webp.validate(WEBP_VP8X));
        assert.throws(() => png.validate(JPEG), /Not a PNG image/);
        assert.throws(() => jpeg.validate(new Uint8Array([0, 1, 2])), /Not a JPEG image/);
        assert.throws(() => gif.validate(PNG), /Not a GIF image/);
        assert.throws(() => webp.validate(GIF), /Not a WebP image/);
    });
    it("{§mimetype-binary-input} refuses text content: a binary handler receives bytes", () => {
        assert.throws(() => png.validate("not bytes"), /Uint8Array/);
    });
});

describe("{§mimetype-binary-input} the body and deepJson are the header's facts", () => {
    it("{§mimetype-binary-input} reads dimensions from each header and states them as the body", () => {
        assert.deepEqual(png.facts(PNG), { format: "png", width: 640, height: 480, bytes: PNG.length });
        assert.equal(png.content(PNG), `PNG image, 640×480 px, ${PNG.length} bytes`);
        assert.deepEqual(jpeg.facts(JPEG), { format: "jpeg", width: 300, height: 100, bytes: JPEG.length });
        assert.deepEqual(gif.facts(GIF), { format: "gif", width: 16, height: 32, bytes: GIF.length });
        assert.deepEqual(webp.facts(WEBP_VP8X), { format: "webp", width: 1024, height: 640, bytes: WEBP_VP8X.length });
    });
    it("{§mimetype-binary-input} states size alone when a header carries no dimensions", () => {
        const truncated = PNG.subarray(0, 12);
        assert.deepEqual(png.facts(truncated), { format: "png", width: null, height: null, bytes: 12 });
        assert.equal(png.content(truncated), "PNG image, 12 bytes");
    });
    it("{§mimetype-binary-input} the summary is the body and deepJson is the facts", () => {
        assert.equal(gif.summary(GIF), gif.content(GIF));
        assert.deepEqual(gif.deepJson(GIF), gif.facts(GIF));
    });
    it("{§mimetype-binary-input} extracts EXIF header tags across JPEG, PNG, and WebP without decoding pixels", async () => {
        const desc = Buffer.from("Eagle Palms Emblem (p. 282)\0", "utf8");
        const docName = Buffer.from("awards/eagle-palms.md#eagle-palms\0", "utf8");
        const comment = Buffer.concat([
            Buffer.from("ASCII\0\0\0", "ascii"),
            Buffer.from('{"kind":"award-emblem","slug":"eagle-palms"}', "utf8"),
        ]);
        const tiff = Buffer.alloc(50 + desc.length + docName.length + comment.length);
        tiff.write("II", 0, "ascii");
        tiff.writeUInt16LE(0x002a, 2);
        tiff.writeUInt32LE(8, 4);
        tiff.writeUInt16LE(3, 8);
        // 0x010d DocumentName
        tiff.writeUInt16LE(0x010d, 10);
        tiff.writeUInt16LE(2, 12);
        tiff.writeUInt32LE(docName.length, 14);
        tiff.writeUInt32LE(50, 18);
        // 0x010e ImageDescription
        tiff.writeUInt16LE(0x010e, 22);
        tiff.writeUInt16LE(2, 24);
        tiff.writeUInt32LE(desc.length, 26);
        tiff.writeUInt32LE(50 + docName.length, 30);
        // 0x9286 UserComment
        tiff.writeUInt16LE(0x9286, 34);
        tiff.writeUInt16LE(7, 36);
        tiff.writeUInt32LE(comment.length, 38);
        tiff.writeUInt32LE(50 + docName.length + desc.length, 42);
        tiff.writeUInt32LE(0, 46);
        docName.copy(tiff, 50);
        desc.copy(tiff, 50 + docName.length);
        comment.copy(tiff, 50 + docName.length + desc.length);

        const paddedLen = tiff.length + (tiff.length % 2);
        const exifChunk = Buffer.alloc(8 + paddedLen);
        exifChunk.write("EXIF", 0, "ascii");
        exifChunk.writeUInt32LE(tiff.length, 4);
        tiff.copy(exifChunk, 8);
        const webpWithExif = Buffer.concat([Buffer.from(WEBP_VP8X), exifChunk]);
        webpWithExif.writeUInt32LE(webpWithExif.length - 8, 4);

        const facts = webp.facts(webpWithExif);
        assert.deepEqual(facts.exif, {
            DocumentName: "awards/eagle-palms.md#eagle-palms",
            ImageDescription: "Eagle Palms Emblem (p. 282)",
            UserComment: '{"kind":"award-emblem","slug":"eagle-palms"}',
        });
        assert.equal(
            webp.summary(webpWithExif),
            `WebP image, 1024×640 px, ${webpWithExif.length} bytes — Eagle Palms Emblem (p. 282)`,
        );
        assert.equal(
            webp.content(webpWithExif),
            [
                `WebP image, 1024×640 px, ${webpWithExif.length} bytes — Eagle Palms Emblem (p. 282)`,
                "DocumentName: awards/eagle-palms.md#eagle-palms",
                'UserComment: {"kind":"award-emblem","slug":"eagle-palms"}',
            ].join("\n"),
        );
        const matches = await webp.query(webpWithExif, "regex", "award-emblem");
        assert.equal(matches.length, 1);
        assert.equal(matches[0]?.regions?.[0]?.startLine, 3);
    });
});
