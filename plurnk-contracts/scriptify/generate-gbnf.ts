// Generates dist/plurnk.gbnf — a llama.cpp grammar (GBNF) for constrained sampling.
//
// This is a pragmatic generation filter, not a second parser contract. Keeping sampled
// output parseable is a goal balanced against rail size and sampling efficiency, not an
// invariant. Bodies use complement automata over each close literal ("any text not
// containing :OPsuffix") so llama.cpp parse stacks stay deterministic.
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

const OPS = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "WORK", "FORK", "KILL", "PLAN"] as const;
// Ops whose body is a MATCHER pattern (single-line by contract) vs a content body. Pattern
// bodies forbid literal line terminators (the in-body quicksand fix); content bodies allow them.
const PATTERN_OPS = new Set<string>(["FIND", "READ", "OPEN", "FOLD"]);
// The lean rail offers the canonical suffix plus depths 1 and 2. The forgiving parser
// accepts the general suffix shape; deeper generation can use a custom rail.
//
// IRREDUCIBLE form, do not "optimize" to `[1-2]*`: the close tag must MATCH the open
// suffix (`<<EDITk … :EDITk`) AND the body automaton must exclude that exact close
// literal — both context-sensitive, which a CFG (GBNF, no backrefs) cannot express for
// a general suffix. The only encoding that honors matching + exclusion is a bounded,
// enumerated set, one production per value.
const SUFFIXES = ["", "1", "2"] as const;

const DIGIT = cls([R("0", "9")]);
const WS = cls(C(" \t\r\n")); // one whitespace char; `star(WS)` is the strict/plan inter-op separator
const TAG_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.-")]);
const BRANCH_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.-/")]);
// The lexer's executor IDENT requires a letter/underscore head; canon dictates lowercase.
const EXEC_HEAD = cls([R("a", "z")]);
const EXEC_TAIL = cls([R("a", "z"), R("0", "9"), ...C("_-")]);

// Body alphabet excludes control chars (tab/newline/CR allowed) plus the chars
// tracked by the close-literal automaton state.
const CONTROL_RANGES: Array<[number, number]> = [[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x7F]];
// Line terminators — allowed in CONTENT bodies (multiline EDIT/SEND/COPY/MOVE/EXEC/PLAN),
// FORBIDDEN in PATTERN bodies (FIND/READ/OPEN/FOLD), which are single-line by contract (a
// regex matching a newline writes the two-char escape `\n`, never a literal one). Excluding
// them collapses the in-body quicksand trap: a mismatched close (`<<FIND…:READ`) leaves the
// model stuck in the FIND body — with no newline to break its line, the ONLY exit is the real
// close `:FIND`, so it is ejected to statement level within ONE line instead of rambling to the
// max_tokens wall (packet002 forensic: gemma, 8192 tokens, 50x "(End of turn)" against a masked EOS).
const LINE_TERMINATORS: Array<[number, number]> = [[0x0A, 0x0A], [0x0D, 0x0D]];
const bodyOther = (excluded: string, singleLine = false): GItem =>
    cls([...CONTROL_RANGES, ...(singleLine ? LINE_TERMINATORS : []), ...C(excluded)], true);

// Complement automaton for one close literal: state k = matched the first k chars
// of `close`. Reaching len(close) is forbidden, so the literal never occurs inside
// the body; the statement's trailing close literal is the unique occurrence. Close
// literals are ":" + word — no internal ":" and no borders, so on a mismatch the
// only live restart is ":" → state 1.
const bodyRules = (model: GModel, name: string, close: string, singleLine = false): void => {
    for (let k = 0; k < close.length; k++) {
        const expected = close[k];
        const alts: GRule = [];
        if (k + 1 < close.length) alts.push([lit(expected), ref(`${name}-b${k + 1}`)]);
        if (k > 0) alts.push([lit(":"), ref(`${name}-b1`)]);
        alts.push([bodyOther(k === 0 ? ":" : `:${expected}`, singleLine), ref(`${name}-b0`)]);
        alts.push([]);
        model.set(`${name}-b${k}`, alts);
    }
};

// Pattern bodies may be empty or begin with any ordinary single-line character except
// `:`. This removes the high-probability `:::OP` typo from the local-model rail: after the
// body delimiter, a leading `:` creates the same spelling as an accidental extra delimiter.
// ANTLR remains permissive, and a literal leading colon is still expressible unambiguously
// as a regex. Once one matcher character is consumed, the ordinary body automaton applies
// and colons remain legal everywhere else.
const patternBodyStartRule = (model: GModel, name: string): string => {
    const rule = `${name}-pattern-start`;
    model.set(rule, [
        [bodyOther(":", true), ref(`${name}-b0`)],
        [],
    ]);
    return rule;
};

