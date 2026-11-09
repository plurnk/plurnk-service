import { PlurnkParseError, type LineMarker, type Position, type TextLineMarker } from "@plurnk/plurnk-contracts";

export type Advise = (position: Position | undefined, message: string) => void;

const VALID_NUMERIC_SCOPE = /^<-?[0-9]+(?:\.[0-9]+)?(?:(?:,\s?|-)-?[0-9]+(?:\.[0-9]+)?)*>$/u;
const VALID_RELATIVE_SCOPE = /^<([0-9]+), ?\+([0-9]+)>$/u;
const VALID_TEXT_SCOPE = /^(?:[1-9][0-9]*)?<(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}(?:[+-][0-9]+)?|@[0-9]{1,4})(?:(?:,\s?|-)(?:-?[0-9]+(?:\.[0-9]+)?|\+[0-9]+|@[0-9A-Za-z]{5}(?:[+-][0-9]+)?|@[0-9]{1,4}))*>$/u;

const OFFSET_RECOVERY = 'Write `range: "start,end"` or `range: "@start,@end"`.';

const atLeastOne = <T>(values: T[]): values is [T, ...T[]] => values.length > 0;
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

const stripBoundaryCommas = (s: string): string =>
    s.replace(/^,+|,+$/gu, "").trim();

const wrapScope = (raw: string): string => {
    const trimmed = raw.trim();
    const linesCount = /^([1-9][0-9]*)\s+lines?$/iu.exec(trimmed);
    if (linesCount !== null) {
        return `<1,${linesCount[1]}>`;
    }
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
        return `<${stripBoundaryCommas(trimmed.slice(1, -1))}>`;
    }
    const prefixed = /^([1-9][0-9]*)<([\s\S]*)>$/u.exec(trimmed);
    if (prefixed !== null) {
        return `${prefixed[1]}<${stripBoundaryCommas(prefixed[2])}>`;
    }
    return `<${stripBoundaryCommas(trimmed)}>`;
};

const unwrapScope = (text: string): string =>
    text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text;

// Scans range coordinates into ordered numeric components. Separators are `,`
// (with an optional space) or `-`; a `-` immediately starting a component is its
// sign, not a separator. The operation owner assigns roles. {§matcher-prefix-claims}
export const parseLineMarker = (raw: string, position: Position = { line: 0, column: 0 }): LineMarker => {
    const text = wrapScope(raw);
    if (!VALID_NUMERIC_SCOPE.test(text)) {
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `invalid range ${JSON.stringify(raw)}; expected numeric coordinates`, "error", OFFSET_RECOVERY);
    }
    const inner = text.slice(1, -1);
    const marks: number[] = [];
    let i = 0;
    while (i < inner.length) {
        let j = i;
        if (inner[j] === "-") j++;
        while (isDigit(inner[j])) j++;
        if (inner[j] === "." && isDigit(inner[j + 1])) {
            j++;
            while (isDigit(inner[j])) j++;
        }
        marks.push(Number.parseFloat(inner.slice(i, j)));
        i = j;
        if (inner[i] === ",") {
            i++;
            if (inner[i] === " ") i++;
        } else if (inner[i] === "-") {
            i++;
        } else {
            break;
        }
    }
    if (!atLeastOne(marks)) throw new Error("a line marker names at least one mark");
    return { marks };
};

// {§matcher-prefix-claims}: normalize authored numeric ranges before anchors resolve.
export const parseRangeMarker = (raw: string, position: Position = { line: 0, column: 0 }, advise?: Advise): LineMarker => {
    const text = wrapScope(raw);
    const inner = unwrapScope(text);
    const relative = VALID_RELATIVE_SCOPE.exec(text);
    if (relative === null && (text.includes("+") || !VALID_NUMERIC_SCOPE.test(text))) {
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `invalid range ${JSON.stringify(raw)}; use numeric coordinates or \`@hash\` line anchors`, "error", OFFSET_RECOVERY);
    }
    const marker = relative === null ? parseLineMarker(text, position)
        : { marks: [Number(relative[1]), Number(relative[2])] as [number, number] };
    const [start, end] = marker.marks;
    const count = marker.marks.length === 2 && Number.isInteger(start) && end !== undefined
        && Number.isInteger(end) && start > 0 && end > 0 && end < start;
    if (relative === null && !count) return marker;
    if (start <= 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `Range ${JSON.stringify(inner)} requires a positive start and safe integer coordinates.`);
    }
    const last = start + (relative === null ? end - 1 : end);
    if (!Number.isSafeInteger(last)) {
        throw new PlurnkParseError(position.line, position.column, "visitor", `Range ${JSON.stringify(inner)} exceeds safe integer coordinates.`);
    }
    advise?.(position, `Range ${JSON.stringify(inner)} was read as "${start},${last}".`);
    return { marks: [start, last] };
};

