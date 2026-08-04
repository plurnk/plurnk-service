import { BaseHandler, projectJsonToXml, queryJsonpathObject, regionsForLineSpans } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch } from "@plurnk/plurnk-mimetypes";

// application/jsonl (JSON Lines / NDJSON) handler — Tier 4, no parser dep.
//
// One JSON value per line: training data, eval sets, fine-tune files, chat /
// agent logs. The structural definition of a JSONL dataset is its RECORD
// SCHEMA — the union of top-level keys across records — not its rows: a file
// can be millions of lines, so one-symbol-per-record would explode and
// sampling would lie. So symbols are the schema (each distinct top-level key
// becomes a `field` at the line it first appears). The records themselves live in deepJson - the
// parsed array, a jsonpath target (`$[N].field`) computed only on demand.
//
// Lenient: blank lines are skipped, a line that doesn't parse is skipped (a
// trailing newline or a partial write doesn't poison the file). The raw body
// is already readable JSON-per-line, so there is no content projection.
export default class Jsonl extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        return scan(toText(content)).schema.map((s) => ({
            name: s.key,
            kind: "field",
            line: s.firstLine,
            endLine: s.firstLine,
        }));
    }

    override deepJson(content: HandlerContent): unknown {
        return scan(toText(content)).records;
    }

    // jsonpath against the record array, with source-line spans (#41). deepJson
    // is line-less raw records, so we map a match's record index (the first
    // pointer segment) to its source line — one record per non-empty parseable
    // line, the JSONL invariant. Absent for non-record pointers; never faked.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const recordLines: number[] = [];
            const lines = toText(content).split("\n");
            for (let i = 0; i < lines.length; i += 1) {
                const t = lines[i].trim();
                if (t.length === 0) continue;
                try {
                    JSON.parse(t);
                    recordLines.push(i + 1);
                } catch (cause) {
                    if (!(cause instanceof SyntaxError)) throw cause;
                    // Unparseable line skipped, mirroring scan().
                }
            }
            const regionFor = (pointer: string) => {
                const m = pointer.match(/^\/(\d+)/);
                if (m === null) return undefined;
                const ln = recordLines[Number(m[1])];
                return ln === undefined
                    ? undefined
                    : regionsForLineSpans(toText(content), [{ line: ln, endLine: ln }]);
            };
            return queryJsonpathObject(this.deepJson(content), pattern, regionFor);
        }
        return super.query(content, dialect, pattern, flags);
    }

    // deep-xml carries the SAME source lines as jsonpath (#41): a match's record
    // index (first pointer segment) → its source line (one record per line).
    override deepXml(content: HandlerContent): Promise<string> {
        const recordLines: number[] = [];
        const lines = toText(content).split("\n");
        for (let i = 0; i < lines.length; i += 1) {
            const t = lines[i].trim();
            if (t.length === 0) continue;
            try {
                JSON.parse(t);
                recordLines.push(i + 1);
            } catch (cause) {
                if (!(cause instanceof SyntaxError)) throw cause;
                // Unparseable line skipped, mirroring scan().
            }
        }
        const span = (pointer: string): { line: number; endLine: number } | undefined => {
            if (pointer === "") return { line: 1, endLine: 1 };
            const m = pointer.match(/^\/(\d+)/);
            if (m === null) return undefined;
            const ln = recordLines[Number(m[1])];
            return ln === undefined ? undefined : { line: ln, endLine: ln };
        };
        return Promise.resolve(projectJsonToXml(this.deepJson(content), "root", span));
    }

}

interface SchemaEntry {
    key: string;
    firstLine: number;
}

export interface JsonlScan {
    records: unknown[];
    schema: SchemaEntry[];
}

export function scan(text: string): JsonlScan {
    const lines = text.split("\n");
    const records: unknown[] = [];
    const schema: SchemaEntry[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch (cause) {
            if (cause instanceof SyntaxError) continue;
            throw cause;
        }
        records.push(value);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            for (const key of Object.keys(value)) {
                if (!seen.has(key)) {
                    seen.add(key);
                    schema.push({ key, firstLine: i + 1 });
                }
            }
        }
    }
    return { records, schema };
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
