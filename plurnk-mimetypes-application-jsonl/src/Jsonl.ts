import { BaseHandler, projectJsonToXml, queryJsonpathObject, TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch } from "@plurnk/plurnk-mimetypes";
import { JsonSource } from "@plurnk/plurnk-mimetypes-application-json";
import { parseTree } from "jsonc-parser";

// application/jsonl (JSON Lines / NDJSON) handler.
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

    // {§mimetype-query}: each record delegates lexical coordinates to the JSON owner.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const source = sourceMap(toText(content));
            const regionFor = (pointer: string) => {
                const region = source.region(pointer);
                return region === undefined ? undefined : [region];
            };
            return queryJsonpathObject(source.records, pattern, regionFor);
        }
        return super.query(content, dialect, pattern, flags);
    }

    override deepXml(content: HandlerContent): Promise<string> {
        const source = sourceMap(toText(content));
        const span = (pointer: string) => {
            const region = source.region(pointer);
            return region === undefined ? undefined : {
                line: region.startLine, column: region.startColumn, endLine: region.endLine, endColumn: region.endColumn,
            };
        };
        return Promise.resolve(projectJsonToXml(source.records, "root", span, "value"));
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
    const records: unknown[] = [];
    const schema: SchemaEntry[] = [];
    const seen = new Set<string>();
    for (const { value, line } of parsedRecords(text)) {
        records.push(value);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            for (const key of Object.keys(value)) {
                if (!seen.has(key)) {
                    seen.add(key);
                    schema.push({ key, firstLine: line });
                }
            }
        }
    }
    return { records, schema };
}

function sourceMap(text: string): { records: unknown[]; region: (pointer: string) => TextRegion | undefined } {
    const records: unknown[] = [];
    const sources: Array<{ line: number; source: JsonSource }> = [];
    for (const { value, line, content } of parsedRecords(text)) {
        const tree = parseTree(content);
        if (tree === undefined) throw new Error("Valid JSON has no source tree");
        records.push(value);
        sources.push({ line, source: new JsonSource(content, tree) });
    }
    return { records, region: (pointer) => {
        if (pointer === "") return TextCoordinates.regionFromOffsets(text, 0, text.length) ?? undefined;
        const match = /^\/(\d+)(\/.*)?$/.exec(pointer);
        if (match === null) return undefined;
        const source = sources[Number(match[1])];
        const region = source?.source.region(match[2] ?? "");
        return source === undefined || region === undefined ? undefined
            : { ...region, startLine: region.startLine + source.line - 1, endLine: region.endLine + source.line - 1 };
    } };
}

function* parsedRecords(text: string): Generator<{ value: unknown; content: string; line: number }> {
    for (const [index, line] of TextCoordinates.logicalLines(text).entries()) {
        const content = text.slice(line.start, line.contentEnd);
        let value: unknown;
        try {
            value = JSON.parse(content);
        } catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            continue;
        }
        yield { value, content, line: index + 1 };
    }
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
