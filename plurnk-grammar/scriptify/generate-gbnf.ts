// Generates dist/plurnk.gbnf — a llama.cpp grammar (GBNF) for constrained sampling.
//
// Three-layer subset invariant: dictated generation (this GBNF) ⊂ prescribed canon
// (plurnk.md) ⊂ permitted parse (ANTLR). The GBNF enumerates suffixes (ε, 1..9)
// because the HEREDOC close-tag match is not context-free; bodies are encoded as
// complement automata over each close literal ("any text not containing :OPsuffix")
// so llama.cpp parse stacks stay deterministic.
//
// The rule model is exported for the integration tests (corpus derivability +
// seeded fuzz against PlurnkParser); the file write only happens when run as a script.
import { mkdir, writeFile } from "node:fs/promises";

export type GItem =
    | { kind: "lit"; text: string }
    | { kind: "cls"; ranges: Array<[number, number]>; negate: boolean }
    | { kind: "ref"; name: string }
    | { kind: "rep"; item: GItem; min: 0 | 1; max: number };
export type GSeq = GItem[];
export type GRule = GSeq[];
export type GModel = Map<string, GRule>;

const lit = (text: string): GItem => ({ kind: "lit", text });
const ref = (name: string): GItem => ({ kind: "ref", name });
const opt = (item: GItem): GItem => ({ kind: "rep", item, min: 0, max: 1 });
const star = (item: GItem): GItem => ({ kind: "rep", item, min: 0, max: Infinity });
const plus = (item: GItem): GItem => ({ kind: "rep", item, min: 1, max: Infinity });

const R = (a: string, b: string): [number, number] => [a.codePointAt(0)!, b.codePointAt(0)!];
const C = (chars: string): Array<[number, number]> => [...chars].map((ch) => R(ch, ch));
const cls = (ranges: Array<[number, number]>, negate = false): GItem => ({ kind: "cls", ranges, negate });

const OPS = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC"] as const;
const SUFFIXES = ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

const DIGIT = cls([R("0", "9")]);
const TAG_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.-")]);
// The lexer's executor IDENT requires a letter/underscore head; canon dictates lowercase.
const EXEC_HEAD = cls([R("a", "z")]);
const EXEC_TAIL = cls([R("a", "z"), R("0", "9"), ...C("_-")]);
const SCHEME_HEAD = cls([R("a", "z")]);
const SCHEME_TAIL = cls([R("a", "z"), R("0", "9"), ...C("+.-")]);
// `*` admits glob hosts (log://**/get); userinfo, ports, and IPv6 brackets are
// excluded generation-side so WHATWG URL parsing never throws on a derived path.
const HOST_CHAR = cls([R("a", "z"), R("0", "9"), ...C("*.-")]);
const URI_REST_HEAD = cls(C("/?#"));
const URI_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("._~!$&'*+,;=:@%?#/[]-")]);
const BARE_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("._~!$&'*+,;=@%?#/[]-")]);

// Body alphabet excludes control chars (tab/newline/CR allowed) plus the chars
// tracked by the close-literal automaton state.
const CONTROL_RANGES: Array<[number, number]> = [[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x7F]];
const bodyOther = (excluded: string): GItem => cls([...CONTROL_RANGES, ...C(excluded)], true);

// Complement automaton for one close literal: state k = matched the first k chars
// of `close`. Reaching len(close) is forbidden, so the literal never occurs inside
// the body; the statement's trailing close literal is the unique occurrence. Close
// literals are ":" + word — no internal ":" and no borders, so on a mismatch the
// only live restart is ":" → state 1.
const bodyRules = (model: GModel, name: string, close: string): void => {
    for (let k = 0; k < close.length; k++) {
        const expected = close[k];
        const alts: GRule = [];
        if (k + 1 < close.length) alts.push([lit(expected), ref(`${name}-b${k + 1}`)]);
        if (k > 0) alts.push([lit(":"), ref(`${name}-b1`)]);
        alts.push([bodyOther(k === 0 ? ":" : `:${expected}`), ref(`${name}-b0`)]);
        alts.push([]);
        model.set(`${name}-b${k}`, alts);
    }
};

