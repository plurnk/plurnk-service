import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent } from "@plurnk/plurnk-mimetypes";

// image/* handler: PNG, JPEG, GIF, WebP. Binary mimetypes — the framework hands the bytes in
// as a Uint8Array. Nothing is decoded: the format's header alone yields the facts a reader
// needs (format, pixel dimensions, byte size), which is the model-facing body. The picture
// itself reaches a model that can see it as a native image part of the packet, built by the
// service from the source bytes ({§mimetype-image} in the framework SPEC).

export interface ImageFacts {
    readonly format: "png" | "jpeg" | "gif" | "webp";
    readonly width: number | null;
    readonly height: number | null;
    readonly bytes: number;
}

const FORMAT_BY_MIMETYPE: Record<string, ImageFacts["format"]> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
};

const LABEL: Record<ImageFacts["format"], string> = { png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP" };

const startsWith = (bytes: Uint8Array, magic: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + magic.length && magic.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
const be16 = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const be32 = (bytes: Uint8Array, at: number): number => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const le16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const le24 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);

// Header dimensions per format; null when the header does not carry them where expected.
const dimensions = (format: ImageFacts["format"], bytes: Uint8Array): { width: number; height: number } | null => {
    switch (format) {
        case "png":
            // Signature (8) + IHDR length (4) + "IHDR" (4) → width, height as big-endian 32-bit.
            return bytes.length >= 24 && ascii(bytes, 12, 4) === "IHDR"
                ? { width: be32(bytes, 16), height: be32(bytes, 20) }
                : null;
        case "gif":
            return bytes.length >= 10 ? { width: le16(bytes, 6), height: le16(bytes, 8) } : null;
        case "webp": {
            if (bytes.length < 30) return null;
            const chunk = ascii(bytes, 12, 4);
            if (chunk === "VP8 ") return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
            if (chunk === "VP8L") {
                const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
                return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
            }
            if (chunk === "VP8X") return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
            return null;
        }
        case "jpeg": {
            // Walk the marker segments to the first start-of-frame (SOF0..SOF15 except DHT, JPG, DAC).
            let at = 2;
            while (at + 9 <= bytes.length) {
                if (bytes[at] !== 0xff) return null;
                const marker = bytes[at + 1]!;
                if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
                const length = be16(bytes, at + 2);
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
                }
                if (marker === 0xd9 || marker === 0xda) return null;
                at += 2 + length;
            }
            return null;
        }
    }
};

export default class Image extends BaseHandler {
    get format(): ImageFacts["format"] {
        const format = FORMAT_BY_MIMETYPE[this.mimetype];
        if (format === undefined) throw new Error(`Image handler cannot serve ${this.mimetype}.`);
        return format;
    }

    static bytesOf(content: HandlerContent): Uint8Array {
        if (!(content instanceof Uint8Array)) throw new TypeError("Image handler receives binary content as a Uint8Array.");
        return content;
    }

    // Header magic, one format each; a mislabelled file is refused rather than guessed at.
    override validate(content: HandlerContent): void {
        const bytes = Image.bytesOf(content);
        const valid = {
            png: () => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            jpeg: () => startsWith(bytes, [0xff, 0xd8, 0xff]),
            gif: () => bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a"),
            webp: () => bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP",
        }[this.format]();
        if (!valid) throw new SyntaxError(`Not a ${LABEL[this.format]} image: the header magic is absent.`);
    }

    override facts(content: HandlerContent): ImageFacts {
        const bytes = Image.bytesOf(content);
        const size = dimensions(this.format, bytes);
        return { format: this.format, width: size?.width ?? null, height: size?.height ?? null, bytes: bytes.length };
    }

    // The model-facing body: what the header says, nothing decoded.
    override content(content: HandlerContent): string {
        const facts = this.facts(content);
        const size = facts.width === null || facts.height === null ? "" : `, ${facts.width}×${facts.height} px`;
        return `${LABEL[facts.format]} image${size}, ${facts.bytes} bytes`;
    }

    override summary(content: HandlerContent): string {
        return this.content(content);
    }

    override deepJson(content: HandlerContent): ImageFacts {
        return this.facts(content);
    }
}
