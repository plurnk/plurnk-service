import { BaseHandler, fitContent } from "@plurnk/plurnk-mimetypes";

// application/pdf handler. Binary mimetype — receives Uint8Array content.
// validate() does a sync header-magic check; preview() does the full parse
// via pdfjs-dist and returns the extracted text.
//
// Why a header-magic validate and not a full parse: pdfjs transfers the
// underlying ArrayBuffer for performance during getDocument(). If validate()
// also called pdfjs, it would compete with preview()'s call on the same
// buffer — second call sees a detached/emptied buffer and returns nothing.
// The header check catches non-PDF content (wrong format, garbage bytes,
// empty input) without touching the bytes preview() will need.
//
// Salvage pattern from rummy.web/WebFetcher.js:
//   - pdfjs-dist legacy build (Node-compatible)
//   - isEvalSupported:false (no PDF JS execution)
//   - verbosity:0 (silences "standardFontDataUrl not provided" noise;
//     we read text streams directly and don't render glyphs)
//   - Pages joined with "\n\n"
//
// symbols() stays empty — PDFs have no exposed structural outline in the
// duck contract today.

// "%PDF-" — every PDF starts with this 5-byte magic, optionally preceded by
// a UTF-8 BOM that some tools insert.
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

export default class ApplicationPdf extends BaseHandler {
    validate(content: string | Uint8Array): void {
        const bytes = toBytes(content);
        const offset = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
        if (!startsWith(bytes.subarray(offset), PDF_MAGIC)) {
            throw new SyntaxError("Not a PDF: missing %PDF- header");
        }
    }

    async preview(content: string | Uint8Array, budget: number): Promise<string> {
        const bytes = toBytes(content);
        let text: string;
        try {
            text = await extractAllText(bytes);
        } catch {
            return "";
        }
        return fitContent(text, budget, this.tokenize);
    }
}

function startsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
    if (haystack.length < needle.length) return false;
    for (let i = 0; i < needle.length; i += 1) {
        if (haystack[i] !== needle[i]) return false;
    }
    return true;
}

function toBytes(content: string | Uint8Array): Uint8Array {
    if (content instanceof Uint8Array) return content;
    // Treat string content as latin1 byte sequence — preserves bytes round-tripped
    // through utf-8 only if every byte fits in 0–255, but consumers passing inline
    // string content for binary mimetypes are responsible for the encoding choice.
    return new TextEncoder().encode(content);
}

async function extractAllText(bytes: Uint8Array): Promise<string> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // isEvalSupported and verbosity are real pdfjs runtime parameters but
    // aren't declared in DocumentInitParameters' published .d.ts — cast through
    // unknown to set them without disabling type safety wholesale.
    const params = {
        data: bytes,
        isEvalSupported: false,
        verbosity: 0,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0];
    const doc = await pdfjs.getDocument(params).promise;
    try {
        const pages: string[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            const pageText = tc.items
                .map((it: unknown) => (it as { str?: string }).str ?? "")
                .join(" ");
            pages.push(pageText);
            page.cleanup();
        }
        return pages.join("\n\n");
    } finally {
        await doc.destroy();
    }
}
