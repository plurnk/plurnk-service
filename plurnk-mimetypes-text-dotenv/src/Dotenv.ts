import { parseEnv } from "node:util";
import { BaseHandler, projectJsonToXml, queryJsonpathObject, TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch } from "@plurnk/plurnk-mimetypes";

// {§dotenv-values}: Node owns value semantics; only source coordinates are projected here.
export default class Dotenv extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        return parseDotenv(toText(content)).map((v) => ({
            name: v.key,
            kind: "constant",
            line: v.line,
            endLine: v.endLine,
        }));
    }

    override deepJson(content: HandlerContent): unknown {
        return { ...parseEnv(toText(content)) };
    }

    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const text = toText(content);
            const byPointer = sourceSpans(text);
            const regionFor = (pointer: string) => {
                const region = byPointer.get(pointer);
                return region === undefined ? undefined : [region];
            };
            return queryJsonpathObject(this.deepJson(content), pattern, regionFor);
        }
        return super.query(content, dialect, pattern, flags);
    }

    override deepXml(content: HandlerContent): Promise<string> {
        const byPointer = sourceSpans(toText(content));
        return Promise.resolve(projectJsonToXml(this.deepJson(content), "root", (pointer) => {
            const region = byPointer.get(pointer);
            return region === undefined ? undefined : {
                line: region.startLine, column: region.startColumn, endLine: region.endLine, endColumn: region.endColumn,
            };
        }, "value"));
    }
}

export interface DotenvVar {
    key: string;
    value: string;
    line: number;
    endLine: number;
    valueRegion?: TextRegion;
}

// JSON Pointer token escape (RFC 6901): ~ → ~0, / → ~1.
function ptr(s: string): string {
    return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parseDotenv(text: string): DotenvVar[] {
    const out: DotenvVar[] = [];
    const lines = TextCoordinates.logicalLines(text);
    const coordinates = new TextCoordinates(text);
    for (let i = 0; i < lines.length; i += 1) {
        const body = text.slice(lines[i].start, lines[i].contentEnd);
        if (body.trimStart().startsWith("#")) continue;
        const eq = body.indexOf("=");
        if (eq <= 0) continue;
        let end = i;
        let start = lines[i].start + eq + 1;
        let closing: number | undefined;
        if (start < lines[i].contentEnd) {
            while (start < lines[i].contentEnd && /[ \t]/u.test(text[start])) start++;
            // Node's quoted value ends at the first matching quote, even across lines.
            const quote = text[start];
            if (quote === '"' || quote === "'" || quote === "`") closing = text.indexOf(quote, start + 1);
            while (closing !== undefined && end + 1 < lines.length && lines[end].contentEnd < closing) end++;
        }
        const values = parseEnv(text.slice(lines[i].start, lines[end].contentEnd));
        const remainder = text.slice(start, lines[end].contentEnd);
        const stop = closing !== undefined && closing >= start ? closing + 1
            : start + remainder.split("#", 1)[0].trimEnd().length;
        const valueRegion = coordinates.regionFromOffsets(start, stop) ?? undefined;
        for (const [key, value] of Object.entries(values)) out.push({ key, value: value!, line: i + 1, endLine: end + 1, valueRegion });
        i = end;
    }
    return out;
}

// {§dotenv-source} — a frame that disagrees with the complete parse supplies no region.
function sourceSpans(text: string): Map<string, TextRegion> {
    const spans = new Map<string, TextRegion>();
    const root = TextCoordinates.regionFromOffsets(text, 0, text.length);
    if (root !== null) spans.set("", root);
    const values = parseEnv(text);
    for (const variable of parseDotenv(text)) {
        const pointer = `/${ptr(variable.key)}`;
        spans.delete(pointer);
        if (values[variable.key] === variable.value && variable.valueRegion !== undefined) spans.set(pointer, variable.valueRegion);
    }
    return spans;
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
