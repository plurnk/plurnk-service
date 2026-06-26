import { BaseHandler, queryJsonpathObject } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch } from "@plurnk/plurnk-mimetypes";

// text/x-ini (INI / config) handler — Tier 4, no parser dep.
//
// `[section]` headers, `key = value` / `key: value` entries, `;` and `#`
// comments. Covers the Python tooling cluster (setup.cfg, tox.ini, pytest.ini,
// .editorconfig, .pylintrc) plus generic .ini/.cfg. Sections are `module`
// symbols spanning to the next section; keys are `field` symbols contained by
// their section (keys before any section are top-level fields). deepJson is the
// nested `{ section: { key: value } }` object, a jsonpath target.
//
// v1 is single-line: indented continuation lines (setup.cfg multi-line values)
// are not folded into the preceding value — they are skipped rather than
// guessed. The raw body is directly readable, so there is no content projection.
export default class Ini extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        const out: MimeSymbol[] = [];
        for (const section of parseIni(toText(content))) {
            if (section.name !== null) {
                out.push({ name: section.name, kind: "module", line: section.line, endLine: section.endLine });
            }
            for (const k of section.keys) {
                out.push({
                    name: k.key,
                    kind: "field",
                    line: k.line,
                    endLine: k.line,
                    ...(section.name !== null && { container: section.name }),
                });
            }
        }
        return out;
    }

    override deepJson(content: HandlerContent): unknown {
        const root: Record<string, unknown> = {};
        for (const section of parseIni(toText(content))) {
            if (section.name === null) {
                for (const k of section.keys) root[k.key] = k.value;
            } else {
                const target = (root[section.name] ??= {}) as Record<string, string>;
                for (const k of section.keys) target[k.key] = k.value;
            }
        }
        return root;
    }

    // jsonpath against the nested {section:{key:value}} object, with source-line
    // spans (#41): deepJson is line-less (raw values), so we supply a lineFor
    // from parseIni's positions, keyed by JSON pointer. A key on line N → line N
    // (single-line per v1). Absent for pointers we don't recognize — never faked.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const byPointer = new Map<string, number>();
            for (const section of parseIni(toText(content))) {
                const base = section.name === null ? "" : `/${ptr(section.name)}`;
                if (section.name !== null) byPointer.set(base, section.line);
                for (const k of section.keys) byPointer.set(`${base}/${ptr(k.key)}`, k.line);
            }
            const lineFor = (pointer: string): readonly { line: number; endLine: number }[] | undefined => {
                const ln = byPointer.get(pointer);
                return ln === undefined ? undefined : [{ line: ln, endLine: ln }];
            };
            return queryJsonpathObject(this.deepJson(content), pattern, lineFor);
        }
        return super.query(content, dialect, pattern, flags);
    }
}

export interface IniKey {
    key: string;
    value: string;
    line: number;
}

export interface IniSection {
    name: string | null; // null = the implicit global section before any header
    line: number;
    endLine: number;
    keys: IniKey[];
}

export function parseIni(text: string): IniSection[] {
    const lines = text.split("\n");
    const global: IniSection = { name: null, line: 1, endLine: lines.length, keys: [] };
    const sections: IniSection[] = [global];
    let current = global;

    for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (t.length === 0 || t.startsWith(";") || t.startsWith("#")) continue;
        const header = /^\[(.+?)\]$/.exec(t);
        if (header) {
            current.endLine = i; // previous section ends on the line before this header
            current = { name: header[1].trim(), line: i + 1, endLine: lines.length, keys: [] };
            sections.push(current);
            continue;
        }
        const entry = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(t);
        if (entry) current.keys.push({ key: entry[1].trim(), value: entry[2].trim(), line: i + 1 });
    }

    // Drop the implicit global section when it carries no top-level keys.
    return sections.filter((s) => s.name !== null || s.keys.length > 0);
}

// JSON Pointer token escape (RFC 6901): ~ → ~0, / → ~1.
function ptr(s: string): string {
    return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
