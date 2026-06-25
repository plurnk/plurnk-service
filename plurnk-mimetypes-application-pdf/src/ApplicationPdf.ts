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
    getPage(i: number): Promise<{
        getTextContent(options?: { includeMarkedContent?: boolean }): Promise<{ items: unknown[] }>;
        getAnnotations?(): Promise<unknown[]>;
        getStructTree?(): Promise<StructNode | null>;
        cleanup(): void;
    }>;
    // Security-signal sources (mature pdfjs APIs). Optional in our local type so
    // a future build that lacks them degrades to "no signal" rather than failing.
    getJSActions?(): Promise<Record<string, unknown> | null>;
    getAttachments?(): Promise<Record<string, unknown> | null>;
    getFieldObjects?(): Promise<Record<string, unknown[]> | null>;
}

// The jsonpath-queryable document model deepJson exposes. Everything pdfjs
// gives us from the document model without rendering: structure (outline),
// metadata, and detect-only security signals. Never executes or extracts
// active content — it reports presence (plurnk-mimetypes#38 posture).
interface PdfDocModel {
    type: "document";
    line: number;
    endLine: number;
    metadata: Record<string, unknown>;
    security: { hasJavaScript: boolean; hasEmbeddedFiles: boolean };
    links: Array<{ url: string; page: number }>;
    forms: Array<{ name: string; value: string; type: string; page: number }>;
    children: Array<{ type: "outline_item"; name: string; level?: number; line: number; endLine: number }>;
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
        // Always-present for a parseable PDF: even outline-less documents carry
        // metadata + security signals, so the deep channel is no longer dark
        // for the common un-bookmarked PDF. null only on a parse failure.
        return await buildDocumentModel(bytes);
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
            // Bookmark-by-name navigation: `$['Chapter 1']['Section 1.1']`. The
            // deepJson channel carries the richer document model (metadata +
            // security); this path stays the ergonomic outline query.
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

// A node in pdfjs's logical structure tree (tagged PDFs). Leaf content nodes
// reference marked content by id; that id correlates with the marked-content
// items getTextContent({ includeMarkedContent: true }) emits.
interface StructContent { type: "content"; id: string }
interface StructNode { role?: string; children?: Array<StructNode | StructContent> }

function isContent(x: StructNode | StructContent): x is StructContent {
    return (x as StructContent).type === "content";
}

// Heading role → level. H1..H6 carry their level; bare H / Title are level 1.
function headingLevel(role: string | undefined): number | null {
    if (role === "H" || role === "Title") return 1;
    const m = role ? /^H([1-6])$/.exec(role) : null;
    return m ? Number(m[1]) : null;
}

// Symbols cascade: prefer the logical structure tree (real H1..H6 hierarchy for
// tagged PDFs) → outline bookmarks → metadata Title. Each is strictly better
// signal than the next; the first non-empty source wins.
async function collectSymbols(doc: PdfDocument): Promise<MimeSymbol[]> {
    const tagged = await collectStructHeadings(doc).catch(() => [] as MimeSymbol[]);
    if (tagged.length > 0) return tagged;

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

// Logical-structure headings from a tagged PDF. Per page: walk getStructTree()
// for heading roles, resolve each heading's text by correlating its leaf
// content ids with the marked-content text from getTextContent. line = page
// number (PDF's unit of navigation). Page-bounded by the same cap as text.
async function collectStructHeadings(doc: PdfDocument): Promise<MimeSymbol[]> {
    const out: MimeSymbol[] = [];
    const limit = Math.min(doc.numPages, envCap("PLURNK_PDF_MAX_PAGES", DEFAULT_MAX_TEXT_PAGES));
    for (let p = 1; p <= limit; p += 1) {
        const page = await doc.getPage(p);
        try {
            if (typeof page.getStructTree !== "function") continue;
            const tree = await page.getStructTree().catch(() => null);
            if (!tree) continue;
            const idText = await markedContentText(page);
            walkStruct(tree, p, idText, out);
        } finally {
            page.cleanup();
        }
    }
    return out;
}

// id → concatenated text, from marked-content-aware text items. str items
// attribute to the innermost open marked-content id (the heading's own id).
async function markedContentText(page: {
    getTextContent(options?: { includeMarkedContent?: boolean }): Promise<{ items: unknown[] }>;
}): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const tc = await page.getTextContent({ includeMarkedContent: true }).catch(() => ({ items: [] as unknown[] }));
    const stack: string[] = [];
    for (const raw of tc.items) {
        const it = raw as { type?: string; id?: string; str?: string };
        if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
            stack.push(typeof it.id === "string" ? it.id : "");
        } else if (it.type === "endMarkedContent") {
            stack.pop();
        } else if (typeof it.str === "string" && stack.length > 0) {
            const id = stack[stack.length - 1];
            if (id) map.set(id, (map.get(id) ?? "") + it.str);
        }
    }
    return map;
}

