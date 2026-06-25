// Minimal AcroForm PDF builder for tests — a one-page document with text form
// fields (FT /Tx) carrying a value, so the handler's form-field extraction can
// be tested against genuine pdfjs getFieldObjects() output. Internal test
// helper only.

export interface FormField {
    name: string;
    value: string;
}

export function buildFormPdf(fields: FormField[]): Uint8Array {
    const FIELD_START = 6; // 1 cat 2 pages 3 page 4 acroform 5 font 6.. fields
    const fieldRefs = fields.map((_, i) => `${FIELD_START + i} 0 R`).join(" ");

    const objects: string[] = [];
    objects[0] = "<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>";
    objects[1] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    objects[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [${fieldRefs}] >>`;
    objects[3] = `<< /Fields [${fieldRefs}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >>`;
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    fields.forEach((f, i) => {
        const y = 700 - i * 30;
        objects[FIELD_START - 1 + i] =
            `<< /FT /Tx /T (${pdfString(f.name)}) /V (${pdfString(f.value)}) `
            + `/Type /Annot /Subtype /Widget /Rect [50 ${y} 250 ${y + 20}] /P 3 0 R /DA (/Helv 0 Tf 0 g) >>`;
    });

    let body = "%PDF-1.5\n%\xa5\xb1\xeb\n";
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
    body += "trailer\n";
    body += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    body += "startxref\n";
    body += `${xrefOffset}\n`;
    body += "%%EOF\n";

    const out = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i += 1) out[i] = body.charCodeAt(i) & 0xff;
    return out;
}

function pdfString(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
