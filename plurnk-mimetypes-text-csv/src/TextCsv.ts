import {
    BaseHandler,
    projectJsonToXml,
    queryJsonpathObject,
    QueryParseFailureError,
    TextCoordinates,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";

// {§csv-records}: the tokenizer owns both field values and physical record boundaries.
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
        const records = parseRecords(content);
        if (records.length === 0) return [];
        const endLine = new TextCoordinates(content).regionFromOffsets(0, records[0].end)?.endLine ?? 1;
        return records[0].fields.map((name) => ({
            name,
            kind: "field" as const,
            line: 1,
            endLine,
        }));
    }

    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        return toRowObjects(parseRecords(content));
    }

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
            let records: CsvRecord[];
            try {
                records = parseRecords(content);
            } catch (cause) {
                throw new QueryParseFailureError({ mimetype: this.mimetype, cause });
            }
            return queryJsonpathObject(toRowObjects(records), pattern, sourceRegions(content, records));
        }
        return super.query(content, dialect, pattern, flags);
    }

    override deepXml(content: HandlerContent): Promise<string> {
        if (typeof content !== "string") return super.deepXml(content);
        const records = parseRecords(content);
        const regions = sourceRegions(content, records);
        const span = (pointer: string) => {
            const region = regions(pointer)?.[0];
            return region === undefined ? undefined : {
                line: region.startLine, endLine: region.endLine,
                column: region.startColumn, endColumn: region.endColumn,
            };
        };
        return Promise.resolve(projectJsonToXml(toRowObjects(records), "root", span));
    }
}

function toRowObjects(records: CsvRecord[]): Array<Record<string, string>> {
    if (records.length < 2) return [];
    const headers = records[0].fields;
    return records.slice(1).map(({ fields }) => Object.fromEntries(headers.map((name, i) => [name, fields[i] ?? ""])));
}

function sourceRegions(content: string, records: CsvRecord[]): (pointer: string) => QueryMatch["regions"] {
    const coordinates = new TextCoordinates(content);
    return (pointer) => {
        const match = /^\/(\d+)(?:\/|$)/u.exec(pointer);
        const record = pointer === "" ? { start: 0, end: content.length } : match ? records[Number(match[1]) + 1] : undefined;
        if (record === undefined) return undefined;
        const region = coordinates.regionFromOffsets(record.start, record.end);
        return region === null ? undefined : [region];
    };
}

interface CsvRecord {
    fields: string[];
    start: number;
    end: number;
}

export function parseAll(content: string): string[][] {
    return parseRecords(content).map(({ fields }) => fields);
}

// RFC 4180 tokenizer. Walks character by character, tracking quoted state,
// handling escaped double-quotes inside quoted fields, accepting CR/LF/CRLF
// line endings between unquoted records, and treating commas inside quoted
// fields as literal characters. Throws on unbalanced quotes.
function parseRecords(content: string): CsvRecord[] {
    const records: CsvRecord[] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    let start = 0;

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
        if (ch === "\r" || ch === "\n") {
            row.push(field);
            field = "";
            records.push({ fields: row, start, end: i });
            row = [];
            i += 1;
            if (ch === "\r" && content[i] === "\n") i += 1;
            start = i;
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
    if (start < content.length) {
        row.push(field);
        records.push({ fields: row, start, end: content.length });
    }

    return records;
}
