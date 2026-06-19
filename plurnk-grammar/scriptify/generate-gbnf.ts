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

// Free-text preamble before the PLAN anchor: any text completing NO `<<OP` opener
// (FIND…PLAN…SEND) — an Aho-Corasick complement over the opener trie. Keeping the
// preamble opener-free preserves L(GBNF) ⊆ L(ANTLR): every preamble char re-lexes as
// TEXT, never a statement opener, so the ANTLR `turn` rule's `TEXT*` preamble accepts it.
// Plus the `<<`-run parity the ANTLR TEXT rule demands: the preamble is followed by the
// `<<PLAN` literal, so it must NOT end on an ODD run of trailing `<` (else `…<` + `<<PLAN`
// merges into `<<<PLAN` and the opener is lost). The `<<` trie state splits by run parity
// (even may end, odd may not); the lone-`<` state may not end either.
const preplanRules = (model: GModel): void => {
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
    const ruleOf = (state: string): string => `preplan-s${states.indexOf(state)}`;
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
            if (candidate === literal) continue; // completing an opener is forbidden — no transition
            alts.push([lit(next), ref(ruleOf(candidate))]);
        }
        if (!consumed.has("<")) {
            consumed.add("<");
            const target = trieState === "<<" ? (state === ODD ? "<<" : ODD) : longestSuffixState(trieState + "<");
            alts.push([lit("<"), ref(ruleOf(target))]);
        }
        alts.push([bodyOther([...consumed].join("")), ref(ruleOf(""))]);
        if (state !== "<" && state !== ODD) alts.push([]); // odd trailing-`<` runs may not end
        model.set(ruleOf(state), alts);
    }
    model.set("preplan", [[ref(ruleOf(""))]]);
};

// Left-factor a set of opener literals into a shared-prefix trie. The flat form lists one
// full-literal alternative per op variant (`"<<FIND"`, `"<<FIND1"`, … `"<<KILL9"`), so the
// instant `<<` is consumed EVERY variant's parse stack is live in parallel — ~141 stacks at
// the single hottest decision in the grammar, the per-token cost driver in llama.cpp. The
// trie shares `<<` and the op-name prefix, so after `<<` only the distinct first letters are
// live (~8) and the count narrows as letters are consumed. Pure left-factoring: each entry's
// `tails` are the alternatives that follow its literal, re-attached at the leaf; a literal
// that is a prefix of another (`<<SEND` ⊂ `<<SEND1`) keeps its tails at the interior node
// alongside the deeper branch. L(trie) = L(flat alternation), proven via the @plurnk/gbnf
// differential oracle. The per-suffix body automata are untouched — they are 1 stack each,
// off the hot path, and remain the artifact's bulk (see SUFFIXES).
const trieRules = (model: GModel, rootName: string, entries: Array<{ literal: string; tails: GSeq[] }>): void => {
    type Node = { children: Map<string, Node>; tails: GSeq[] };
    const newNode = (): Node => ({ children: new Map(), tails: [] });
    const root = newNode();
    for (const { literal, tails } of entries) {
        let node = root;
        for (const ch of literal) {
            if (!node.children.has(ch)) node.children.set(ch, newNode());
            node = node.children.get(ch)!;
        }
        node.tails.push(...tails);
    }
    let counter = 0;
    const build = (node: Node, name: string): void => {
        const alts: GRule = [...node.tails];
        for (const ch of [...node.children.keys()].toSorted()) {
            const childName = `${rootName}-${counter++}`;
            build(node.children.get(ch)!, childName);
            alts.push([lit(ch), ref(childName)]);
        }
        model.set(name, alts);
    };
    build(root, rootName);
};

