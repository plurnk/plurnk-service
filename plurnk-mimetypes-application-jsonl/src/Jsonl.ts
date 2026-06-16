import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol } from "@plurnk/plurnk-mimetypes";

// application/jsonl (JSON Lines / NDJSON) handler — Tier 4, no parser dep.
//
// One JSON value per line: training data, eval sets, fine-tune files, chat /
// agent logs. The structural definition of a JSONL dataset is its RECORD
// SCHEMA — the union of top-level keys across records — not its rows: a file
// can be millions of lines, so one-symbol-per-record would explode and
// sampling would lie. So symbols are the schema (each distinct top-level key →
// a `field` at the line it first appears), and `extent` is the record count
// (the unit you address by). The records themselves live in deepJson — the
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

    override extent(content: HandlerContent): number {
        return scan(toText(content)).records.length;
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
        } catch {
            continue;
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
