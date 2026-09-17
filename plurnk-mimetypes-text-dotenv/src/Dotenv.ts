import { parseEnv } from "node:util";
import { BaseHandler, projectJsonToXml, queryJsonpathObject, regionsForLineSpans, TextCoordinates } from "@plurnk/plurnk-mimetypes";
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
                const span = byPointer.get(pointer);
                return span === undefined
                    ? undefined
                    : regionsForLineSpans(text, [span]);
            };
            return queryJsonpathObject(this.deepJson(content), pattern, regionFor);
        }
        return super.query(content, dialect, pattern, flags);
    }

    override deepXml(content: HandlerContent): Promise<string> {
        const byPointer = sourceSpans(toText(content));
        return Promise.resolve(projectJsonToXml(this.deepJson(content), "root", (pointer) => byPointer.get(pointer)));
    }
}

export interface DotenvVar {
    key: string;
    value: string;
    line: number;
    endLine: number;
}

// JSON Pointer token escape (RFC 6901): ~ → ~0, / → ~1.
function ptr(s: string): string {
    return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parseDotenv(text: string): DotenvVar[] {
    const out: DotenvVar[] = [];
    const lines = TextCoordinates.logicalLines(text);
    for (let i = 0; i < lines.length; i += 1) {
        const body = text.slice(lines[i].start, lines[i].contentEnd);
        if (body.trimStart().startsWith("#")) continue;
        const eq = body.indexOf("=");
        if (eq <= 0) continue;
        let end = i;
        let start = lines[i].start + eq + 1;
        if (start < lines[i].contentEnd) {
            while (start < text.length && /[ \t\r\n]/u.test(text[start])) start++;
            // Node's quoted value ends at the first matching quote, even across lines.
            const quote = text[start];
            const closing = quote === '"' || quote === "'" || quote === "`" ? text.indexOf(quote, start + 1) : start;
            while (end + 1 < lines.length && lines[end].contentEnd < closing) end++;
        }
        const values = parseEnv(text.slice(lines[i].start, lines[end].contentEnd));
        for (const [key, value] of Object.entries(values)) out.push({ key, value: value!, line: i + 1, endLine: end + 1 });
        i = end;
    }
    return out;
}

function sourceSpans(text: string): Map<string, { line: number; endLine: number }> {
    const spans = new Map<string, { line: number; endLine: number }>();
    const endLine = TextCoordinates.logicalLines(text).length;
    if (endLine > 0) spans.set("", { line: 1, endLine });
    const values = parseEnv(text);
    for (const variable of parseDotenv(text)) {
        const pointer = `/${ptr(variable.key)}`;
        spans.delete(pointer);
        if (values[variable.key] === variable.value) spans.set(pointer, { line: variable.line, endLine: variable.endLine });
    }
    return spans;
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
