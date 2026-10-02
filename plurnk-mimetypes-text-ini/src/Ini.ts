import {
    BaseHandler,
    projectJsonToXml,
    queryJsonpathObject,
    TextCoordinates,
} from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch, TextRegion } from "@plurnk/plurnk-mimetypes";

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
        const root: Record<string, unknown> = Object.create(null);
        for (const section of parseIni(toText(content))) {
            if (section.name === null) {
                for (const k of section.keys) root[k.key] = k.value;
            } else {
                if (typeof root[section.name] !== "object") root[section.name] = Object.create(null);
                const target = root[section.name] as Record<string, string>;
                for (const k of section.keys) target[k.key] = k.value;
            }
        }
        return Object.fromEntries(Object.entries(root).map(([key, value]) => [
            key, typeof value === "object" && value !== null ? { ...value } : value,
        ]));
    }

    // {§mimetype-query}: both structural views consume the same source map.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            const text = toText(content);
            const byPointer = sourceSpans(text);
            return queryJsonpathObject(this.deepJson(content), pattern, (pointer) => byPointer.get(pointer));
        }
        return super.query(content, dialect, pattern, flags);
    }

    override deepXml(content: HandlerContent): Promise<string> {
        const text = toText(content);
        const byPointer = sourceSpans(text);
        return Promise.resolve(projectJsonToXml(
            this.deepJson(content),
            "root",
            (pointer) => byPointer.get(pointer),
            "value",
        ));
    }
}

export interface IniKey {
    key: string;
    value: string;
    line: number;
    valueRegion: TextRegion;
}

export interface IniSection {
    name: string | null; // null = the implicit global section before any header
    line: number;
    endLine: number;
    keys: IniKey[];
}

export function parseIni(text: string): IniSection[] {
    const coordinates = new TextCoordinates(text);
    const lines = TextCoordinates.logicalLines(text)
        .map(({ start, contentEnd }) => text.slice(start, contentEnd));
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
        const entry = /^([^=:]+?)\s*[=:]\s*(.*)$/d.exec(t);
        if (entry) {
            const value = entry[2].trim();
            const start = coordinates.offsetAtPosition(i + 1, 1) + lines[i].indexOf(t) + entry.indices![2]![0] + entry[2].indexOf(value);
            const valueRegion = coordinates.regionFromOffsets(start, start + value.length);
            if (valueRegion === null) throw new Error("INI value has no addressable source region");
            current.keys.push({ key: entry[1].trim(), value, line: i + 1, valueRegion });
        }
    }

    // Drop the implicit global section when it carries no top-level keys.
    return sections.filter((s) => s.name !== null || s.keys.length > 0);
}

function sourceSpans(text: string): Map<string, readonly TextRegion[]> {
    const regions = new Map<string, readonly TextRegion[]>();
    const sections = new Set<string>();
    const coordinates = new TextCoordinates(text);
    const root = coordinates.regionFromOffsets(0, text.length);
    if (root !== null) regions.set("", [root]);
    for (const section of parseIni(text)) {
        const base = section.name === null ? "" : `/${ptr(section.name)}`;
        if (section.name !== null) {
            if (!sections.has(base)) regions.delete(base);
            sections.add(base);
            const region = coordinates.lineRegion(section.line, section.endLine);
            if (region !== null) regions.set(base, [...(regions.get(base) ?? []), region]);
        }
        for (const key of section.keys) regions.set(`${base}/${ptr(key.key)}`, [key.valueRegion]);
    }
    return regions;
}

// JSON Pointer token escape (RFC 6901): ~ → ~0, / → ~1.
function ptr(s: string): string {
    return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function toText(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}
