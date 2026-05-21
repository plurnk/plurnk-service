import { BaseHandler, fitContent } from "@plurnk/plurnk-mimetypes";

// application/pdf handler. Binary mimetype — receives Uint8Array content.
// Validates the PDF parses cleanly and extracts text via pdfjs-dist; the
// preview is the joined text content, budgeted via the framework's
// fitContent.
//
// Salvage pattern from rummy.web/WebFetcher.js:
//   - pdfjs-dist legacy build (Node-compatible)
//   - isEvalSupported:false (no PDF JS execution)
//   - verbosity:0 (silences "standardFontDataUrl not provided" noise;
//     we read text streams directly and don't render glyphs)
//   - Pages joined with "\n\n"
//   - Image-only PDFs (scans without OCR) parse cleanly but produce no
//     text — surfaced as a validate error, not an empty preview
//
// symbols() stays empty — PDFs have no exposed structural outline in the
// duck contract today. (A future enhancement could read the PDF's
// document outline / bookmarks as heading symbols, but the simpler
// "extracted text as preview" path covers the LLM-consumption use case
// cleanly.)
export default class ApplicationPdf extends BaseHandler {
    async validate(content: string | Uint8Array): Promise<void> {
        const bytes = toBytes(content);
        const text = await extractAllText(bytes);
        if (text.trim() === "") {
            throw new Error("PDF has no extractable text (image-only scan, or encrypted/protected document)");
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