function walkStruct(node: StructNode, page: number, idText: Map<string, string>, out: MimeSymbol[]): void {
    const level = headingLevel(node.role);
    if (level !== null) {
        const text = contentText(node, idText).trim();
        if (text.length > 0) out.push({ name: text, kind: "heading", level, line: page, endLine: page });
    }
    for (const child of node.children ?? []) {
        if (!isContent(child)) walkStruct(child, page, idText, out);
    }
}

function contentText(node: StructNode, idText: Map<string, string>): string {
    let s = "";
    for (const child of node.children ?? []) {
        s += isContent(child) ? (idText.get(child.id) ?? "") : contentText(child, idText);
    }
    return s;
}

async function extractAllText(bytes: Uint8Array): Promise<string> {
    return withDocument(bytes, (doc) => readAllPagesText(doc));
}

// The full document model — structure + metadata + security signals — in one
// parse. Shared by deepJson() and the jsonpath query path so they can't drift.
// null on a parse failure (or over-cap input), matching the channel's
// degrade-to-dark policy.
async function buildDocumentModel(bytes: Uint8Array): Promise<PdfDocModel | null> {
    try {
        return await withDocument(bytes, async (doc) => {
            const [symbols, metadata, security, links, forms] = await Promise.all([
                collectSymbols(doc),
                collectMetadata(doc),
                collectSecurity(doc),
                collectLinks(doc),
                collectForms(doc),
            ]);
            return {
                type: "document" as const,
                line: 1,
                endLine: Math.max(doc.numPages, 1),
                metadata,
                security,
                links,
                forms,
                children: symbols.map((s) => ({
                    type: "outline_item" as const,
                    name: s.name,
                    ...(typeof s.level === "number" && { level: s.level }),
                    line: s.line,
                    endLine: s.endLine,
                })),
            };
        });
    } catch {
        return null;
    }
}

