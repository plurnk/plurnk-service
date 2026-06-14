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

// Free text for the lax root: any characters that never contain a complete open
// literal (`<<FIND` … `<<PLAN`). Aho-Corasick complement over the literal trie —
// state = longest literal prefix matched by the current suffix. Completing a
// literal has no transition (the text interpretation dies; the parallel statement
// interpretation takes over). One consistency constraint with the ANTLR TEXT
// rule: text may not END with an ODD run of trailing `<` — `text<` + `<<OP`
// merges into `<<<OP`, which the lexer treats as all text, and the two layers
// would disagree about where the statement starts. The `<<` trie state therefore
// splits by run parity (even may end, odd may not).
const textRules = (model: GModel): void => {
    const literals = OPS.map((op) => `<<${op}`);
    const states: string[] = [""];
    for (const literal of literals) {
        for (let k = 1; k < literal.length; k++) {
            const prefix = literal.slice(0, k);
            if (!states.includes(prefix)) states.push(prefix);
        }
    }
    const ODD = "<<{odd-run}"; // suffix is `<<` but the trailing `<` run is odd
    states.push(ODD);
    const ruleOf = (state: string): string => `text-s${states.indexOf(state)}`;
    const longestSuffixState = (candidate: string): string => {
        for (let i = 1; i < candidate.length; i++) {
            if (states.includes(candidate.slice(i))) return candidate.slice(i);
        }
        return "";
    };
    for (const state of states) {
        const trieState = state === ODD ? "<<" : state;
        const alts: GRule = [];
        const consumed = new Set<string>();
        for (const literal of literals) {
            if (!literal.startsWith(trieState)) continue;
            const next = literal[trieState.length];
            if (consumed.has(next)) continue;
            consumed.add(next);
            const candidate = trieState + next;
            // Completing a literal is forbidden — no transition at all.
            if (candidate === literal) continue;
            alts.push([lit(next), ref(ruleOf(candidate))]);
        }
        if (!consumed.has("<")) {
            consumed.add("<");
            const target = trieState === "<<" ? (state === ODD ? "<<" : ODD) : longestSuffixState(trieState + "<");
            alts.push([lit("<"), ref(ruleOf(target))]);
        }
        alts.push([bodyOther([...consumed].join("")), ref(ruleOf(""))]);
        if (state !== "<" && state !== ODD) alts.push([]);
        model.set(ruleOf(state), alts);
    }
    model.set("text", [[ref(ruleOf(""))]]);
};

