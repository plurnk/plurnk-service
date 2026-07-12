// Minimal PDF builder for tests. Constructs syntactically valid PDFs with
// optional metadata Title and an optional bookmark outline (recursive nest
// supported). Internal test helper only — not exported from the package.

export interface OutlineDesc {
    title: string;
    items?: OutlineDesc[];
}

export interface PdfShape {
    title?: string;
    outline?: OutlineDesc[];
    // URI link annotations, all placed on the single page.
    links?: string[];
}

interface OutlineEntry {
    num: number;
    title: string;
    parentNum: number;
    prev: number | null;
    next: number | null;
    children: OutlineEntry[];
}

export function buildPdf(shape: PdfShape): Uint8Array {
    const objects: string[] = [];

    // Object 1: catalog (filled in last, once we know outline root number).
    objects.push("");
    // Object 2: pages.
    objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    // Object 3: page.
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >>");

    let outlineRootNum: number | null = null;
    if (shape.outline && shape.outline.length > 0) {
        outlineRootNum = objects.length + 1;
        const topLevelStart = outlineRootNum + 1;
        const topEntries = allocOutline(shape.outline, outlineRootNum, topLevelStart);
        const allEntries = flattenDfs(topEntries);

        // Outline root object.
        const first = topEntries[0];
        const last = topEntries[topEntries.length - 1];
        objects.push(
            `<< /Type /Outlines /First ${first.num} 0 R /Last ${last.num} 0 R /Count ${topEntries.length} >>`,
        );
        // Each item in DFS order.
        for (const entry of allEntries) {
            const parts: string[] = [
                `/Title (${pdfString(entry.title)})`,
                `/Parent ${entry.parentNum} 0 R`,
            ];
            if (entry.prev !== null) parts.push(`/Prev ${entry.prev} 0 R`);
            if (entry.next !== null) parts.push(`/Next ${entry.next} 0 R`);
            if (entry.children.length > 0) {
                const c = entry.children;
                parts.push(`/First ${c[0].num} 0 R`);
                parts.push(`/Last ${c[c.length - 1].num} 0 R`);
                parts.push(`/Count ${c.length}`);
            }
            parts.push(`/Dest [3 0 R /Fit]`);
            objects.push(`<< ${parts.join(" ")} >>`);
        }
    }

    let infoNum: number | null = null;
    if (typeof shape.title === "string") {
        infoNum = objects.length + 1;
        objects.push(`<< /Title (${pdfString(shape.title)}) >>`);
    }

    // URI link annotations on the page (object 3). Allocate them, then patch the
    // page dict's /Annots (same fill-last pattern as the catalog).
    if (shape.links && shape.links.length > 0) {
        const annotNums: number[] = [];
        for (const url of shape.links) {
            annotNums.push(objects.length + 1);
            objects.push(
                `<< /Type /Annot /Subtype /Link /Rect [0 0 100 20] `
                + `/A << /S /URI /URI (${pdfString(url)}) >> >>`,
            );
        }
        const annots = annotNums.map((n) => `${n} 0 R`).join(" ");
        objects[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Annots [${annots}] >>`;
    }

    // Fill in the catalog now that outline root is known.
    const catalogParts: string[] = ["/Type /Catalog", "/Pages 2 0 R"];
    if (outlineRootNum !== null) catalogParts.push(`/Outlines ${outlineRootNum} 0 R`);
    objects[0] = `<< ${catalogParts.join(" ")} >>`;

    // Serialize.
    let body = "%PDF-1.4\n%\xa5\xb1\xeb\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i += 1) {
        offsets.push(body.length);
        body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = body.length;
    body += "xref\n";
    body += `0 ${objects.length + 1}\n`;
    body += "0000000000 65535 f \n";
    for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;

    const trailerParts: string[] = [`/Size ${objects.length + 1}`, "/Root 1 0 R"];
    if (infoNum !== null) trailerParts.push(`/Info ${infoNum} 0 R`);
    body += "trailer\n";
    body += `<< ${trailerParts.join(" ")} >>\n`;
    body += "startxref\n";
    body += `${xrefOffset}\n`;
    body += "%%EOF\n";

    // Encode latin-1 — PDF is a byte-oriented format and we use chars 0-255
    // only. TextEncoder would encode our binary marker bytes as multi-byte
    // utf-8, breaking the file.
    return latin1Encode(body);
}

// Walk the outline depth-first, assigning consecutive object numbers.
// Returns the top-level entries; each entry's children are filled in.
// `startNum` is the first object number to use for the top level.
function allocOutline(
    items: OutlineDesc[],
    parentNum: number,
    startNum: number,
): OutlineEntry[] {
    let next = startNum;
    function alloc(siblings: OutlineDesc[], pNum: number): OutlineEntry[] {
        const out: OutlineEntry[] = [];
        for (const item of siblings) {
            const entry: OutlineEntry = {
                num: next++,
                title: item.title,
                parentNum: pNum,
                prev: null,
                next: null,
                children: [],
            };
            if (item.items && item.items.length > 0) {
                entry.children = alloc(item.items, entry.num);
            }
            out.push(entry);
        }
        for (let i = 0; i < out.length; i += 1) {
            if (i > 0) out[i].prev = out[i - 1].num;
            if (i < out.length - 1) out[i].next = out[i + 1].num;
        }
        return out;
    }
    return alloc(items, parentNum);
}

function flattenDfs(entries: OutlineEntry[]): OutlineEntry[] {
    const out: OutlineEntry[] = [];
    function walk(es: OutlineEntry[]): void {
        for (const e of es) {
            out.push(e);
            if (e.children.length > 0) walk(e.children);
        }
    }
    walk(entries);
    return out;
}

function pdfString(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function latin1Encode(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}