// Document metadata from the info dictionary — only non-empty fields, plus the
// always-present pageCount. Dates pass through as their raw PDF strings if they
// don't match the D:YYYYMMDD form (lossless; the host can parse).
async function collectMetadata(doc: PdfDocument): Promise<Record<string, unknown>> {
    const meta = await doc.getMetadata();
    const info = (meta.info ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { pageCount: doc.numPages };
    const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
    const fields: Array<[string, string]> = [
        ["title", "Title"], ["author", "Author"], ["subject", "Subject"],
        ["keywords", "Keywords"], ["creator", "Creator"], ["producer", "Producer"],
        ["pdfVersion", "PDFFormatVersion"],
    ];
    for (const [key, src] of fields) {
        const v = str(info[src]);
        if (v !== undefined) out[key] = v;
    }
    const created = pdfDate(info.CreationDate); if (created) out.created = created;
    const modified = pdfDate(info.ModDate); if (modified) out.modified = modified;
    return out;
}

function pdfDate(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const m = raw.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
    if (!m) return raw;
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

// Detect-only security signals. We never execute the JS or extract the files —
// presence is the signal the host wants (plurnk-mimetypes#38). Defensive: a
// build without these APIs, or a malformed doc, reports "no signal".
async function collectSecurity(doc: PdfDocument): Promise<{ hasJavaScript: boolean; hasEmbeddedFiles: boolean }> {
    const present = (v: Record<string, unknown> | null | undefined): boolean =>
        v != null && Object.keys(v).length > 0;
    const js = typeof doc.getJSActions === "function"
        ? await doc.getJSActions().catch(() => null) : null;
    const files = typeof doc.getAttachments === "function"
        ? await doc.getAttachments().catch(() => null) : null;
    return { hasJavaScript: present(js), hasEmbeddedFiles: present(files) };
}

// External hyperlinks from Link annotations (URI actions), per page. These are
// document data, not code-nav references (the references channel's RefKind is
// frozen to code semantics), so they live in the document model. Page-bounded
// like text; deduped by url+page. Never follows a link — just surfaces it.
async function collectLinks(doc: PdfDocument): Promise<Array<{ url: string; page: number }>> {
    const out: Array<{ url: string; page: number }> = [];
    const seen = new Set<string>();
    const limit = Math.min(doc.numPages, envCap("PLURNK_PDF_MAX_PAGES", DEFAULT_MAX_TEXT_PAGES));
    for (let i = 1; i <= limit; i += 1) {
        const page = await doc.getPage(i);
        try {
            if (typeof page.getAnnotations !== "function") continue;
            const annots = await page.getAnnotations().catch(() => [] as unknown[]);
            for (const a of annots) {
                const annot = a as { subtype?: unknown; url?: unknown };
                if (annot.subtype !== "Link" || typeof annot.url !== "string" || annot.url.length === 0) continue;
                const key = `${i} ${annot.url}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ url: annot.url, page: i });
            }
        } finally {
            page.cleanup();
        }
    }
    return out;
}

// AcroForm fields (name / value / type / page) from getFieldObjects. Document
// data, read-only — surfaces what a form holds without filling or executing it.
// Non-string values (checkboxes, choices) are stringified; page is 1-indexed.
async function collectForms(doc: PdfDocument): Promise<Array<{ name: string; value: string; type: string; page: number }>> {
    if (typeof doc.getFieldObjects !== "function") return [];
    const fields = await doc.getFieldObjects().catch(() => null);
    if (!fields) return [];
    const out: Array<{ name: string; value: string; type: string; page: number }> = [];
    for (const group of Object.values(fields)) {
        for (const raw of group) {
            const f = raw as { name?: unknown; value?: unknown; type?: unknown; page?: unknown };
            if (typeof f.name !== "string" || f.name.length === 0) continue;
            out.push({
                name: f.name,
                value: f.value == null ? "" : String(f.value),
                type: typeof f.type === "string" ? f.type : "unknown",
                page: (typeof f.page === "number" ? f.page : 0) + 1,
            });
        }
    }
    return out;
}

async function readAllPagesText(doc: PdfDocument): Promise<string> {
    const pages: string[] = [];
    // Bound the read — a multi-million-page PDF can't pin the event loop here.
    // The cap is well past any real document.
    const limit = Math.min(doc.numPages, envCap("PLURNK_PDF_MAX_PAGES", DEFAULT_MAX_TEXT_PAGES));
    for (let i = 1; i <= limit; i += 1) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        pages.push(pageToText(tc.items));
        page.cleanup();
    }
    return pages.join("\n\n");
}

// Reading-order page text using pdfjs's own hasEOL line markers — NOT custom
// geometry heuristics (which are the unstable part of PDF→text). Runs on a line
// are space-joined; hasEOL ends the line. Whitespace is normalized lightly and
// runs of blank lines collapse to a single paragraph break. The flat space-join
// remains the floor: a PDF with no EOL markers still yields one line per page.
function pageToText(items: unknown[]): string {
    let out = "";
    for (const raw of items) {
        const it = raw as { str?: string; hasEOL?: boolean };
        out += it.str ?? "";
        out += it.hasEOL ? "\n" : " ";
    }
    return out
        .replace(/[ \t]+\n/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
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
