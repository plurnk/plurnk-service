import {
    BaseHandler,
    buildJsonOutline,
    queryJsonpathObject,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import type {
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";
import type { HandlerContent } from "@plurnk/plurnk-mimetypes";

// application/pdf handler. Binary mimetype — receives Uint8Array content.
//
// validate() does a sync header-magic check; preview() walks the PDF's
// outline (bookmark TOC) and emits each entry as a heading symbol nested by
// outline depth. PDFs without an outline fall back to the document's
// metadata title (if present); without that, preview is null and the
// channel is dark in the radar.
//
// toText() extracts the full PDF body via pdfjs.getTextContent and joins the
// pages. This text is used for body-matcher query operations (regex and
// glob) — the active body-read path, NOT the passive preview/radar path.
// The structural-only preview rule applies to preview, not query.
//
// We deliberately do NOT use extracted text in the preview pipeline. Per the
// v0.5.0 framework contract, the preview is a structural signal — never a
// body slice. A body slice would teach LLM consumers to read the preview as
// content and skip the actual fetch. Query is different: the consumer
// explicitly asked for the body match.
//
// Why a header-magic validate and not a full parse: pdfjs transfers the
// underlying ArrayBuffer during getDocument(), so a parse in validate()
// would compete with the same parse in preview() and detach the buffer.
// The header check catches non-PDF content cheaply without touching the
// bytes preview() will need.
//
// Caller note: pdfjs detaches the underlying ArrayBuffer per call. Callers
// should not reuse the same Uint8Array across preview() and query() calls;
// the framework's orchestrator reads the file fresh per call, which avoids
// the issue.
//
// All pdfjs access goes through withDocument() with the hardened, render-free
// loadParams() (no script execution, no fonts, no offscreen canvas, no external
// fetch) and DoS caps — see those definitions below. pdfjs-dist legacy build
// (Node-compatible).

// "%PDF-" — every PDF starts with this 5-byte magic, optionally preceded by
// a UTF-8 BOM that some tools insert.
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

// Resource caps (DoS resistance — decompression bombs, pathological page
// counts). A PDF over the byte cap never reaches the parser; text extraction
// is bounded to the page cap (the document still parses, we just stop reading).
// Both degrade through the handler's existing per-channel error policy. Read at
// call time and overridable via env for operators on tighter/looser budgets
// (mirrors the ecosystem's PLURNK_* knob convention).
const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TEXT_PAGES = 5000;

function envCap(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

interface OutlineItem {
    title: string;
    items?: OutlineItem[];
}

// Hardened, render-free getDocument parameters. This handler extracts text and
// structure only — it never rasterizes a page — so the native @napi-rs/canvas
// path that pdfjs lazy-`require`s (only inside page.render()) is never reached,
// and a missing/broken canvas binary cannot crash detect() or the read path
// (plurnk-mimetypes#38). The flags below make that posture explicit and shut
// every active-content / external-resource door:
//   isEvalSupported:false            — no embedded-PDF JavaScript execution
//   disableFontFace / useSystemFonts — no font rendering, no system font access
//   isOffscreenCanvasSupported:false — never take an (offscreen) canvas path
//   disableAutoFetch / disableStream — data is fully in-memory; no external fetch
function loadParams(bytes: Uint8Array): Record<string, unknown> {
    return {
        data: bytes,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        isOffscreenCanvasSupported: false,
        disableAutoFetch: true,
        disableStream: true,
        verbosity: 0,
    };
}

// Single hardened entry: cap → harden → parse → guaranteed teardown. Every
// pdfjs access in this handler goes through here (one security surface, not
// three). Over-cap input throws before the parser is touched; callers route
// that through their per-channel degrade policy.
async function withDocument<T>(
    bytes: Uint8Array,
    use: (doc: PdfDocument) => Promise<T>,
): Promise<T> {
    const maxBytes = envCap("PLURNK_PDF_MAX_BYTES", DEFAULT_MAX_PDF_BYTES);
    if (bytes.byteLength > maxBytes) {
        throw new RangeError(`PDF exceeds ${maxBytes}-byte cap (${bytes.byteLength})`);
    }
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument(loadParams(bytes) as Parameters<typeof pdfjs.getDocument>[0]);
    const doc = (await loadingTask.promise) as unknown as PdfDocument;
    try {
        return await use(doc);
    } finally {
        await loadingTask.destroy();
    }
}

interface PdfDocument {
    numPages: number;
    getOutline(): Promise<unknown>;
    getMetadata(): Promise<{ info?: unknown }>;
    getPage(i: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }>;
}

export default class ApplicationPdf extends BaseHandler {
    override validate(content: string | Uint8Array): void {
        const bytes = toBytes(content);
        const offset = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
        if (!startsWith(bytes.subarray(offset), PDF_MAGIC)) {
            throw new SyntaxError("Not a PDF: missing %PDF- header");
        }
    }

    // Symbols channel: the outline (bookmark TOC) plus the metadata Title
    // fallback. PDFs without either are honestly empty — the body remains
    // reachable via toText (regex/glob queries). Parse failures route to
    // empty symbols per the handler error policy.
    override async extractRaw(content: HandlerContent): Promise<MimeSymbol[]> {
        const bytes = toBytes(content);
        try {
            return await extractStructure(bytes);
        } catch {
            return [];
        }
    }

    // Deep-channel (issue #10). PDF's structural content is its outline (the
    // bookmark TOC); pages are the atomic addressable units. We expose:
    //   { type: 'document', line: 1, endLine: <pageCount>,
    //     children: [<outline items as nested { type: 'outline_item', name, line, endLine, children? }>] }
    //
    // Returns null if the PDF has no outline (which is common — many PDFs
    // ship without bookmarks). Plurnk-service will see a null deepJson and
    // not store a deep-channel for those entries; that's the right outcome
    // since the content isn't xpath-queryable in any meaningful way.
    override async deepJson(content: HandlerContent): Promise<unknown> {
        const bytes = toBytes(content);
        let symbols: MimeSymbol[];
        try {
            symbols = await extractStructure(bytes);
        } catch {
            return null;
        }
        if (symbols.length === 0) return null;
        // Build a containment-nested tree from the symbol list (the outline
        // items already carry headings/levels appropriate for jsonpath
        // navigation by name).
        return {
            type: "document",
            line: 1,
            endLine: symbols.reduce((m, s) => Math.max(m, s.endLine), 1),
            children: symbols.map((s) => ({
                type: "outline_item",
                name: s.name,
                level: s.level,
                line: s.line,
                endLine: s.endLine,
            })),
        };
    }

    protected override async toText(content: string | Uint8Array): Promise<string> {
        if (typeof content === "string") return content;
        try {
            return await extractAllText(content);
        } catch (cause) {
            throw new QueryParseFailureError({ mimetype: this.mimetype, cause });
        }
    }

    // Override jsonpath dispatch because PDF's structural extraction is async
    // (pdfjs is async-only) and can't flow through BaseHandler's sync
    // extractRaw → outline path. We replicate the outline + jsonpath
    // composition directly here for the jsonpath case; everything else falls
    // through to the inherited defaults.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const bytes = toBytes(content);
            let symbols: MimeSymbol[];
            try {
                symbols = await extractStructure(bytes);
            } catch {
                return [];
            }
            return queryJsonpathObject(buildJsonOutline(symbols), pattern);
        }
        return super.query(content, dialect, pattern, flags);
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
    return withDocument(bytes, (doc) => collectSymbols(doc));
}

async function collectSymbols(doc: { getOutline: () => Promise<unknown>; getMetadata: () => Promise<{ info?: unknown }> }): Promise<MimeSymbol[]> {
    const symbols: MimeSymbol[] = [];
    const outline = (await doc.getOutline()) as OutlineItem[] | null;
    if (outline !== null && outline.length > 0) {
        const counter = { n: 1 };
        walkOutline(outline, 1, symbols, counter);
    }
    if (symbols.length === 0) {
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
}

async function extractAllText(bytes: Uint8Array): Promise<string> {
    return withDocument(bytes, (doc) => readAllPagesText(doc));
}

async function readAllPagesText(doc: PdfDocument): Promise<string> {
    const pages: string[] = [];
    // Bound the read — a multi-million-page PDF can't pin the event loop here.
    // The cap is well past any real document.
    const limit = Math.min(doc.numPages, envCap("PLURNK_PDF_MAX_PAGES", DEFAULT_MAX_TEXT_PAGES));
    for (let i = 1; i <= limit; i += 1) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const pageText = tc.items
            .map((it: unknown) => (it as { str?: string }).str ?? "")
            .join(" ");
        pages.push(pageText);
        page.cleanup();
    }
    return pages.join("\n\n");
}

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
