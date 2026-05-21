import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

// text/csv handler. CSV's structural signal is the header row's column names;
// no library dependency — RFC 4180 is small enough to hand-roll correctly.
//
// validate(): walk all records, throw on unbalanced quotes or non-uniform
//             column count across rows.
// extract(): emit one `field` symbol per header column, at line 1.
//
// Quote-stripped header tokens become field names. Empty headers become
// empty-named symbols (still emitted — surfacing the column count is
// meaningful even when headers are blank).
export default class TextCsv extends BaseHandler {
    validate(content: string): void {
        const records = parseAll(content);
        if (records.length === 0) return;
        const expected = records[0].length;
        for (let i = 1; i < records.length; i += 1) {
            if (records[i].length !== expected) {
                throw new SyntaxError(
                    `CSV row ${i + 1} has ${records[i].length} columns; header has ${expected}`,
                );
            }
        }
    }

    extract(content: string): MimeSymbol[] {
        const records = parseAll(content);
        if (records.length === 0) return [];
        return records[0].map((name) => ({
            name,
            kind: "field" as const,
            line: 1,
            endLine: 1,
        }));
    }
}

// RFC 4180 tokenizer. Walks character by character, tracking quoted state,
// handling escaped double-quotes inside quoted fields, accepting CR/LF/CRLF
// line endings between unquoted records, and treating commas inside quoted
// fields as literal characters. Throws on unbalanced quotes.
export function parseAll(content: string): string[][] {
    const records: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;

    while (i < content.length) {
        const ch = content[i];

        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < content.length && content[i + 1] === '"') {
                    // Escaped double-quote inside a quoted field.
                    field += '"';
                    i += 2;
                    continue;
                }
                // End of quoted field.
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            i += 1;
            continue;
        }
        if (ch === ",") {
            row.push(field);
            field = "";
            i += 1;
            continue;
        }
        if (ch === "\r") {
            // Treat CR (alone) or CRLF as record terminator.
            row.push(field);
            field = "";
            records.push(row);
            row = [];
            i += 1;
            if (i < content.length && content[i] === "\n") i += 1;
            continue;
        }
        if (ch === "\n") {
            row.push(field);
            field = "";
            records.push(row);
            row = [];
            i += 1;
            continue;
        }
        field += ch;
        i += 1;
    }

    if (inQuotes) {
        throw new SyntaxError("Unbalanced quote in CSV content");
    }

    // Flush the final partial row if there's content (handles files without
    // a trailing newline).
    if (field !== "" || row.length > 0) {
        row.push(field);
        records.push(row);
    }

    return records;
}
