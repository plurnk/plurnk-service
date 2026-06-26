import { BaseHandler, projectJsonToXml, queryJsonpathObject } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch } from "@plurnk/plurnk-mimetypes";

// text/x-dotenv (.env) handler — Tier 4, no parser dep.
//
// `KEY=value` lines, `#` comments, optional `export ` prefix, optional matching
// surrounding quotes. Each variable is a `constant` symbol; values are exposed
// like any other config (no redaction — plenty of .env workflows carry no
// secrets). deepJson is the `{ KEY: value }` map, a jsonpath target. The raw
// body is directly readable, so there is no content projection.
export default class Dotenv extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        return parseDotenv(toText(content)).map((v) => ({
            name: v.key,
            kind: "constant",
            line: v.line,
            endLine: v.line,
        }));
    }

    override deepJson(content: HandlerContent): unknown {
        const out: Record<string, string> = {};
        for (const v of parseDotenv(toText(content))) out[v.key] = v.value;
        return out;
    }

    // jsonpath against the flat {KEY:value} object, with source-line spans (#41)
    // from parseDotenv positions — deepJson is line-less raw values. A key on
    // line N → line N. Absent for unrecognized pointers; never faked.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const byPointer = new Map<string, number>();
            for (const v of parseDotenv(toText(content))) byPointer.set(`/${ptr(v.key)}`, v.line);
            const lineFor = (pointer: string): readonly { line: number; endLine: number }[] | undefined => {
                const ln = byPointer.get(pointer);
                return ln === undefined ? undefined : [{ line: ln, endLine: ln }];
            };
            return queryJsonpathObject(this.deepJson(content), pattern, lineFor);
        }
        return super.query(content, dialect, pattern, flags);
    }

    // deep-xml carries the SAME source lines as jsonpath (#41): stamp pk:line
    // from the same parseDotenv positions during projection.
    override deepXml(content: HandlerContent): Promise<string> {
        const byPointer = new Map<string, number>();
        for (const v of parseDotenv(toText(content))) byPointer.set(`/${ptr(v.key)}`, v.line);
        const span = (pointer: string): { line: number; endLine: number } | undefined => {
            if (pointer === "") return { line: 1, endLine: 1 };
            const ln = byPointer.get(pointer);
            return ln === undefined ? undefined : { line: ln, endLine: ln };
        };
        return Promise.resolve(projectJsonToXml(this.deepJson(content), "root", span));
    }
}

export interface DotenvVar {
    key: string;
    value: string;
    line: number;
}

// JSON Pointer token escape (RFC 6901): ~ → ~0, / → ~1.
function ptr(s: string): string {
    return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parseDotenv(text: string): DotenvVar[] {
    const out: DotenvVar[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const body = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
        const eq = body.indexOf("=");
        if (eq <= 0) continue;
        const key = body.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
        out.push({ key, value: stripQuotes(body.slice(eq + 1).trim()), line: i + 1 });
    }
    return out;
}

// Strip one layer of matching surrounding quotes (`"x"` / `'x'`). Unquoted
// values are taken verbatim — inline `#` is left in place (it is value content
// unless quoted away, and dotenv tools disagree on it; precision over a guess).
function stripQuotes(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value[value.length - 1] === first) {
            return value.slice(1, -1);
        }
    }
    return value;
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