export const buildModel = (): GModel => {
    const model: GModel = new Map();
    const statementAlts: GRule = [];

    for (const op of OPS) {
        for (const suffix of SUFFIXES) {
            const name = op.toLowerCase() + (suffix === "" ? "" : `-${suffix}`);
            const open = `<<${op}${suffix}`;
            const close = `:${op}${suffix}`;
            bodyRules(model, name, close);
            const body = [lit(":"), ref(`${name}-b0`), lit(close)];
            if (op === "SEND") {
                model.set(name, [[lit(open), lit("["), ref("status"), lit("]"), opt(ref("target")), ...body]]);
            } else if (op === "EXEC") {
                model.set(name, [[lit(open), opt(ref("exec-sig")), opt(ref("target")), ...body]]);
            } else {
                model.set(name, [[lit(open), opt(ref("tags")), ref("target"), opt(ref("line")), ...body]]);
            }
            statementAlts.push([ref(name)]);
        }
    }

    model.set("root", [[star(lit("\n")), ref("statement"), star(ref("root-rest")), star(lit("\n"))]]);
    model.set("root-rest", [[plus(lit("\n")), ref("statement")]]);
    model.set("statement", statementAlts);
    model.set("tags", [[lit("["), ref("tag"), star(ref("tag-rest")), lit("]")]]);
    model.set("tag", [[plus(TAG_CHAR)]]);
    model.set("tag-rest", [[lit(","), ref("tag")]]);
    model.set("target", [[lit("("), ref("path"), lit(")")]]);
    model.set("path", [[ref("uri")], [ref("bare")]]);
    model.set("uri", [[ref("scheme"), lit("://"), plus(HOST_CHAR), opt(ref("uri-rest"))]]);
    model.set("scheme", [[SCHEME_HEAD, star(SCHEME_TAIL)]]);
    model.set("uri-rest", [[URI_REST_HEAD, star(URI_CHAR)]]);
    model.set("bare", [[plus(BARE_CHAR)]]);
    model.set("line", [[lit("<"), ref("int"), lit(">")], [lit("<"), ref("int"), lit(","), ref("int"), lit(">")]]);
    model.set("int", [[opt(lit("-")), plus(DIGIT)]]);
    model.set("status", [[DIGIT, DIGIT, DIGIT]]);
    model.set("exec-sig", [[lit("["), EXEC_HEAD, star(EXEC_TAIL), lit("]")]]);
    return model;
};

const escapeLiteral = (text: string): string => text
    .replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

const escapeClassChar = (cp: number): string => {
    if (cp === 0x0A) return "\\n";
    if (cp === 0x0D) return "\\r";
    if (cp === 0x09) return "\\t";
    if (cp < 0x20 || cp === 0x7F) return `\\x${cp.toString(16).padStart(2, "0").toUpperCase()}`;
    const ch = String.fromCodePoint(cp);
    // llama.cpp's GBNF escape table covers \\ \" \[ \] (plus \x \u \t \r \n) — nothing else.
    if (ch === "\\" || ch === "]" || ch === "[") return `\\${ch}`;
    return ch;
};

const serializeClass = (ranges: Array<[number, number]>, negate: boolean): string => {
    // `-` is a range operator mid-class; emitting it as the final element keeps it literal.
    const sorted = ranges.toSorted((a, b) => Number(a[0] === a[1] && a[0] === 0x2D) - Number(b[0] === b[1] && b[0] === 0x2D));
    const parts = sorted.map(([a, b]) => {
        if (a === b) return a === 0x2D ? "-" : escapeClassChar(a);
        return `${escapeClassChar(a)}-${escapeClassChar(b)}`;
    });
    return `[${negate ? "^" : ""}${parts.join("")}]`;
};

const serializeItem = (item: GItem): string => {
    switch (item.kind) {
        case "lit": return `"${escapeLiteral(item.text)}"`;
        case "cls": return serializeClass(item.ranges, item.negate);
        case "ref": return item.name;
        case "rep": {
            const suffix = item.max === 1 ? "?" : item.min === 0 ? "*" : "+";
            return serializeItem(item.item) + suffix;
        }
    }
};

export const serializeGbnf = (model: GModel): string => {
    const lines = ["# @generated by scriptify/generate-gbnf.ts — do not edit; run `npm run build:gbnf`."];
    for (const [name, alts] of model) {
        const hasEpsilon = alts.some((seq) => seq.length === 0);
        const bodies = alts.filter((seq) => seq.length > 0).map((seq) => seq.map(serializeItem).join(" "));
        if (hasEpsilon) {
            lines.push(`${name} ::= (${bodies.join(" | ")})?`);
        } else {
            lines.push(`${name} ::= ${bodies.join(" | ")}`);
        }
    }
    return lines.join("\n") + "\n";
};

if (import.meta.main) {
    await mkdir("dist", { recursive: true });
    const model = buildModel();
    await writeFile("dist/plurnk.gbnf", serializeGbnf(model));
    process.stderr.write(`Generated dist/plurnk.gbnf: ${model.size} rules.\n`);
}