export const buildModel = (): GModel => {
    const model: GModel = new Map();
    const opEntries: Array<{ literal: string; tails: GSeq[] }> = [];
    const sendMidEntries: Array<{ literal: string; tails: GSeq[] }> = [];
    const sendFinalEntries: Array<{ literal: string; tails: GSeq[] }> = [];

    for (const op of OPS) {
        for (const suffix of SUFFIXES) {
            // PLAN is allowed but inert: bare `<<PLAN` only, no numeric suffix (a suffix
            // would let a model emit the malformed `<<PLAN1`). Reasoning lives in the
            // <think> preamble now, not a mandated or depth-nested PLAN.
            if (op === "PLAN" && suffix !== "") continue;
            const name = op.toLowerCase() + (suffix === "" ? "" : `-${suffix}`);
            const open = `<<${op}${suffix}`;
            const close = `:${op}${suffix}`;
            bodyRules(model, name, close);
            const body = [lit(":"), ref(`${name}-b0`), lit(close)];
            if (op === "SEND") {
                // The loop-disposition codes (102/202/200) are RESERVED for loop control:
                // they are terminal-ALWAYS, excluded from every mid form, so a SEND carrying
                // one ends the turn regardless of whether it has a path (#29). The terminal
                // is therefore path-AGNOSTIC — `send-final` takes an optional target, so a
                // turn can terminate-and-report in one op (e.g. a child reporting its result
                // to its parent run). Every mid SEND is communication, not loop control:
                // non-loop status (status-mid) or none, targeted or pathless.
                // Tails are factored behind the shared `<<SEND…` opener trie (no leading
                // `lit(open)` — the trie matches it). `<<SEND` is a prefix of `<<SEND1`, so
                // its tails sit at the interior trie node beside the digit branch.
                sendMidEntries.push({ literal: open, tails: [
                    [lit("["), ref("status-mid"), lit("]"), ref("target"), ...body],  // targeted, non-loop status
                    [ref("target"), ...body],                                          // targeted, statusless
                    [lit("["), ref("status-mid"), lit("]"), ...body],                  // pathless, non-loop status
                    [...body],                                                          // pathless, statusless
                ] });
                sendFinalEntries.push({ literal: open, tails: [
                    [lit("["), ref("status-final"), lit("]"), opt(ref("target")), ...body],
                ] });
            } else if (op === "EXEC") {
                opEntries.push({ literal: open, tails: [[opt(ref("exec-sig")), opt(ref("target")), ...body]] });
            } else if (op === "PLAN") {
                // Slotless bare reasoning body. The standalone `plan` rule is the MANDATORY
                // turn anchor (root-turn references it); PLAN is ALSO an inert mid-op, so it
                // joins the op-statement trie too. Both share the `plan-b0` body automaton.
                model.set("plan", [[lit(open), ...body]]);
                opEntries.push({ literal: open, tails: [[...body]] });
            } else if (op === "KILL") {
                // Signal (unix signal number) is wired but untaught — canon shows bare KILL.
                opEntries.push({ literal: open, tails: [[opt(ref("kill-sig")), ref("target"), ...body]] });
            } else {
                opEntries.push({ literal: open, tails: [[opt(ref("tags")), ref("target"), opt(ref("line")), ...body]] });
            }
        }
    }

    // Turn shape — the PLAN-anchored sandwich `*:PLAN:OPS:SEND[N]`:
    //
    //   root-turn ::= preplan plan sep batch-step* send-final-any sep
    //
    // `preplan` is a FREE reasoning prefix — any text up to the first `<<PLAN`. The
    // grammar names NO reasoning delimiter, so it is format-agnostic: a reasoning model
    // emits its native channel here (the provider separates it into reasoning_content); a
    // non-reasoning model emits nothing. Either way, because the prefix forbids no token
    // but the `<<PLAN` literal, it does NOT mask the model's native reasoning token (the
    // failure mode of a delimiter-specific grammar) — reasoning flows and separates. The
    // parser discards everything before the first `<<PLAN`.
    //
    // A MANDATORY `<<PLAN` then anchors strict enforcement. It is the model's PUBLIC
    // statement of intent: a reasoning model distills its private CoT into it; a
    // non-reasoning model reasons in it. After PLAN: ops only, whitespace-separated, no
    // prose, closed by exactly one terminal status SEND (102/202/200/300/499).
    //
    // Termination is structural (forced EOS after the final SEND). Degeneration *inside*
    // a body — or an unbounded `preplan` ramble that never reaches `<<PLAN` — remains
    // unboundable (content is content); the consumer max_tokens cap is the backstop.
    //
    // Inter-op separator is up to 7 whitespace chars (`WS{0,7}`): glued or split, but
    // bounded, so a degenerate decoder can't stall in an unbounded whitespace run.
    model.set("sep", [Array.from({ length: 7 }, () => opt(WS))]);
    model.set("batch-step", [[ref("mid-statement"), ref("sep")]]);
    model.set("mid-statement", [[ref("op-statement")], [ref("send-mid-any")]]);
    // preplan: the free reasoning prefix — any text completing no `<<OP` opener, so the
    // first `<<PLAN` is the unambiguous anchor and the preamble re-lexes as pure TEXT.
    preplanRules(model);
    model.set("root-turn", [[ref("preplan"), ref("plan"), ref("sep"), star(ref("batch-step")), ref("send-final-any"), ref("sep")]]);
    trieRules(model, "op-statement", opEntries);
    trieRules(model, "send-mid-any", sendMidEntries);
    trieRules(model, "send-final-any", sendFinalEntries);
    // statement / send-statement: single-statement entries used only by the corpus and
    // fuzz tests; unreachable from root-turn, so pruned from the shipped artifact.
    model.set("send-statement", [[ref("send-mid-any")], [ref("send-final-any")]]);
    model.set("statement", [[ref("op-statement")], [ref("send-statement")]]);
    // status-final: model-emittable turn-closers — 102 continue, 202 parked,
    // 200 done (success), 499 give-up (HTTP 499 client-closed), and 300 = a question
    // for the user (awaiting input). 300 is ALLOWED/emittable but UNTAUGHT in canon (no
    // example) — staged ahead of the engine like 202/500 were; an unrecognized terminal
    // degrades gracefully (no state change) until the service handles it. NOT 500:
    // "failed" is an ENGINE verdict, never a model SEND (persisted-only). Emittable vs
    // persisted (Loop.status) are meant to differ — see plurnk-service#33.
    // status-mid: any 3-digit code EXCEPT the terminals 102, 200, 202, 300, 499.
    model.set("status-final", [[lit("102")], [lit("200")], [lit("202")], [lit("300")], [lit("499")]]);
    model.set("status-mid", [
        [lit("10"), cls([R("0", "1"), R("3", "9")])],
        [lit("1"), cls([R("1", "9")]), DIGIT],
        [lit("20"), cls([R("1", "1"), R("3", "9")])],
        [lit("2"), cls([R("1", "9")]), DIGIT],
        [lit("30"), cls([R("1", "9")])],
        [lit("3"), cls([R("1", "9")]), DIGIT],
        [lit("4"), cls([R("0", "8")]), DIGIT],
        [lit("49"), cls([R("0", "8")])],
        [cls([R("0", "0"), R("5", "9")]), DIGIT, DIGIT],
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
    await writeFile("dist/plurnk.gbnf", serializeGbnf(model, "root-turn"));
    process.stderr.write("Generated dist/plurnk.gbnf (PLAN-anchored turn: *:PLAN:OPS:SEND)\n");
}
