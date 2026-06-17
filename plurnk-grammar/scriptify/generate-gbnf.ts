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

const OPS = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "KILL", "PLAN"] as const;
// ε plus 1..9. IRREDUCIBLE, do not "optimize" to `[1-9]*`: the close tag must MATCH
// the open suffix (`<<EDITk … :EDITk`) AND the body automaton must exclude that exact
// close literal — both context-sensitive, which a CFG (GBNF, no backrefs) cannot
// express for a general suffix. The only encoding that honors matching + exclusion is
// a bounded, enumerated set, one production per value. This is the source of most of
// the artifact's bulk, and it is the price of reliable same-op nesting up to depth 9
// (single digit). ANTLR parses any suffix (`[A-Za-z0-9_]+`); the GBNF dictates a
// single digit and canon teaches `1`.
const SUFFIXES = ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

const DIGIT = cls([R("0", "9")]);
const WS = cls(C(" \t\r\n")); // one whitespace char; `star(WS)` is the strict/plan inter-op separator
const TAG_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.-")]);
// The lexer's executor IDENT requires a letter/underscore head; canon dictates lowercase.
const EXEC_HEAD = cls([R("a", "z")]);
const EXEC_TAIL = cls([R("a", "z"), R("0", "9"), ...C("_-")]);

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
    const opAlts: GRule = [];
    const sendMidAlts: GRule = [];
    const sendFinalAlts: GRule = [];
    const planAlts: GRule = [];

    for (const op of OPS) {
        for (const suffix of SUFFIXES) {
            const name = op.toLowerCase() + (suffix === "" ? "" : `-${suffix}`);
            const open = `<<${op}${suffix}`;
            const close = `:${op}${suffix}`;
            bodyRules(model, name, close);
            const body = [lit(":"), ref(`${name}-b0`), lit(close)];
            if (op === "SEND") {
                // The status code is the LOOP-CONTROL signal, load-bearing only on the
                // terminator: the turn closes on a pathless SEND[102]/[200] (send-final),
                // excluded from mid position so nothing follows it (#29). Every OTHER
                // SEND is communication, not loop control — status optional: targeted
                // (a message to a path) or pathless, with any status or none.
                model.set(`${name}-mid`, [
                    [lit(open), lit("["), ref("status"), lit("]"), ref("target"), ...body],  // targeted, with status
                    [lit(open), ref("target"), ...body],                                      // targeted, statusless
                    [lit(open), lit("["), ref("status-mid"), lit("]"), ...body],             // pathless, non-terminal status
                    [lit(open), ...body],                                                     // pathless, statusless
                ]);
                model.set(`${name}-final`, [[lit(open), lit("["), ref("status-final"), lit("]"), ...body]]);
                sendMidAlts.push([ref(`${name}-mid`)]);
                sendFinalAlts.push([ref(`${name}-final`)]);
            } else if (op === "EXEC") {
                model.set(name, [[lit(open), opt(ref("exec-sig")), opt(ref("target")), ...body]]);
            } else if (op === "PLAN") {
                // Dictated form is slotless: bare reasoning body. Mid-batch only via
                // op-statement placement — a turn still closes with the status SEND.
                model.set(name, [[lit(open), ...body]]);
            } else if (op === "KILL") {
                // Signal (unix signal number) is wired but untaught — canon shows bare KILL.
                model.set(name, [[lit(open), opt(ref("kill-sig")), ref("target"), ...body]]);
            } else {
                model.set(name, [[lit(open), opt(ref("tags")), ref("target"), opt(ref("line")), ...body]]);
            }
            if (op !== "SEND") opAlts.push([ref(name)]);
            if (op === "PLAN") planAlts.push([ref(name)]);
        }
    }

    // Turn shape (#29). The single shipped grammar (plurnk.gbnf) is the plan root:
    // a turn opens with a PLAN op (a forced reasoning step), proceeds strict (ops
    // only, whitespace-separated, no free text between), and closes on exactly one
    // pathless SEND[102]/[200] status update — after which nothing is admissible.
    // Termination is structural (forced EOS), not an optional stop a near-greedy
    // decoder can sail past. Degeneration *inside* a body remains unboundable
    // (content is content); the consumer max_tokens cap is the backstop.
    //
    // Inter-op separator is up to 7 whitespace chars, including none (`WS{0,7}`):
    // ops may be glued or split by any spaces/tabs/newlines the model favors
    // (CRLF blank lines, single-level indent, etc.) — but bounded, so a degenerate
    // decoder can't stall in an unbounded whitespace run. No non-whitespace text
    // intrudes. The cap also restores forced-EOS after the final SEND.
    model.set("sep", [Array.from({ length: 7 }, () => opt(WS))]);
    model.set("batch-step", [[ref("mid-statement"), ref("sep")]]);
    model.set("mid-statement", [[ref("op-statement")], [ref("send-mid-any")]]);
    // root-plan: the turn MUST open with a PLAN op, then proceed strict — ops only,
    // whitespace-separated, closed by the final pathless status SEND.
    model.set("root-plan", [[ref("sep"), ref("plan-batch-step"), star(ref("batch-step")), ref("send-final-any"), ref("sep")]]);
    model.set("plan-batch-step", [[ref("plan-statement"), ref("sep")]]);
    model.set("plan-statement", planAlts);
    model.set("op-statement", opAlts);
    model.set("send-mid-any", sendMidAlts);
    model.set("send-final-any", sendFinalAlts);
    model.set("send-statement", [[ref("send-mid-any")], [ref("send-final-any")]]);
    model.set("statement", [[ref("op-statement")], [ref("send-statement")]]);
    // status-final: the three loop dispositions the model may close a turn with —
    // 102 continue (re-invoke now), 202 parked (suspend until a wake event), 200 done.
    // status-mid: any 3-digit code EXCEPT 102, 200, and 202 (finite-literal complement).
    model.set("status-final", [[lit("102")], [lit("200")], [lit("202")]]);
    model.set("status-mid", [
        [lit("10"), cls([R("0", "1"), R("3", "9")])],
        [lit("1"), cls([R("1", "9")]), DIGIT],
        [lit("20"), cls([R("1", "1"), R("3", "9")])],
        [lit("2"), cls([R("1", "9")]), DIGIT],
        [cls([R("0", "0"), R("3", "9")]), DIGIT, DIGIT],
    ]);
    model.set("tags", [[lit("["), ref("tag"), star(ref("tag-rest")), lit("]")]]);
    model.set("tag", [[plus(TAG_CHAR)]]);
    model.set("tag-rest", [[lit(","), ref("tag")]]);
    // Target is an OPAQUE blob — any non-`)`/`<`/control run. The grammar does not
    // litigate what a path contains (scheme, host, regex, glob, channel): that is
    // the visitor's job. Mirrors the ANTLR `TARGET` lexer mode (`~[)<\r\n]`), so
    // colons, spaces, drives, and `#…#` regexes all generate. `L(GBNF) ⊆ L(ANTLR)`
    // holds because this is a strict subset of TARGET_INNER. (Regex groups need a
    // `)` inside the target — ANTLR accepts them via TARGET_REGEX; the GBNF stays
    // simple and just doesn't dictate that rarer form for constrained models.)
    model.set("target", [[lit("("), plus(cls([...CONTROL_RANGES, ...C(")<\r\n")], true)), lit(")")]]);
    // N numeric components, comma-separated (the dictated form). `<N>`, `<N,M>`,
    // `<0.7,10,20>` all derive; the dash separator (`<N-M>`) stays parse-side only.
    model.set("line", [[lit("<"), ref("int"), star(ref("line-rest")), lit(">")]]);
    model.set("line-rest", [[lit(","), opt(lit(" ")), ref("int")]]);
    model.set("int", [[opt(lit("-")), plus(DIGIT), opt(ref("frac"))]]);
    model.set("frac", [[lit("."), plus(DIGIT)]]);
    model.set("status", [[DIGIT, DIGIT, DIGIT]]);
    model.set("exec-sig", [[lit("["), EXEC_HEAD, star(EXEC_TAIL), lit("]")]]);
    model.set("kill-sig", [[lit("["), DIGIT, opt(DIGIT), lit("]")]]);
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

// Collect rule names reachable from `rootName` so each artifact carries only the
// rules its root uses — the commit default ships its 2-state text2 without the
// ~40-state opener complement, and vice versa.
const reachableFrom = (model: GModel, rootName: string): Set<string> => {
    const seen = new Set<string>();
    const visit = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        const alts = model.get(name);
        if (!alts) return;
        const walk = (item: GItem): void => {
            if (item.kind === "ref") visit(item.name);
            else if (item.kind === "rep") walk(item.item);
        };
        for (const seq of alts) for (const item of seq) walk(item);
    };
    visit(rootName);
    return seen;
};

export const serializeGbnf = (model: GModel, rootName: string): string => {
    const reachable = reachableFrom(model, rootName);
    const lines = [
        "# @generated by scriptify/generate-gbnf.ts — do not edit; run `npm run build:gbnf`.",
        `root ::= ${rootName}`,
    ];
    for (const [name, alts] of model) {
        if (!reachable.has(name)) continue;
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
    await writeFile("dist/plurnk.gbnf", serializeGbnf(model, "root-plan"));
    process.stderr.write("Generated dist/plurnk.gbnf (plan root)\n");
}
