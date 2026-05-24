import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol, Preview } from "@plurnk/plurnk-mimetypes";

// application/pdf handler. Binary mimetype — receives Uint8Array content.
// validate() does a sync header-magic check; preview() walks the PDF's
// outline (bookmark TOC) and emits each entry as a heading symbol nested by
// outline depth. PDFs without an outline fall back to the document's
// metadata title (if present); without that, preview is null and the
// channel is dark in the radar.
//
// We deliberately do NOT extract the full text body. Per the v0.5.0
// framework contract, the preview is a structural signal — never a body
// slice. A body slice would teach LLM consumers to read the preview as
// content and skip the actual fetch.
//
// Why a header-magic validate and not a full parse: pdfjs transfers the
// underlying ArrayBuffer during getDocument(), so a parse in validate()
// would compete with the same parse in preview() and detach the buffer.
// The header check catches non-PDF content cheaply without touching the
// bytes preview() will need.
//
// Salvage pattern from rummy.web/WebFetcher.js: pdfjs-dist legacy build
// (Node-compatible), isEvalSupported:false (no PDF JS execution),
// verbosity:0 (silences "standardFontDataUrl not provided" noise).

// "%PDF-" — every PDF starts with this 5-byte magic, optionally preceded by
// a UTF-8 BOM that some tools insert.
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

interface OutlineItem {
    title: string;
    items?: OutlineItem[];
}

export default class ApplicationPdf extends BaseHandler {
    override validate(content: string | Uint8Array): void {
        const bytes = toBytes(content);
        const offset = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
        if (!startsWith(bytes.subarray(offset), PDF_MAGIC)) {
            throw new SyntaxError("Not a PDF: missing %PDF- header");
        }
    }

    override async preview(content: string | Uint8Array): Promise<Preview> {
        const bytes = toBytes(content);
        let symbols: MimeSymbol[];
        try {
            symbols = await extractStructure(bytes);
        } catch {
            return null;
        }
        if (symbols.length === 0) return null;
        return { kind: "symbols", symbols };
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
    return new TextEncoder().encode(content);
}

async function extractStructure(bytes: Uint8Array): Promise<MimeSymbol[]> {
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
        const symbols: MimeSymbol[] = [];
        const outline = (await doc.getOutline()) as OutlineItem[] | null;
        if (outline !== null && outline.length > 0) {
            const counter = { n: 1 };
            walkOutline(outline, 1, symbols, counter);
        }
        if (symbols.length === 0) {
            // Outline missing or empty — try the document Title from the PDF
            // Info dict. Most authored PDFs have one even when they lack an
            // outline; scanned/unstructured PDFs will have neither.
            const meta = await doc.getMetadata();
            const info = (meta.info ?? {}) as { Title?: string };
            if (typeof info.Title === "string" && info.Title.trim().length > 0) {
                symbols.push({
                    name: info.Title.trim(),
                    kind: "heading",
                    level: 1,
                    line: 1,
                    endLine: 1,
                });
            }
        }
        return symbols;
    } finally {
        await doc.destroy();
    }
}

// Walk a pdfjs outline (nested bookmark TOC). Each item produces one
// heading symbol; `level` matches outline nesting depth (root items are
// level 1, their children level 2, etc.). PDFs don't have lines, so we
// use a monotonic counter for `line` so format()'s downstream tree-builder
// gets unique, ordered positions.
function walkOutline(
    items: OutlineItem[],
    level: number,
    out: MimeSymbol[],
    counter: { n: number },
): void {
    for (const item of items) {
        const title = (item.title ?? "").trim();
        if (title.length > 0) {
            const line = counter.n;
            counter.n += 1;
            out.push({
                name: title,
                kind: "heading",
                level: Math.min(level, 6),
                line,
                endLine: line,
            });
        }
        if (item.items && item.items.length > 0) {
            walkOutline(item.items, level + 1, out, counter);
        }
    }
}