// Non-empty body: `${name}-b0` minus its entry epsilon, so the body MUST consume at least
// one char before the close. The two non-epsilon transitions of state 0 (`:` -> b1,
// any-other -> b0) then hand off to the normal automaton, which keeps its epsilon, so the
// body can still end after that first char. Used where an empty body has no meaning: PLAN,
// terminal SEND, WORK, and FORK. Whitespace-only bodies still pass; that residual is a
// post-gen sieve's job, not the grammar's.
const bodyRulesNonEmpty = (model: GModel, name: string, close: string): void => {
    const alts: GRule = [];
    if (close.length > 1) alts.push([lit(close[0]), ref(`${name}-b1`)]);
    alts.push([bodyOther(":"), ref(`${name}-b0`)]);
    model.set(`${name}-b0ne`, alts);
};

// PLAN body: complement over BOTH the closer `:PLAN` and the op-opener `<<` (#502). PLAN is
// suffix-less by design, so the op-quoting device does not exist for it — a literal `<<` in a
// plan body has zero sanctioned use, and admitting it is the run113 trap: an omitted `:PLAN`
// lets the body swallow the turn's ops to the NEXT `:PLAN` occurrence, silently and in-rail
// (PLAN=1, SEND=1, the essential op vanished, rails=accept). Excluding `<<` force-closes the
// plan where the acting begins: at the omitted closer the mask denies the second `<`, and the
// shortest legal path to the intended op is emitting `:PLAN` first — the rail auto-corrects
// the omission at one-token cost (the quicksand-fix mechanics). A single `<` stays legal
// (comparisons, arrows); only the double is unsampleable.
const planBodyRules = (model: GModel, name: string, close: string): void => {
    // Closer-prefix states (k = chars of `close` matched), each `<`-aware.
    for (let k = 0; k < close.length; k++) {
        const expected = close[k];
        const alts: GRule = [];
        if (k + 1 < close.length) alts.push([lit(expected), ref(`${name}-b${k + 1}`)]);
        if (k > 0) alts.push([lit(":"), ref(`${name}-b1`)]);
        alts.push([lit("<"), ref(`${name}-lt`)]);
        alts.push([bodyOther((k === 0 ? ":" : `:${expected}`) + "<"), ref(`${name}-b0`)]);
        alts.push([]);
        model.set(`${name}-b${k}`, alts);
    }
    // One `<` consumed: a second `<` has no transition — `<<` is unsampleable in-body.
    model.set(`${name}-lt`, [
        [lit(":"), ref(`${name}-b1`)],
        [bodyOther(":<"), ref(`${name}-b0`)],
        [],
    ]);
    // Non-empty entry (no blank statement of intent), same doors minus the entry epsilon.
    model.set(`${name}-b0ne`, [
        [lit(close[0]), ref(`${name}-b1`)],
        [lit("<"), ref(`${name}-lt`)],
        [bodyOther(":<"), ref(`${name}-b0`)],
    ]);
};

