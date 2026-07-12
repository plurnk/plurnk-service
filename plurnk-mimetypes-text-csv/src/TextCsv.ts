import {
    BaseHandler,
    projectJsonToXml,
    queryJsonpathObject,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";

// text/csv handler. CSV's structural signal is the header row's column names;
// no library dependency — RFC 4180 is small enough to hand-roll correctly.
//
// validate(): walk all records, throw on unbalanced quotes or non-uniform
//             column count across rows.
// extractRaw(): emit one `field` symbol per header column, at line 1.
//
// Quote-stripped header tokens become field names. Empty headers become
// empty-named symbols (still emitted — surfacing the column count is
// meaningful even when headers are blank).
export default class TextCsv extends BaseHandler {
    override validate(content: string): void {
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

    override extractRaw(content: string): MimeSymbol[] {
        const records = parseAll(content);
        if (records.length === 0) return [];
        return records[0].map((name) => ({
            name,
            kind: "field" as const,
            line: 1,
            endLine: 1,
        }));
    }

    // Deep-channel (issue #10). CSV's natural deep-json IS the parsed value:
    // an array of row objects keyed by header column. Same shape the custom
    // jsonpath dispatch already uses — consistent across channels. The
    // framework projects this to deep-xml via projectJsonToXml; rows render
    // as repeated sibling elements.
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        try {
            return parseToRowObjects(content);
        } catch {
            return null;
        }
    }

    // Override jsonpath dispatch to query against the row objects
    // ([{header1: value, header2: value, ...}, ...]) shaped from the parsed
    // CSV — the natural model for "find rows where X" queries.
    //
    // Line numbers: header is row 1 (line 1); data rows start at line 2 and
    // count up. Embedded newlines inside quoted fields will skew this — the
    // simple convention "line = rowIndex + 2" is approximate; consumers with
    // structured CSVs containing literal newlines should fall back to regex
    // against the raw source for exact positions.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            if (typeof content !== "string") {
                throw new QueryParseFailureError({
                    mimetype: this.mimetype,
                    cause: new TypeError(`${this.mimetype} content must be a string`),
                });
            }
            let rows: Array<Record<string, string>>;
            try {
                rows = parseToRowObjects(content);
            } catch (cause) {
                throw new QueryParseFailureError({ mimetype: this.mimetype, cause });
            }
            const lineFor = (pointer: string): readonly { line: number; endLine: number }[] | undefined => {
                // The JSON pointer starts with /N where N is the row index;
                // header is line 1, so data row N is on line N+2 (one line per
                // row, embedded newlines aside — see the note above).
                const m = pointer.match(/^\/(\d+)/);
                if (!m) return undefined;
                const line = Number(m[1]) + 2;
                return [{ line, endLine: line }];
            };
            return queryJsonpathObject(rows, pattern, lineFor);
        }
        return super.query(content, dialect, pattern, flags);
    }

    // deep-xml carries the SAME source lines as jsonpath (#41): a match's record
    // index (first pointer segment) → its source line (header line 1, data row N
    // on line N+2). Same convention as the jsonpath path.
    override deepXml(content: HandlerContent): Promise<string> {
        const span = (pointer: string): { line: number; endLine: number } | undefined => {
            if (pointer === "") return { line: 1, endLine: 1 }; // header row
            const m = pointer.match(/^\/(\d+)/);
            if (m === null) return undefined;
            const line = Number(m[1]) + 2;
            return { line, endLine: line };
        };
        return Promise.resolve(projectJsonToXml(this.deepJson(content), "root", span));
    }
}

// Parse CSV into an array of row objects keyed by header column. Header row
// becomes the keys; subsequent rows become objects. Mismatched column counts
// fall through silently (extra columns ignored; missing columns become
// empty strings) so query stays robust against slightly-malformed CSVs that
// validate() would have caught earlier.
function parseToRowObjects(content: string): Array<Record<string, string>> {
    const records = parseAll(content);
    if (records.length < 2) return [];
    const headers = records[0];
    const rows: Array<Record<string, string>> = [];
    for (let r = 1; r < records.length; r += 1) {
        const obj: Record<string, string> = {};
        for (let c = 0; c < headers.length; c += 1) {
            obj[headers[c]] = records[r][c] ?? "";
        }
        rows.push(obj);
    }
    return rows;
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
