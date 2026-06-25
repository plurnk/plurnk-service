// Minimal TAGGED PDF builder for tests — a one-page document whose headings are
// real structure elements (/StructTreeRoot → StructElem /S /H1.. with /K MCID)
// drawn into a marked-content content stream. This lets the handler's
// structTree extraction be tested against genuine pdfjs getStructTree() +
// getTextContent({ includeMarkedContent: true }) output, not a mock.
// Internal test helper only.

export interface TaggedHeading {
    level: number; // 1..6 → /H1../H6
    text: string;
}

export function buildTaggedPdf(headings: TaggedHeading[]): Uint8Array {
    const STRUCT_ELEM_START = 7; // objs: 1 cat 2 pages 3 page 4 structroot 5 font 6 contents 7.. elems
    const role = (lvl: number): string => `H${Math.min(Math.max(Math.trunc(lvl), 1), 6)}`;

    // Content stream: each heading is its own marked-content sequence (MCID i),
    // tagged with its structure role, drawing the text.
    let content = "";
    headings.forEach((h, i) => {
        const y = 720 - i * 40;
        content += `BT /F1 18 Tf 50 ${y} Td /${role(h.level)} <</MCID ${i}>> BDC (${pdfString(h.text)}) Tj EMC ET\n`;
    });
    const contentLen = latin1Length(content);

    const elemRefs = headings.map((_, i) => `${STRUCT_ELEM_START + i} 0 R`).join(" ");
    const parentTreeNum = STRUCT_ELEM_START + headings.length; // last object

    const objects: string[] = [];
    objects[0] = "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 4 0 R >>";
    objects[1] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    objects[2] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        + "/Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /StructParents 0 >>";
    // ParentTree maps the page's /StructParents key (0) → an array indexed by
    // MCID → the owning StructElem. Without it pdfjs can't resolve the tree.
    objects[3] = `<< /Type /StructTreeRoot /K [${elemRefs}] /ParentTree ${parentTreeNum} 0 R >>`;
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    objects[5] = `<< /Length ${contentLen} >>\nstream\n${content}endstream`;
    headings.forEach((h, i) => {
        objects[STRUCT_ELEM_START - 1 + i] =
            `<< /Type /StructElem /S /${role(h.level)} /P 4 0 R /Pg 3 0 R /K ${i} >>`;
    });
    objects[parentTreeNum - 1] = `<< /Nums [0 [${elemRefs}]] >>`;

    let body = "%PDF-1.5\n%\xa5\xb1\xeb\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i += 1) {
        offsets.push(latin1Length(body));
        body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = latin1Length(body);
    body += "xref\n";
    body += `0 ${objects.length + 1}\n`;
    body += "0000000000 65535 f \n";
    for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
    body += "trailer\n";
    body += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    body += "startxref\n";
    body += `${xrefOffset}\n`;
    body += "%%EOF\n";

    return latin1Encode(body);
}

function pdfString(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function latin1Length(s: string): number {
    return s.length; // we only emit chars 0-255 → 1 byte each
}

function latin1Encode(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}
