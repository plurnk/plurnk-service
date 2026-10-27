import { PlurnkParseError, type LineMarker, type Position, type TextLineMarker } from "@plurnk/plurnk-contracts";

export type Advise = (position: Position | undefined, message: string) => void;

// The scope shapes the lexer admits, matched at the right end of the heading text.
export const TAIL_POSITIONS = /\s*(<-?[0-9]+(?:\.[0-9]+)?(?:(?:,\s?|-)-?[0-9]+(?:\.[0-9]+)?)*>)\s*$/u;
export const TAIL_TEXT_SCOPE = /\s*(<(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}|@[0-9]{1,4})(?:(?:,\s?|-)(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}|@[0-9]{1,4}))*>)\s*$/u;
export const TAIL_RELATIVE_SCOPE = /\s*(<[0-9]+, ?\+[0-9]+>)\s*$/u;

const OFFSET_RECOVERY = "Write `<start,+offset>`, `<@abcde,+offset>`, or `<start,end>`.";

const atLeastOne = <T>(values: T[]): values is [T, ...T[]] => values.length > 0;
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

// Scans `<scope>` into ordered numeric components. Separators are `,`
// (with an optional space) or `-`; a `-` immediately starting a component is its
// sign, not a separator. The operation owner assigns roles. {§matcher-prefix-claims}
export const parseLineMarker = (text: string): LineMarker => {
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
    // L_MARKER always matches at least one number, so marks is non-empty.
    if (!atLeastOne(marks)) throw new Error("a line marker names at least one mark");
    return { marks };
};

// {§matcher-prefix-claims}: normalize authored numeric ranges before anchors resolve.
export const parseRangeMarker = (text: string, position: Position = { line: 0, column: 0 }, advise?: Advise): LineMarker => {
    const relative = /^<([0-9]+), ?\+([0-9]+)>$/u.exec(text);
    if (relative === null && text.includes("+")) {
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `invalid scope ${JSON.stringify(text)}; use numeric coordinates or \`@hash\` line anchors`, "error", OFFSET_RECOVERY);
    }
    const marker = relative === null ? parseLineMarker(text)
        : { marks: [Number(relative[1]), Number(relative[2])] as [number, number] };
    const [start, end] = marker.marks;
    const count = marker.marks.length === 2 && Number.isInteger(start) && end !== undefined
        && Number.isInteger(end) && start > 0 && end > 0 && end < start;
    if (relative === null && !count) return marker;
    if (start <= 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `Scope ${text} requires a positive start and safe integer coordinates.`);
    }
    const last = start + (relative === null ? end - 1 : end);
    if (!Number.isSafeInteger(last)) {
        throw new PlurnkParseError(position.line, position.column, "visitor", `Scope ${text} exceeds safe integer coordinates.`);
    }
    advise?.(position, `Scope ${text} was read as <${start},${last}>.`);
    return { marks: [start, last] };
};

export const parseTextLineMarker = (marker: string, position?: Position, advise?: Advise): TextLineMarker => {
    // {§parse-recovery} — `42<@abcde>` is the displayed row prefix copied whole: the
    // scope is the anchor, the digits are dropped, and one advisory names the anchor-only form.
    const prefixed = /^([1-9][0-9]*)(<[\s\S]*)$/u.exec(marker);
    const text = prefixed === null ? marker : prefixed[2];
    if (prefixed !== null) {
        advise?.(position, `\`${marker}\` was read as the scope \`${text}\`; a scope takes the anchor without its displayed line number.`);
    }
    if (!text.includes("@")) {
        return parseRangeMarker(text, position, advise);
    }
    const marks = text.slice(1, -1).split(/, ?/).map((component) => {
        // {§fence-pairing} — `@210` is the line number 210 with the anchor's sigil, not a hash.
        if (/^@[0-9]{1,4}$/u.test(component)) {
            advise?.(position, `\`${component}\` was read as line ${component.slice(1)}; an anchor is five characters (\`@abcde\`).`);
            return Number.parseInt(component.slice(1), 10);
        }
        return component.startsWith("@") ? component : Number.parseFloat(component);
    });
    // {§op-methods-op-dispatch} — anchor-bearing scopes retain their offsets, never count recovery.
    const components = text.slice(1, -1).split(/, ?/);
    for (const [index, component] of components.entries()) {
        if (!component.startsWith("+")) continue;
        const base = /^(@[0-9A-Za-z]{5})([+-][0-9]+)?$/u.exec(String(marks[index - 1] ?? ""));
        if (base === null) {
            throw new PlurnkParseError(position?.line ?? 0, position?.column ?? 0, "visitor",
                `invalid scope ${JSON.stringify(text)}; use numeric coordinates or \`@hash\` line anchors`, "error", OFFSET_RECOVERY);
        }
        const offset = Number(base[2] ?? 0) + Number(component.slice(1));
        marks[index] = offset === 0 ? base[1] : `${base[1]}${offset > 0 ? "+" : ""}${offset}`;
    }
    if (!atLeastOne(marks)) throw new Error("an anchor marker names at least one mark");
    return { marks };
};