// Complement automaton for a finite set of forbidden literals. State is the longest
// consumed suffix that is also a proper prefix of a forbidden literal. Completing any
// forbidden literal has no transition; all other characters advance to the appropriate
// suffix state. The channel body uses this to reject both its closer (so the production
// owns the unique close) and another opener (so nested/restarted reasoning is denied at
// the second opener rather than after it has already poisoned the stream).
const forbidLiterals = (model: GModel, name: string, literals: string[]): void => {
    if (literals.length === 0 || literals.some((literal) => literal.length === 0)) {
        throw new Error("forbidLiterals requires non-empty literals");
    }
    const states = [""];
    for (const literal of literals) {
        for (let length = 1; length < literal.length; length++) {
            const prefix = literal.slice(0, length);
            if (!states.includes(prefix)) states.push(prefix);
        }
    }
    const stateIndex = new Map(states.map((state, index) => [state, index]));
    const ruleOf = (state: string): string => `${name}-b${stateIndex.get(state)!}`;
    const significant = [...new Set(literals.flatMap((literal) => [...literal]))];
    const statesByLength = states.toSorted((a, b) => b.length - a.length);
    const nextState = (candidate: string): string =>
        statesByLength.find((state) => candidate.endsWith(state))!;

    for (const state of states) {
        const transitions = new Map<string, string[]>();
        for (const char of significant) {
            const candidate = state + char;
            if (literals.some((literal) => candidate.endsWith(literal))) continue;
            const target = nextState(candidate);
            const chars = transitions.get(target) ?? [];
            chars.push(char);
            transitions.set(target, chars);
        }
        const alts: GRule = [...transitions].map(([target, chars]) => [
            chars.length === 1 ? lit(chars[0]) : cls(C(chars.join(""))),
            ref(ruleOf(target)),
        ]);
        alts.push([bodyOther(significant.join("")), ref(ruleOf(""))]);
        alts.push([]);
        model.set(ruleOf(state), alts);
    }
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
    const sendFinalFirstEntries: Array<{ literal: string; tails: GSeq[] }> = [];

    for (const op of OPS) {
        for (const suffix of SUFFIXES) {
            // PLAN is allowed but inert: bare `<<PLAN` only, no numeric suffix (a suffix
            // would let a model emit the malformed `<<PLAN1`). Provider reasoning lives
            // in the <think> preamble, not in the public PLAN record.
            if (op === "PLAN" && suffix !== "") continue;
            const name = op.toLowerCase() + (suffix === "" ? "" : `-${suffix}`);
            const open = `<<${op}${suffix}`;
            const close = `:${op}${suffix}`;
            const patternBody = PATTERN_OPS.has(op);
            bodyRules(model, name, close, patternBody);
            const bodyStart = patternBody ? patternBodyStartRule(model, name) : `${name}-b0`;
            const body = [lit(":"), ref(bodyStart), lit(close)];
            if (op === "SEND") {
                // A SEND is comms; the LAST SEND before EOS is the turn's disposition. Mid
                // SENDs carry any NON-disposition 3-digit status (status-mid) or none, targeted
                // or pathless, empty body allowed. The TERMINAL SEND requires a disposition code
                // and a non-empty body - a turn must not end empty-handed. Terminal set (waitpid
                // contract, service SPEC §wait-obligation-matrix): 102 continue, 200 done,
                // 202 wait (obligation-checked; the engine verifies against live spawns/streams/
                // retrievals), 300 stop-the-world question, 499 abandon. The park `<T>`/`<T,P>`/
                // `<-1>` rides [202] ONLY - waiting is 202's meaning, so [102] is a pure continue
                // (the rail does not offer a park there; ANTLR tolerates one per owner ruling,
                // the engine folds it). No `<T>` on 200/300/499 (200/499 end the loop; 300 waits
                // on the operator exclusively, indefinite by definition). Context discipline
                // (200-with-pending, 202-on-nothing resolves like 200) is the ENGINE's
                // obligation matrix, NOT a rail - the grammar polices shape only.
                // Tails are factored behind the shared `<<SEND…` opener trie (no leading
                // `lit(open)` - the trie matches it). `<<SEND` is a prefix of `<<SEND1`, so
                // its tails sit at the interior trie node beside the digit branch.
                bodyRulesNonEmpty(model, name, close);
                const bodyNE = [lit(":"), ref(`${name}-b0ne`), lit(close)];
                sendMidEntries.push({ literal: open, tails: [
                    [lit("["), ref("status-mid"), lit("]"), ref("target"), ...body],  // targeted, any status
                    [ref("target"), ...body],                                          // targeted, statusless
                    [lit("["), ref("status-mid"), lit("]"), ...body],                  // pathless, any status
                    [...body],                                                          // pathless, statusless
                ] });
                sendFinalEntries.push({ literal: open, tails: [
                    [lit("[102]"), opt(ref("target")), ...bodyNE],
                    [lit("[202]"), opt(ref("target")), opt(ref("park")), ...bodyNE],
                    [lit("["), ref("status-final-rest"), lit("]"), opt(ref("target")), ...bodyNE],
                ] });
                // NO-IDLE RULE (consumer-requested, ratified 2026-07-16): a zero-op turn may
                // not conclude [102] - "continue" with nothing submitted is a spin, the
                // corridor-flail escape valve. tail-0's exit trie omits the [102] tail, so a
                // bare PLAN+SEND[102] does not derive; after >=1 op the full set returns.
                // 200/202/300/499 stay legal bare (the delegation breath's wake turn IS
                // PLAN+SEND[200]; a zero-op 202 is the ENGINE's obligation check, not ours).
                sendFinalFirstEntries.push({ literal: open, tails: [
                    [lit("[202]"), opt(ref("target")), opt(ref("park")), ...bodyNE],
                    [lit("["), ref("status-final-rest"), lit("]"), opt(ref("target")), ...bodyNE],
                ] });
            } else if (op === "EXEC") {
                // EXEC's optional `<timeout,poll>` rides the shared `line` slot (numbers; runtime-interpreted).
                opEntries.push({ literal: open, tails: [[opt(ref("exec-sig")), opt(ref("target")), opt(ref("line")), ...body]] });
            } else if (op === "PLAN") {
                // Slotless bare intended-goals body, REQUIRED non-empty (no blank statement of
                // intent). PLAN is the MANDATORY turn anchor and the FIRST op only — root-turn
                // references the standalone `plan` rule and PLAN is NOT in the op-statement
                // trie, so a second PLAN cannot appear mid-batch. The body additionally
                // excludes `<<` (#502, planBodyRules — overrides the generic automaton): the
                // plan ends where the acting begins.
                planBodyRules(model, name, close);
                const bodyNE = [lit(":"), ref(`${name}-b0ne`), lit(close)];
                model.set("plan", [[lit(open), ...bodyNE]]);
            } else if (op === "KILL") {
                // Target-specific numeric code is wired but untaught — canon shows bare KILL.
                opEntries.push({ literal: open, tails: [[opt(ref("kill-sig")), ref("target"), ...body]] });
            } else if (op === "WORK" || op === "FORK") {
                // Delegation verbs: optional single Git branch ref in the signal/tag slot,
                // required worker target, then a non-empty prompt. The extra entry rule
                // reuses the existing body automaton; it adds no second automaton family.
                bodyRulesNonEmpty(model, name, close);
                const bodyNE = [lit(":"), ref(`${name}-b0ne`), lit(close)];
                opEntries.push({ literal: open, tails: [[opt(ref("branch")), ref("target"), ...bodyNE]] });
            } else if (op === "OPEN" || op === "FOLD") {
                // Log curation selects sets by tags + target + matcher. It has no positional
                // line slot; FIND alone paginates selected results.
                opEntries.push({ literal: open, tails: [[opt(ref("tags")), ref("target"), ...body]] });
            } else {
                // Scoped tag-CSV ops (FIND/READ/EDIT/COPY/MOVE) share one shape. The former
                // READ/FIND retrieval routing (the READ->200 rail, 0.74.47-0.74.58) is DELETED
                // (#54, ruled 2026-07-05): premature-conclude is CONTEXT, and context lives in
                // the engine's pending-set rule (409 + steer), uniformly with streams/children.
                opEntries.push({ literal: open, tails: [[opt(ref("tags")), ref("target"), opt(ref("line")), ...body]] });
            }
        }
    }

    // SPEC {§gbnf-turn-shape} and {§gbnf-reasoning-boundary} (#12/#16): the grammar
    // constrains one unsplit channel + PLURNK sentence. `sep` is bounded so whitespace
    // cannot consume the response envelope indefinitely.
    model.set("sep", [Array.from({ length: 7 }, () => opt(WS))]);
    // The body complement rejects both delimiters. Its epsilon keeps an empty reasoning
    // body legal while the production still supplies exactly one opener and closer.
    const channelOpen = "<|channel>thought\n";
    const channelClose = "<channel|>";
    forbidLiterals(model, "rz-chan", [channelOpen, channelClose]);
    model.set("channel", [[lit(channelOpen), ref("rz-chan-b0"), lit(channelClose)]]);
    // The existing tail is a cardinality rail only: at most 14 internal statements,
    // followed by a terminal SEND. Semantic turn policy remains in core.
    const K_MID_STEPS = 14;
    for (let k = 0; k < K_MID_STEPS; k++) {
        model.set(`tail-${k}`, [
            [ref("send-mid-any"), ref("sep"), ref(`tail-${k + 1}`)],
            [ref("op-statement"), ref("sep"), ref(`tail-${k + 1}`)],
            // Position 0 exits through the no-idle trie (no [102]); every deeper
            // position has >=1 statement behind it, so the full disposition set returns.
            [ref(k === 0 ? "send-final-first" : "send-final-any"), ref("sep")],
        ]);
    }
    // Step budget exhausted: terminal SEND is the only continuation.
    model.set(`tail-${K_MID_STEPS}`, [[ref("send-final-any"), ref("sep")]]);
    model.set("root-turn", [[ref("channel"), ref("sep"), ref("plan"), ref("sep"), ref("tail-0")]]);
    trieRules(model, "op-statement", opEntries);
    trieRules(model, "send-mid-any", sendMidEntries);
    trieRules(model, "send-final-any", sendFinalEntries);
    trieRules(model, "send-final-first", sendFinalFirstEntries);
    // statement / send-statement: single-statement entries used only by the corpus and
    // fuzz tests; unreachable from root-turn, so pruned from the shipped artifact.
    model.set("send-statement", [[ref("send-mid-any")], [ref("send-final-any")]]);
    model.set("statement", [[ref("op-statement")], [ref("send-statement")]]);
    // Terminal set (waitpid contract, service SPEC §wait-obligation-matrix): 102 continue,
    // 200 done, 202 wait (back on the menu 2026-07-09 with a NEW meaning - obligation-checked,
    // the engine verifies it against live spawns/streams/retrievals; a wait on nothing resolves
    // like 200, so the old groundless-hibernate fumble cannot recur), 300 = a stop-the-world
    // multiple-choice question to the user (waker exclusively the operator, indefinite by
    // definition, no `<T>`), 499 abandon. NOT 500: "failed" is an ENGINE verdict, never a
    // model SEND (persisted-only) - see plurnk-service#33.
    // The [102]/[202] branches ride inline (sendFinalEntries above); status-final-rest is
    // the remaining terminal codes. park rides [202] ONLY: `<T>` = wait up to T seconds, any
    // arrival wakes early; `<T,P>` adds a poll cadence (mirrors EXEC's `<timeout,poll>`);
    // `<-1>` = indefinite standby (bounded by the join's own liveness guarantee).
    // status-mid: any 3-digit code EXCEPT the terminal disposition codes {102,200,202,300,499}.
    // A SEND carrying a terminal code IS the terminal (the dispatcher acts on the FIRST
    // disposition-coded SEND, so it terminates there), hence it can ONLY be the last op.
    // Reserving the five from mid position keeps the grammar's last-SEND model and the
    // dispatcher's first-disposition model coincident. A mid SEND stays comms: statusless, or
    // a non-disposition code (a 4xx error report to a peer). Encoded as the complement of
    // the five over DDD, as a first-digit trie.
    model.set("status-final-rest", [[lit("200")], [lit("300")], [lit("499")]]);
    model.set("park", [[lit("<"), ref("park-t"), opt(ref("park-poll")), lit(">")]]);
    model.set("park-t", [[lit("-1")], [plus(DIGIT)]]);
    model.set("park-poll", [[lit(","), plus(DIGIT)]]);
    model.set("status-mid", [
        [cls([R("0", "0"), R("5", "9")]), DIGIT, DIGIT],   // 0xx / 5xx-9xx: no disposition code here
        [lit("1"), ref("status-mid-1")],
        [lit("2"), ref("status-mid-2")],
        [lit("3"), ref("status-mid-3")],
        [lit("4"), ref("status-mid-4")],
    ]);
    model.set("status-mid-1", [[lit("0"), cls([R("0", "1"), R("3", "9")])], [cls([R("1", "9")]), DIGIT]]); // forbid 102
    model.set("status-mid-2", [[lit("0"), cls([R("1", "1"), R("3", "9")])], [cls([R("1", "9")]), DIGIT]]); // forbid 200 and 202
    model.set("status-mid-3", [[lit("0"), cls([R("1", "9")])], [cls([R("1", "9")]), DIGIT]]);              // forbid 300
    model.set("status-mid-4", [[lit("9"), cls([R("0", "8")])], [cls([R("0", "8")]), DIGIT]]);              // forbid 499
    model.set("tags", [[lit("["), ref("tag"), star(ref("tag-rest")), lit("]")]]);
    model.set("branch", [[lit("["), plus(BRANCH_CHAR), lit("]")]]);
    model.set("tag", [[plus(TAG_CHAR)]]);
    model.set("tag-rest", [[lit(","), ref("tag")]]);
    // Target — the canonical generation subset: an opaque exact path or shell glob
    // with parentheses percent-encoded. ANTLR deliberately accepts balanced raw
    // parentheses too, but the rail generates one low-ambiguity spelling.
    model.set("target", [[lit("("), ref("target-inner"), lit(")")]]);
    model.set("target-inner", [[plus(cls([...CONTROL_RANGES, ...C("()<\r\n")], true))]]);
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
    process.stderr.write("Generated dist/plurnk.gbnf (raw turn: CHANNEL:PLAN:OPS:SEND)\n");
}