export const parseTextLineMarker = (raw: string, position: Position = { line: 0, column: 0 }, advise?: Advise): TextLineMarker => {
    let marker = wrapScope(raw);
    if (!VALID_TEXT_SCOPE.test(marker) && /(?:<@[0-9A-Za-z]{5}(?:[+-][0-9]+)?>?|@[0-9A-Za-z]{5}(?:[+-][0-9]+)?>)/u.test(raw)) {
        const stripped = raw.trim().replace(/(?:[1-9][0-9]*)?<?(@[0-9A-Za-z]{5}(?:[+-][0-9]+)?)>?/gu, "$1");
        marker = wrapScope(stripped);
        if (VALID_TEXT_SCOPE.test(marker)) {
            advise?.(position, `\`${raw.trim()}\` was read as the range ${JSON.stringify(unwrapScope(marker))}; a range takes the anchor without \`<...>\` brackets.`);
        }
    }
    if (!VALID_TEXT_SCOPE.test(marker)) {
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `invalid range ${JSON.stringify(raw)}; use numeric coordinates or \`@hash\` line anchors`, "error", OFFSET_RECOVERY);
    }
    // {§parse-recovery} — `42<@abcde>` is the displayed row prefix copied whole: the
    // range is the anchor, the digits are dropped, and one advisory names the anchor-only form.
    const prefixed = /^([1-9][0-9]*)(<[\s\S]*)$/u.exec(marker);
    const text = prefixed === null ? marker : prefixed[2];
    if (prefixed !== null) {
        advise?.(position, `\`${marker}\` was read as the range ${JSON.stringify(unwrapScope(text))}; a range takes the anchor without its displayed line number.`);
    }
    if (!text.includes("@")) {
        return parseRangeMarker(unwrapScope(text), position, advise);
    }
    const inner = text.slice(1, -1);
    const components: string[] = [];
    let cursor = 0;
    while (cursor < inner.length) {
        const match = /^(@[0-9A-Za-z]{5}(?:[+-][0-9]+)?|@[0-9]{1,4}|\+[0-9]+|-?[0-9]+(?:\.[0-9]+)?)/u.exec(inner.slice(cursor));
        if (match === null) break;
        components.push(match[1]);
        cursor += match[1].length;
        if (inner[cursor] === ",") {
            cursor += 1;
            if (inner[cursor] === " ") cursor += 1;
        } else if (inner[cursor] === "-") {
            cursor += 1;
        } else {
            break;
        }
    }
    const marks = components.map((component) => {
        // {§fence-pairing} — `@210` is the line number 210 with the anchor's sigil, not a hash.
        if (/^@[0-9]{1,4}$/u.test(component)) {
            advise?.(position, `\`${component}\` was read as line ${component.slice(1)}; an anchor is five characters (\`@abcde\`).`);
            return Number.parseInt(component.slice(1), 10);
        }
        return component.startsWith("@") ? component : Number.parseFloat(component);
    });
    // {§op-methods-op-dispatch} — anchor-bearing ranges retain their offsets, never count recovery.
    for (const [index, component] of components.entries()) {
        if (!component.startsWith("+")) continue;
        const base = /^(@[0-9A-Za-z]{5})([+-][0-9]+)?$/u.exec(String(marks[index - 1] ?? ""));
        if (base === null) {
            throw new PlurnkParseError(position.line, position.column, "visitor",
                `invalid range ${JSON.stringify(unwrapScope(text))}; use numeric coordinates or \`@hash\` line anchors`, "error", OFFSET_RECOVERY);
        }
        const offset = Number(base[2] ?? 0) + Number(component.slice(1));
        marks[index] = offset === 0 ? base[1] : `${base[1]}${offset > 0 ? "+" : ""}${offset}`;
    }
    if (marks.length === 2 && typeof marks[0] === "string" && marks[0].startsWith("@") && marks[1] === 1) {
        advise?.(position, `Range "${marks[0]},1" was read as "${marks[0]}".`);
        return { marks: [marks[0]] };
    }
    if (
        marks.length === 3
        && typeof marks[0] === "string" && marks[0].startsWith("@")
        && typeof marks[1] === "string" && marks[1].startsWith("@")
        && typeof marks[2] === "number"
    ) {
        const reordered: [string, number, string] = [marks[0], marks[2], marks[1]];
        advise?.(position, `Range "${marks.join(",")}" was read as "${reordered.join(",")}"; a column-scoped range places the start column before the end line.`);
        return { marks: reordered };
    }
    if (
        marks.length === 4
        && typeof marks[0] === "string" && marks[0].startsWith("@")
        && typeof marks[1] === "string" && marks[1].startsWith("@")
        && typeof marks[2] === "number"
        && typeof marks[3] === "number"
    ) {
        const reordered: [string, number, string, number] = [marks[0], marks[2], marks[1], marks[3]];
        advise?.(position, `Range "${marks.join(",")}" was read as "${reordered.join(",")}"; a column-scoped range is "SL,SC,EL,EC".`);
        return { marks: reordered };
    }
    if (!atLeastOne(marks)) throw new Error("an anchor marker names at least one mark");
    return { marks };
};
