import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol } from "@plurnk/plurnk-mimetypes";

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
}

export interface DotenvVar {
    key: string;
    value: string;
    line: number;
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