export const buildModel = (): GModel => {
    const model: GModel = new Map();
    const opAlts: GRule = [];
    const sendMidAlts: GRule = [];
    const sendFinalAlts: GRule = [];

    for (const op of OPS) {
        for (const suffix of SUFFIXES) {
            const name = op.toLowerCase() + (suffix === "" ? "" : `-${suffix}`);
            const open = `<<${op}${suffix}`;
            const close = `:${op}${suffix}`;
            bodyRules(model, name, close);
            const body = [lit(":"), ref(`${name}-b0`), lit(close)];
            if (op === "SEND") {
                // Two forms (#29). Mid-batch: targeted (any status) or pathless with a
                // non-terminal status. Final: pathless 102/200 — the turn's status
                // update. The final form is EXCLUDED from mid position so that after
                // it nothing is admissible and the sampler is forced to stop.
                model.set(`${name}-mid`, [
                    [lit(open), lit("["), ref("status"), lit("]"), ref("target"), ...body],
                    [lit(open), lit("["), ref("status-mid"), lit("]"), ...body],
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
        }
    }

    // Turn shapes (#29). Both roots close on exactly one pathless SEND[102]/[200]
    // status update, after which nothing is admissible — the sampler is FORCED to
    // stop. Termination is structural, not an optional EOS a near-greedy decoder
    // can sail past. Degeneration *inside* a body or text segment remains
    // unboundable (content is content); the consumer max_tokens cap is backstop.
    //
    // Four roots, one per shipped artifact (most→least committed on `<<`):
    //
    // root-commit (the DEFAULT, plurnk.gbnf): free reasoning text and statements
    // interleave, EOS at any boundary — BUT `<<` is a hard commit. Prose may
    // contain a lone `<` and never `<<`, so the *only* way to produce `<<` is to
    // begin a real operation. Operation-lookalike garbage (`<<RANDOM`) cannot
    // exist even as text: at `<<` the sampler is forced into a valid op. Leaner
    // than root-open (the text automaton is 2 states, not the ~40-state opener
    // complement). Tradeoff: a fumbled verb is coerced toward a real op, and `<<`
    // is unwritable in prose. Retreat path is plurnk-free.gbnf if that bites.
    //
    // root-open (plurnk-free.gbnf): free text and statements interleave, `<<`
    // escapable to text. Prose may contain `<<`; an opener-lookalike that never
    // completes a real keyword stays inert text. The permissive fallback.
    //
    // root-closed (plurnk-closed.gbnf): root-open text, but the turn must close
    // with the final pathless SEND[102]/[200] — structural termination for
    // models that ramble past optional EOS.
    //
    // root-strict (plurnk-strict.gbnf): ops only, bounded 1-2 newline
    // separators. For models that don't reason and benefit from the tightest rail.
    // Text directly after a close tag must be newline-led: the lexer's close-tag
    // predicate requires a non-ident follow char, so `:KILL4` + text "9..." would
    // glue into the close tag and the body would never end. Leading text and
    // glued statements are safe (`<` is non-ident).
    model.set("root-commit", [[ref("text2"), star(ref("commit-step"))]]);
    model.set("commit-step", [[ref("statement"), opt(ref("text-after2"))]]);
    model.set("text-after2", [[lit("\n"), ref("text2")]]);
    // text2: free text that can never contain `<<` and never ends on a lone `<`
    // (a trailing `<` + a following `<<OP` would merge into `<<<OP` and the lexer
    // would read it as all text). 2 states: -a accepts/ends, -b just saw `<` and
    // must consume a non-`<` before it can end or continue.
    model.set("text2", [[ref("text2-a")]]);
    model.set("text2-a", [[bodyOther("<"), ref("text2-a")], [lit("<"), ref("text2-b")], []]);
    model.set("text2-b", [[bodyOther("<"), ref("text2-a")]]);
    model.set("root-open", [[ref("text"), star(ref("open-step"))]]);
    model.set("open-step", [[ref("statement"), opt(ref("text-after"))]]);
    model.set("root-closed", [[ref("text"), star(ref("closed-step")), ref("send-final-any"), opt(lit("\n"))]]);
    model.set("closed-step", [[ref("mid-statement"), opt(ref("text-after"))]]);
    model.set("text-after", [[lit("\n"), ref("text")]]);
    textRules(model);
    model.set("root-strict", [[opt(lit("\n")), star(ref("batch-step")), ref("send-final-any"), opt(lit("\n"))]]);
    model.set("batch-step", [[ref("mid-statement"), lit("\n"), opt(lit("\n"))]]);
    model.set("mid-statement", [[ref("op-statement")], [ref("send-mid-any")]]);
    model.set("op-statement", opAlts);
    model.set("send-mid-any", sendMidAlts);
    model.set("send-final-any", sendFinalAlts);
    model.set("send-statement", [[ref("send-mid-any")], [ref("send-final-any")]]);
    model.set("statement", [[ref("op-statement")], [ref("send-statement")]]);
    // status-final: the two loop-status codes the model may close a turn with.
    // status-mid: any 3-digit code EXCEPT 102 and 200 (finite-literal complement).
    model.set("status-final", [[lit("102")], [lit("200")]]);
    model.set("status-mid", [
        [lit("10"), cls([R("0", "1"), R("3", "9")])],
        [lit("1"), cls([R("1", "9")]), DIGIT],
        [lit("20"), cls([R("1", "9")])],
        [lit("2"), cls([R("1", "9")]), DIGIT],
        [cls([R("0", "0"), R("3", "9")]), DIGIT, DIGIT],
    ]);
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
    await writeFile("dist/plurnk.gbnf", serializeGbnf(model, "root-commit"));
    await writeFile("dist/plurnk-free.gbnf", serializeGbnf(model, "root-open"));
    await writeFile("dist/plurnk-closed.gbnf", serializeGbnf(model, "root-closed"));
    await writeFile("dist/plurnk-strict.gbnf", serializeGbnf(model, "root-strict"));
    process.stderr.write("Generated dist/plurnk.gbnf (commit) + plurnk-free.gbnf + plurnk-closed.gbnf + plurnk-strict.gbnf\n");
}
