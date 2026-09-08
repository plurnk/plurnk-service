import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent } from "@plurnk/plurnk-mimetypes";

// application/pdf handler. Binary mimetype — the framework hands the bytes in as a Uint8Array.
// Nothing is parsed, extracted, or rendered: the header magic proves the type and a scan of the
// page tree yields the facts a reader needs (page count when the tree is uncompressed, byte size),
// which is the model-facing body. The document itself reaches a model that can read it as a native
// document part of the packet, built by the service from the source bytes ({§mimetype-pdf-facts}).
// A route that accepts no document input reports the attachment unsupported; the model's recourse
// is the workspace's own tools through EXEC (`pdftotext` and the like), never daemon-side extraction.

export interface PdfFacts {
    // The root page tree's `/Count`; null when the tree is inside a compressed object stream.
    readonly pages: number | null;
    readonly bytes: number;
}

// "%PDF-" — every PDF starts with this 5-byte magic, optionally preceded by a UTF-8 BOM.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const UTF8_BOM = [0xef, 0xbb, 0xbf];
// The catalog's page tree root carries the total: `/Type /Pages … /Count N`. Intermediate
// `/Pages` nodes carry their own subtotals, so the largest count is the root's.
const PAGES_NODE = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/gu;
// Only the page tree is scanned, not page content streams; a bound keeps a pathological file cheap.
const SCAN_LIMIT = 8 * 1024 * 1024;

const startsWith = (bytes: Uint8Array, magic: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + magic.length && magic.every((byte, index) => bytes[offset + index] === byte);

const pageCount = (bytes: Uint8Array): number | null => {
    const text = new TextDecoder("latin1").decode(bytes.subarray(0, SCAN_LIMIT));
    let pages: number | null = null;
    for (const match of text.matchAll(PAGES_NODE)) {
        const count = Number(match[1] ?? match[2]);
        if (Number.isSafeInteger(count) && count >= 0 && (pages === null || count > pages)) pages = count;
    }
    return pages;
};

export default class ApplicationPdf extends BaseHandler {
    static bytesOf(content: HandlerContent): Uint8Array {
        if (!(content instanceof Uint8Array)) throw new TypeError("PDF handler receives binary content as a Uint8Array.");
        return content;
    }

    // Header magic; a mislabelled file is refused rather than guessed at.
    override validate(content: HandlerContent): void {
        const bytes = ApplicationPdf.bytesOf(content);
        const valid = startsWith(bytes, PDF_MAGIC) || (startsWith(bytes, UTF8_BOM) && startsWith(bytes, PDF_MAGIC, UTF8_BOM.length));
        if (!valid) throw new SyntaxError("Not a PDF document: the %PDF- header magic is absent.");
    }

    override facts(content: HandlerContent): PdfFacts {
        const bytes = ApplicationPdf.bytesOf(content);
        return { pages: pageCount(bytes), bytes: bytes.length };
    }

    // The model-facing body: what the file says about itself, nothing extracted.
    override content(content: HandlerContent): string {
        const facts = this.facts(content);
        const pages = facts.pages === null ? "" : `, ${facts.pages} page${facts.pages === 1 ? "" : "s"}`;
        return `PDF document${pages}, ${facts.bytes} bytes`;
    }

    override summary(content: HandlerContent): string {
        return this.content(content);
    }

    override deepJson(content: HandlerContent): PdfFacts {
        return this.facts(content);
    }
}
