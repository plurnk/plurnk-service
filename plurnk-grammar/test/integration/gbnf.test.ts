/**
 * GBNF contract tests. Two directions:
 *
 * Corpus — every plurnk.md example must be derivable from the GBNF model
 * (dictated generation ⊂ prescribed canon). README examples are NOT corpus:
 * they document the permissive parse layer (word suffixes, dash ranges).
 *
 * Fuzz — seeded random derivations from the model must parse via PlurnkParser
 * with zero errors (L(GBNF) ⊂ L(ANTLR)).
 *
 * The recognizer and sampler below operate on the generator's exported rule
 * model, not on the serialized .gbnf text.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";
import { buildModel, serializeGbnf, type GItem, type GModel, type GSeq } from "../../scriptify/generate-gbnf.ts";

const model = buildModel();

// -------------------------------------------------------------------------
// Recognizer: memoized set-of-end-positions matcher (no left recursion in model)
// -------------------------------------------------------------------------

const inClass = (item: Extract<GItem, { kind: "cls" }>, cp: number): boolean => {
    const hit = item.ranges.some(([a, b]) => cp >= a && cp <= b);
    return item.negate ? !hit : hit;
};

const derives = (entry: string, input: string): boolean => {
    const memo = new Map<string, number[]>();

    const matchItem = (item: GItem, pos: number): number[] => {
        switch (item.kind) {
            case "lit":
                return input.startsWith(item.text, pos) ? [pos + item.text.length] : [];
            case "cls": {
                if (pos >= input.length) return [];
                const cp = input.codePointAt(pos)!;
                return inClass(item, cp) ? [pos + String.fromCodePoint(cp).length] : [];
            }
            case "ref":
                return matchRule(item.name, pos);
            case "rep": {
                const reached = new Set<number>(item.min === 0 ? [pos] : []);
                let frontier = [pos];
                let count = 0;
                while (frontier.length > 0 && count < item.max) {
                    const next = new Set<number>();
                    for (const p of frontier) {
                        for (const q of matchItem(item.item, p)) {
                            if (q > p && !reached.has(q)) next.add(q);
                        }
                    }
                    count++;
                    if (count >= item.min) for (const q of next) reached.add(q);
                    frontier = [...next];
                }
                return [...reached];
            }
        }
    };

    const matchSeq = (seq: GSeq, pos: number): number[] => {
        let positions = [pos];
        for (const item of seq) {
            const next = new Set<number>();
            for (const p of positions) for (const q of matchItem(item, p)) next.add(q);
            positions = [...next];
            if (positions.length === 0) return [];
        }
        return positions;
    };

    const matchRule = (name: string, pos: number): number[] => {
        const key = `${name}:${pos}`;
        const cached = memo.get(key);
        if (cached) return cached;
        memo.set(key, []);
        const rule = model.get(name);
        assert.ok(rule, `GBNF model has no rule named ${name}`);
        const ends = new Set<number>();
        for (const alt of rule) for (const q of matchSeq(alt, pos)) ends.add(q);
        const result = [...ends];
        memo.set(key, result);
        return result;
    };

    return matchRule(entry, 0).includes(input.length);
};

// -------------------------------------------------------------------------
// Sampler: seeded random derivation with a length budget
// -------------------------------------------------------------------------

const mulberry32 = (seed: number): (() => number) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Minimum derivation length per rule, for budget-exhausted alternative choice.
const minLens = (() => {
    const lens = new Map<string, number>([...model.keys()].map((k) => [k, Infinity]));
    const itemMin = (item: GItem): number => {
        switch (item.kind) {
            case "lit": return item.text.length;
            case "cls": return 1;
            case "ref": return lens.get(item.name)!;
            case "rep": return item.min * itemMin(item.item);
        }
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, alts] of model) {
            const next = Math.min(...alts.map((seq) => seq.reduce((sum, item) => sum + itemMin(item), 0)));
            if (next < lens.get(name)!) { lens.set(name, next); changed = true; }
        }
    }
    return lens;
})();

const SAMPLE_POOL = [...Array.from({ length: 0x7F - 0x20 }, (_, i) => 0x20 + i), 0x0A];

const sample = (entry: string, rng: () => number): string => {
    let budget = 240;
    const sampleSeq = (seq: GSeq): string => seq.map(sampleItem).join("");
    const sampleItem = (item: GItem): string => {
        switch (item.kind) {
            case "lit":
                budget -= item.text.length;
                return item.text;
            case "cls": {
                budget -= 1;
                const pool = item.negate
                    ? SAMPLE_POOL.filter((cp) => inClass(item, cp))
                    : item.ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
                return String.fromCodePoint(pool[Math.floor(rng() * pool.length)]);
            }
            case "ref": {
                const alts = model.get(item.name)!;
                const seqMin = (seq: GSeq): number => seq.reduce((sum, it) => {
                    if (it.kind === "ref") return sum + minLens.get(it.name)!;
                    if (it.kind === "rep") return sum + (it.min === 0 ? 0 : seqMin([it.item]));
                    return sum + (it.kind === "lit" ? it.text.length : 1);
                }, 0);
                const pick = budget <= 0
                    ? alts.toSorted((a, b) => seqMin(a) - seqMin(b))[0]
                    : alts[Math.floor(rng() * alts.length)];
                return sampleSeq(pick);
            }
            case "rep": {
                let count = item.min;
                while (count < item.max && budget > 0 && rng() < 0.6) count++;
                return Array.from({ length: count }, () => sampleItem(item.item)).join("");
            }
        }
    };
    return sampleSeq([{ kind: "ref", name: entry }]);
};

// -------------------------------------------------------------------------
// Corpus: plurnk.md examples derive from statement
// -------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plurnkMd = readFileSync(join(repoRoot, "plurnk.md"), "utf8");

// The root encodes the turn shape — the `*:PLAN:OPS:SEND[N]` sandwich: a free reasoning
// preamble, then a mandatory `<<PLAN`, then ops, closed by one terminal SEND. The
// teaching corpus is not a turn (it ends with three SEND variants), so corpus
// derivability is asserted per-statement; the turn shape is asserted separately.
// (PlurnkParser discards the pre-`<<PLAN` preamble, so sampled turns parse cleanly.)
test("GBNF: every plurnk.md example derives from statement", () => {
    const headingMatch = /^## Examples\s*$/m.exec(plurnkMd);
    assert.ok(headingMatch, "plurnk.md is missing its `## Examples` section");
    const rest = plurnkMd.substring(headingMatch.index + headingMatch[0].length);
    const nextHeading = /^## /m.exec(rest);
    const block = rest.substring(0, nextHeading ? nextHeading.index : rest.length).trim().replace(/^[ \t]*\* /gm, "");

    const result = PlurnkParser.parseStatements(block);
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.ok(statements.length > 0, "no statements extracted from the examples block");
    const lines = block.split("\n");
    const offsetOf = (line: number, column: number): number =>
        lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + column;
    for (let i = 0; i < statements.length; i++) {
        const start = offsetOf(statements[i].statement.position.line, statements[i].statement.position.column);
        const next = statements[i + 1];
        const end = next ? offsetOf(next.statement.position.line, next.statement.position.column) : block.length;
        const text = block.slice(start, end).trim();
        assert.equal(derives("statement", text), true, `example not GBNF-derivable: ${JSON.stringify(text)}`);
    }
});

// -------------------------------------------------------------------------
// Turn shape: PLAN-anchored sandwich (preplan plan sep batch-step* send-final-any sep)
// -------------------------------------------------------------------------

test("GBNF: PLAN-anchored root — PLAN mandatory & first, SEND-closed", () => {
    // PLAN first, then ops, closed by a terminal SEND.
    assert.equal(derives("root-turn", "<<PLAN:decompose first:PLAN\n<<READ(known:///x)::READ\n<<SEND[102]:done:SEND"), true);
    // minimal: PLAN then the closing SEND.
    assert.equal(derives("root-turn", "<<PLAN:think:PLAN\n<<SEND[102]:working:SEND"), true);
    // op-first (no PLAN) is NOT a turn.
    assert.equal(derives("root-turn", "<<READ(known:///x)::READ\n<<SEND[102]:done:SEND"), false);
    // bare SEND (no PLAN) is NOT a turn.
    assert.equal(derives("root-turn", "<<SEND[200]:done:SEND"), false);
    // PLAN alone (no terminal SEND) is NOT a turn.
    assert.equal(derives("root-turn", "<<PLAN:think:PLAN"), false);
    // no free prose between ops after PLAN.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\nstray prose\n<<SEND[200]:x:SEND"), false);
});

test("GBNF: free reasoning preamble before PLAN — any format, but op-free", () => {
    // the preamble is free text up to the first <<PLAN — any reasoning format works
    assert.equal(derives("root-turn", "<think>reasoning</think>\n<<PLAN:intent:PLAN\n<<SEND[200]:done:SEND"), true);
    assert.equal(derives("root-turn", "<|channel>thought blah<channel|>\n<<PLAN:intent:PLAN\n<<SEND[200]:x:SEND"), true);
    // absent preamble — straight to PLAN
    assert.equal(derives("root-turn", "<<PLAN:intent:PLAN\n<<SEND[200]:x:SEND"), true);
    // the preamble is OP-FREE: a rehearsed `<<OP` opener in it is not derivable (it would
    // break L(GBNF) ⊆ L(ANTLR), where the turn preamble re-lexes as pure TEXT)
    assert.equal(derives("root-turn", "draft <<EDIT musings\n<<PLAN:intent:PLAN\n<<SEND[200]:x:SEND"), false);
    // no <<PLAN anywhere → not a turn
    assert.equal(derives("root-turn", "just reasoning, never plans\n<<SEND[200]:x:SEND"), false);
});

test("GBNF: preplan is op-free free text and may not end on a lone `<`", () => {
    // free text with partial (incomplete) openers is fine
    assert.equal(derives("preplan", "anything goes <<SEN <<PLA not-quite"), true);
    // a complete `<<OP` opener is not — the preamble must stay opener-free
    assert.equal(derives("preplan", "before <<EDIT after"), false);
    assert.equal(derives("preplan", "before <<PLAN after"), false);
    // may not END on a lone `<` (odd run) — it would merge with the following `<<PLAN`
    assert.equal(derives("preplan", "trailing <"), false);
    assert.equal(derives("preplan", "trailing <<"), true);
});

test("PlurnkParser.parse discards the pre-<<PLAN preamble (turn sandwich)", () => {
    const turn = "plain reasoning, no op lookalikes\n<<PLAN:do the thing:PLAN\n<<READ(known:///x)::READ\n<<SEND[200]:done:SEND";
    const r = PlurnkParser.parse(turn);
    const stmts = r.items.filter((i) => i.kind === "statement");
    const errs = r.items.filter((i) => i.kind === "error");
    assert.equal(errs.length, 0, JSON.stringify(r.items));
    assert.ok(stmts[0]?.kind === "statement" && stmts[0].statement.op === "PLAN", "first parsed op should be PLAN");
    const last = stmts.at(-1);
    assert.ok(last?.kind === "statement" && last.statement.op === "SEND", "turn closes with SEND");
    assert.equal(r.unparsedTail, undefined);
});

// In-band reasoning enclosures: a model that drafts a `<<PLAN` (or any op) WHILE reasoning
// must not have that draft anchor the turn (and must be able to close its enclosure). The
// GBNF generates the optional enclosure; ANTLR absorbs it as preamble TEXT. Both must agree
// (subset invariant) AND parse must anchor on the REAL `<<PLAN` after the enclosure. The
// random fuzz never emits a literal `<<PLAN` inside a reasoning body, so guard it explicitly.
test("reasoning enclosure protects a drafted <<PLAN; parse anchors on the real one", () => {
    const cases: Array<[string, string]> = [
        ["think", "<think>my plan: <<PLAN:do x:PLAN then verify</think>\n<<PLAN:real intent:PLAN\n<<SEND[200]:done:SEND"],
        ["channel", "<|channel>thought, will <<PLAN:draft:PLAN<channel|>\n<<PLAN:real intent:PLAN\n<<SEND[200]:done:SEND"],
    ];
    for (const [label, turn] of cases) {
        assert.equal(derives("root-turn", turn), true, `GBNF should derive the ${label} enclosure turn`);
        const r = PlurnkParser.parse(turn);
        const stmts = r.items.filter((i) => i.kind === "statement");
        assert.equal(r.items.filter((i) => i.kind === "error").length, 0, `${label}: ${JSON.stringify(r.items)}`);
        const first = stmts[0]?.kind === "statement" ? stmts[0].statement : undefined;
        // PLAN's body is a plain string (reasoning text), not a {raw} object like SEND/EDIT.
        assert.ok(
            first?.op === "PLAN" && first.body === "real intent",
            `${label}: must anchor on the real PLAN, not the drafted one (got ${JSON.stringify(first?.body)})`,
        );
    }
});

test("PlurnkParser.parse requires both PLAN and a terminal SEND; prose tolerated as comments", () => {
    const invalid = (s: string): boolean => {
        const r = PlurnkParser.parse(s);
        return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
    };
    const valid = (s: string): boolean => !invalid(s);
    // Two hard requirements: a PLAN anchor and a terminal SEND.
    assert.equal(invalid("Four score and seven years ago our fathers brought forth a new nation."), true);
    assert.equal(invalid("<<PLAN:I will answer:PLAN"), true);                  // PLAN, no terminal SEND
    assert.equal(invalid("<<READ(known:///x)::READ"), true);                  // op, no PLAN, no SEND
    // PLAN now REQUIRED (0.74.23 re-tighten): ops + SEND with no PLAN no longer parses.
    assert.equal(invalid("<<READ(known:///x)::READ\n<<SEND[200]:done:SEND"), true);
    // Prose tolerated as comments — preamble, between ops, and trailing after the SEND.
    assert.equal(valid("thinking out loud <<PLAN:intent:PLAN now I read <<READ(known:///x)::READ <<SEND[200]:done:SEND and done"), true);
    // The canonical PLAN-anchored turn is valid.
    const ok = PlurnkParser.parse("<<PLAN:intent:PLAN\n<<SEND[200]:done:SEND");
    assert.equal(ok.items.some((i) => i.kind === "error"), false);
    assert.equal(ok.unparsedTail, undefined);
});

test("PlurnkParser.parse: a mid-turn termination is ILLEGAL — a disposition-coded SEND is the terminal", () => {
    const invalid = (s: string): boolean => {
        const r = PlurnkParser.parse(s);
        return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
    };
    const valid = (s: string): boolean => !invalid(s);
    // A disposition code {102,200,202,300,499} IS the turn terminal (the lexer tokens it as
    // DISPOSITION), so the grammar ends the turn there — a statement after it is a genuine
    // parse ERROR, not a mid comms demotion the way a positional last-SEND grammar would allow.
    assert.equal(invalid("<<PLAN:p:PLAN\n<<READ(known:///x)::READ\n<<SEND[200]:done:SEND\n<<EDIT(known://a):v:EDIT\n<<SEND[102]:cont:SEND"), true);
    assert.equal(invalid("<<PLAN:p:PLAN\n<<SEND[102]:cont:SEND\n<<SEND[200]:done:SEND"), true);     // two disposition SENDs
    assert.equal(invalid("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n<<KILL(proc://x)::KILL"), true);    // op after the terminal
    assert.equal(invalid("<<PLAN:p:PLAN\n<<EDIT(known://a):v:EDIT\n<<SEND[400]:report:SEND"), true); // 400 is comms, not a terminal — turn never terminated
    // Legal: a mid-comms SEND (non-disposition INT, statusless, or empty) may precede the
    // terminal; prose may follow the terminal.
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[400]:report:SEND\n<<EDIT(known://a):v:EDIT\n<<SEND[200]:done:SEND"), true);
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND(run://peer):hint:SEND\n<<SEND[102]:cont:SEND"), true);
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\nall set, boss"), true);
    // 202 is a disposition again (waitpid contract): a mid SEND[202] is a mid-termination
    // parse error, and a turn ENDING on it terminates cleanly.
    assert.equal(invalid("<<PLAN:p:PLAN\n<<SEND[202]:fyi:SEND\n<<SEND[102]:cont:SEND"), true);
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[202]:awaiting worker:SEND"), true);
    // ANTLR tolerates a park on [102] (owner ruling: "102<T> passes" - the engine folds it);
    // the GBNF rail is where [102]<T> is unsampleable.
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[102]<60>:holding:SEND"), true);
});

// -------------------------------------------------------------------------
// SEND disposition codes (terminal vs mid)
// -------------------------------------------------------------------------

test("GBNF: 202 is BACK (waitpid contract) — the obligation-checked wait terminal; mid is unsampleable", () => {
    // A turn ends on SEND[202]: the wait disposition (engine verifies against live obligations).
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]:awaiting the fork's report:SEND"), true);
    // 202 is a disposition again, so a mid SEND[202] is unsampleable (it IS the terminal).
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]:fyi:SEND\n<<SEND[102]:cont:SEND"), false);
    // The park moved with the wait: [102] is a pure continue, no park at the rail.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[102]<60>:holding for the stream:SEND"), false);
});

test("GBNF: the terminal [202] park <T>/<T,P>/<-1> — bounded, polled, indefinite, targeted; no park elsewhere", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]<30>:polling:SEND"), true);          // bounded wait
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]<-1>:standing by:SEND"), true);      // indefinite (join-bounded)
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]<60,5>:watching stream:SEND"), true); // timeout + poll cadence (mirrors EXEC)
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202](run://w)<60>:awaiting:SEND"), true); // targeted + park
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[102]<30>:cont:SEND"), false);            // 102 is a pure continue — the wait is 202's meaning
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]<30>:done:SEND"), false);            // 200 ends the loop — no wait to carry
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300]<30>:choose:SEND"), false);          // 300 waits on the operator exclusively — indefinite by definition
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499]<30>:abort:SEND"), false);
});

test("GBNF: SEND[499] is a terminal disposition; 500 is not a valid terminal (engine verdict)", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499]:giving up:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499](run://parent):aborting:SEND"), true); // terminate-and-report give-up
    // 500 is an engine verdict — not in the terminal set, so not a valid turn closer.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[500]:report:SEND"), false);
    // 499 is terminal-reserved: it IS the terminal, so it can't be a mid comms before another SEND.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499]:partial:SEND\n<<SEND[200]:done:SEND"), false);
    // 500 is NOT a disposition code, so it stays legal as a mid comms (error report), then a real terminal closes.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[500]:report:SEND\n<<SEND[102]:done:SEND"), true);
});

test("GBNF: SEND[300] (multiple-choice question) is a valid terminal disposition (untaught in canon)", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300]:Which sources do you trust?:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300](agent://user):clarify?:SEND"), true); // terminate-and-ask
    // 300 is terminal-reserved: a SEND[300] IS the terminal, so it can't precede another SEND.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300]:q:SEND\n<<SEND[200]:done:SEND"), false);
});

test("GBNF: a header-bearing http target derives (constrained models can emit auth, #46)", () => {
    // Request-metadata `{key: value}` blocks ride inside the target as free text —
    // `target-inner` already admits `{`, `}`, `:`, and spaces — so a rail'd model can
    // emit auth/content-type without any GBNF change. L(GBNF) ⊆ L(ANTLR) still holds.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<READ(https://api.dev/me{Authorization: Bearer x})::READ\n<<SEND[102]:fetching:SEND"), true);
    // SEND carries the loop disposition (200 here), not the HTTP status; the http scheme maps SEND->POST and rides the headers in the target.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200](https://api.dev/items{Authorization: Bearer x}{Content-Type: application/json}):{\"n\":1}:SEND"), true);
});

test("GBNF: op-count bound — K=14 mid-steps derive, 15 do not; exhaustion forces a valid terminal", () => {
    // The corridor-flail rail (probes 2026-07-03): a model denied its premature 200 spams
    // legal mid-steps to the max_tokens wall (reproduced live at seed 7; ×267 in service
    // digests). At step 14 the only legal continuation is a terminal SEND, so the mask
    // force-terminates with a valid disposition instead of a wall-death.
    const turn = (steps: string[], terminal: string) => `<<PLAN:p:PLAN\n${steps.join("\n")}\n${terminal}`;
    const edit = "<<EDIT(known:///x):v:EDIT";       // side-effect step
    const read = "<<READ(known:///x)::READ";        // retrieval step (a plain op since #54 — no dirty flip)
    const midSend = "<<SEND[400]:working:SEND";     // a mid comms SEND (non-disposition code) is a counted step

    // 14 steps + 200 derives; a 15th step does not.
    assert.equal(derives("root-turn", turn(Array(14).fill(edit), "<<SEND[200]:done:SEND")), true);
    assert.equal(derives("root-turn", turn(Array(15).fill(edit), "<<SEND[200]:done:SEND")), false);
    // Retrieval steps count the same (the tail-dirty fork is DELETED — one chain).
    assert.equal(derives("root-turn", turn(Array(14).fill(read), "<<SEND[102]:fetching:SEND")), true);
    assert.equal(derives("root-turn", turn(Array(14).fill(read), "<<SEND[200]:done:SEND")), true);  // rail gone: engine's pending-set 409s it
    assert.equal(derives("root-turn", turn(Array(15).fill(read), "<<SEND[102]:fetching:SEND")), false);
    // The reproduced flail shape (READ,READ,FIND,SEND ×2 then SEND-spam past K) is non-derivable.
    const flail = [read, read, "<<FIND(src/**)::FIND", midSend, read, read, "<<FIND(src/**)::FIND", midSend, ...Array(10).fill(midSend)];
    assert.equal(derives("root-turn", turn(flail, "<<SEND[102]:done:SEND")), false);
    // Mid-SENDs count as steps: 13 sends + 1 op + terminal is exactly 14 → derives.
    assert.equal(derives("root-turn", turn([...Array(13).fill(midSend), edit], "<<SEND[200]:done:SEND")), true);
});

test("GBNF: pattern bodies (FIND/READ/OPEN/FOLD) forbid a literal newline — in-body quicksand fix (packet002)", () => {
    // packet002 forensic: `<<FIND(SPEC.md):#grinder#:READ` (FIND closed with the wrong tag) left
    // the model stuck in the FIND body — every subsequent newline was legal body content, so the
    // turn never terminated and burned 8192 tokens (50x "(End of turn)" against a masked EOS).
    // Fix: a literal newline in a pattern body is unsampleable, so the ONLY exit is the real close
    // — the model is ejected to statement level within one line. Content bodies are untouched.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<FIND(SPEC.md):#grinder#:READ\n<<SEND[102]:x:SEND"), false); // the exact trap
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<FIND(SPEC.md):#grinder#:FIND\n<<SEND[102]:x:SEND"), true);  // closed correctly
    for (const op of ["FIND", "READ", "OPEN", "FOLD"]) {
        assert.equal(derives("root-turn", `<<PLAN:p:PLAN\n<<${op}(a):line1\nline2:${op}\n<<SEND[102]:c:SEND`), false, `${op} pattern body must not span lines`);
    }
    // Content bodies (EDIT/SEND/...) stay multiline — the narrowing is pattern-only.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<EDIT(a):line1\nline2:EDIT\n<<SEND[200]:done:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:multi\nline:SEND"), true);
});

test("GBNF: mid-batch comms SENDs derive (targeted/pathless, NON-disposition codes) before the final", () => {
    const batch = "<<PLAN:plan:PLAN\n<<SEND[400](agent://supervisor):decomposition incomplete:SEND\n<<SEND[400]:{\"reason\":\"bad op\"}:SEND\n<<SEND[102]:done:SEND";
    assert.equal(derives("root-turn", batch), true);
    // A disposition code (here 102) IS the terminal, so it can't be a mid comms — this now rejects.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[102](agent://supervisor):progress:SEND\n<<SEND[102]:done:SEND"), false);
});

test("GBNF: root rejects a batch with no final status SEND", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<EDIT(known://a.md):x:EDIT"), false);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<EDIT(known://a.md):x:EDIT\n<<SEND[400]:err:SEND"), false);
});

test("GBNF: root accepts a targeted terminal SEND (terminate-and-report)", () => {
    // The terminal is path-agnostic: a disposition code closes the turn with or without a target.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200](run://parent):result:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:done:SEND"), true);
    // two disposition SENDs in one turn is now illegal — the first SEND[200] IS the terminal, nothing follows.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200](run://parent):result:SEND\n<<SEND[200]:again:SEND"), false);
    // ...but the turn must still END on a SEND — a trailing non-SEND op is rejected.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:result:SEND\n<<EDIT(known://a.md):x:EDIT"), false);
});

test("GBNF: a turn may contain multiple SENDs — but only the terminal carries a disposition code", () => {
    // A non-disposition comms SEND (400) may precede ops and the terminal disposition SEND.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[400]:interim:SEND\n<<EDIT(known://a.md):x:EDIT\n<<SEND[200]:done:SEND"), true);
    // A disposition-coded SEND (200) mid is now rejected — it IS the terminal, so ops/SENDs can't follow it.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:interim:SEND\n<<EDIT(known://a.md):x:EDIT\n<<SEND[200]:done:SEND"), false);
    // and a non-SEND op after the terminal is still rejected — the turn ends on the terminal.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n<<EDIT(known://a.md):x:EDIT"), false);
});

test("GBNF: terminal disposition codes are UNSAMPLEABLE mid — a coded SEND IS the terminal", () => {
    // The bug this closes: a mid SEND[200] after a READ demoted a premature terminate to a legal
    // comms SEND, which the dispatcher (first disposition-coded SEND wins) acted on — bypassing
    // the last-SEND model. Reserving the disposition codes for the terminal makes premature
    // termination unsampleable at the mask. Set is {102,200,202,300,499} (waitpid contract).
    for (const code of ["102", "200", "202", "300", "499"]) {
        assert.equal(derives("root-turn", `<<PLAN:p:PLAN\n<<SEND[${code}]:x:SEND\n<<SEND[102]:c:SEND`), false, `mid SEND[${code}] must reject`);
    }
    // Non-disposition codes stay legal mid comms (boundary cases around the reserved five).
    for (const code of ["100", "201", "203", "301", "400", "498", "500", "999"]) {
        assert.equal(derives("root-turn", `<<PLAN:p:PLAN\n<<SEND[${code}]:x:SEND\n<<SEND[102]:c:SEND`), true, `mid SEND[${code}] must derive`);
    }
    // The exact probed bypass — READ then a mid SEND[200] then a terminal — is now closed.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<READ(a)::READ\n<<SEND[200]:done:SEND\n<<SEND[102]:cont:SEND"), false);
});

// -------------------------------------------------------------------------
// Statement layer: per-op shapes and canon boundaries
// -------------------------------------------------------------------------

test("GBNF: EXEC accepts an optional <timeout,poll> line slot (canonical signal,target,line order)", () => {
    assert.equal(derives("op-statement", "<<EXEC[node](sh:///x):cmd:EXEC"), true);        // no slot
    assert.equal(derives("op-statement", "<<EXEC[node](sh:///x)<60>:cmd:EXEC"), true);     // timeout only
    assert.equal(derives("op-statement", "<<EXEC[node](sh:///x)<60,5>:cmd:EXEC"), true);   // timeout + poll
    assert.equal(derives("op-statement", "<<EXEC(sh:///x)<60,5>:cmd:EXEC"), true);         // slotless executor
});

test("GBNF: WORK/FORK are delegation ops — target (run://name) REQUIRED, body, no signal slot", () => {
    // WORK spawns a fresh named worker; FORK branches the current run into a named child.
    assert.equal(derives("op-statement", "<<WORK(run://worker-db):resolve the db field:WORK"), true);
    assert.equal(derives("op-statement", "<<FORK(run://recheck):re-derive from a primary source:FORK"), true);
    // The rail REQUIRES the target — a nameless worker/branch can't be addressed.
    assert.equal(derives("op-statement", "<<WORK:do a thing:WORK"), false);
    assert.equal(derives("op-statement", "<<FORK:do a thing:FORK"), false);
    // No signal slot — a [tag]/[int] on WORK/FORK is not sampleable.
    assert.equal(derives("op-statement", "<<WORK[x](run://w):t:WORK"), false);
    // They derive as mid-ops before the terminal SEND.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<WORK(run://w):task:WORK\n<<SEND[102]:spawned:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<FORK(run://r):retry:FORK\n<<SEND[102]:forked:SEND"), true);
});

test("parse: WORK/FORK build the right AST — op, run:// target, opaque body, null signal + lineMarker", () => {
    const one = (s: string) => {
        const r = PlurnkParser.parseStatements(s);
        const item = r.items.find((i) => i.kind === "statement");
        assert.ok(item && item.kind === "statement", `no statement parsed from ${s}`);
        return item.statement;
    };
    const w = one("<<WORK(run://capital-checker):Find the capital of France:WORK");
    assert.equal(w.op, "WORK");
    assert.equal(w.signal, null);
    assert.equal(w.lineMarker, null);
    assert.equal(w.body, "Find the capital of France");
    assert.ok(w.target !== null && JSON.stringify(w.target).includes("capital-checker"));
    const f = one("<<FORK(run://recheck):Re-derive the capital:FORK");
    assert.equal(f.op, "FORK");
    assert.equal(f.signal, null);
    assert.equal(f.lineMarker, null);
    assert.equal(f.body, "Re-derive the capital");
});

test("GBNF: PLAN is the turn anchor only — first op, not a statement-layer op", () => {
    // PLAN is first-only: NOT in the statement trie, so it never appears mid-batch.
    assert.equal(derives("statement", "<<PLAN:think first, then act:PLAN"), false);
    // as the anchor it is slotless (no tag signal) and non-empty.
    assert.equal(derives("root-turn", "<<PLAN:intent:PLAN\n<<SEND[200]:done:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN[tagged]:thoughts:PLAN\n<<SEND[200]:done:SEND"), false); // slotless
    // a second PLAN after the anchor is not derivable.
    assert.equal(derives("root-turn", "<<PLAN:first:PLAN\n<<PLAN:second:PLAN\n<<SEND[102]:done:SEND"), false);
});

test("GBNF: PLAN has no numeric suffix — the malformed <<PLAN1 is not derivable", () => {
    assert.equal(derives("statement", "<<PLAN1:nested thought:PLAN1"), false);
});

test("GBNF: PLAN body is required non-empty — no blank statement of intent", () => {
    assert.equal(derives("root-turn", "<<PLAN::PLAN\n<<SEND[200]:done:SEND"), false);   // blank plan rejected
    assert.equal(derives("root-turn", "<<PLAN:go:PLAN\n<<SEND[200]:done:SEND"), true);
});

test("GBNF: the READ→200 rail is DELETED (#54) — premature-conclude is the ENGINE's pending-set rule", () => {
    // Ruled 2026-07-05 ("designing so that it even works on gemma, not tuned for gemma"): the
    // sampler polices SHAPE only; a same-turn READ+SEND[200] is now grammar-legal and gets the
    // engine's 409 + steer. Probe on the trap turn measured 4/6 would-be-409 (accepted turn-tax).
    assert.equal(derives("root-turn", "<<PLAN:answer from memory:PLAN\n<<SEND[200]:Paris:SEND"), true);            // op-free answer
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<READ(known:///x)::READ\n<<SEND[200]:done:SEND"), true);    // rail gone: legal (engine 409s it)
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<FIND(known:///**)::FIND\n<<SEND[200]:done:SEND"), true);   // ditto
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<READ(known:///x)::READ\n<<SEND[102]:reading:SEND"), true); // the taught pattern: 102 to receive
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<EDIT(known:///x):42:EDIT\n<<SEND[200]:done:SEND"), true);  // fire-and-forget → 200
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND(run://peer):ping:SEND\n<<SEND[200]:done:SEND"), true);
});

test("GBNF: terminal SEND body is required non-empty — a turn must not end empty-handed", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:Paris:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]::SEND"), false);          // empty terminal
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499]::SEND"), false);          // any terminal code
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200](run://parent)::SEND"), false); // targeted, still empty
    // MID sends stay lax — terse/empty comms allowed before the terminal.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND::SEND\n<<SEND[102]:done:SEND"), true);
});

test("GBNF: digit-suffixed statement quoting an inner op derives", () => {
    const quoted = "<<EDIT1(known://demo):\nquoted: <<EDIT(known://inner):hello:EDIT\n:EDIT1";
    assert.equal(derives("statement", quoted), true);
});

test("GBNF: word suffix is parse-side only — not derivable", () => {
    assert.equal(derives("statement", "<<EDITouter(known://demo):x:EDITouter"), false);
});

test("GBNF: dash line-marker separator is parse-side only — not derivable", () => {
    assert.equal(derives("statement", "<<READ(a.md)<1-5>::READ"), false);
});

test("GBNF: statusless SEND is a valid mid-batch message (pathless or targeted)", () => {
    assert.equal(derives("statement", "<<SEND:just a message:SEND"), true);
    assert.equal(derives("statement", "<<SEND(agent://supervisor):heads up:SEND"), true);
    // ...but a statusless SEND is NOT a terminator — the turn still needs a status SEND.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND:done:SEND"), false);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND:note:SEND\n<<SEND[102]:done:SEND"), true);
});

test("GBNF: SEND signal must be three digits", () => {
    assert.equal(derives("statement", "<<SEND[20]:x:SEND"), false);
    assert.equal(derives("statement", "<<SEND[200]:x:SEND"), true);
});

test("GBNF: READ without a target is not derivable", () => {
    assert.equal(derives("statement", "<<READ:x:READ"), false);
});

test("GBNF: path-name regex target may contain `)` (groups derive via the #…# fence)", () => {
    // The `#…#` fences bound the regex, so a grouped alternation derives under GBNF now.
    assert.equal(derives("statement", "<<FIND(#(draft|final)/.*#i)::FIND"), true);
    assert.equal(derives("statement", "<<FIND(#a(b)c#)::FIND"), true);
    // plain (non-`#`) targets are unaffected — still the opaque inner blob
    assert.equal(derives("statement", "<<FIND(known:///**)::FIND"), true);
    // a literal `)` outside a `#…#` regex is still NOT derivable (delimiter; percent-encode)
    assert.equal(derives("statement", "<<FIND(a)b)::FIND"), false);
    // `<` in a path stays excluded (encode `%3C`) — strict-generate over ANTLR's tolerance
    assert.equal(derives("statement", "<<FIND(a<b)::FIND"), false);
});

test("GBNF: unsuffixed body cannot contain its own close literal", () => {
    const collision = "<<EDIT(known://demo):quoted: <<EDIT(known://inner):hello:EDIT\n:EDIT";
    assert.equal(derives("statement", collision), false);
});

test("GBNF: decimal line markers derive — insert-between, threshold, mixed", () => {
    assert.equal(derives("statement", "<<EDIT(known://plan)<2.5>:x:EDIT"), true);
    assert.equal(derives("statement", "<<FIND(known://**)<0.7>:~q:FIND"), true);
    assert.equal(derives("statement", "<<FIND(known://**)<0.7,20>:~q:FIND"), true);
    assert.equal(derives("statement", "<<FIND(known://**)<0.7,10,20>:~q:FIND"), true); // thresholded triple
    assert.equal(derives("statement", "<<READ(a.md)<2.>::READ"), false); // bare trailing dot is not a decimal
});

// -------------------------------------------------------------------------
// Separator + glued-output round-trip
// -------------------------------------------------------------------------

test("GBNF: inter-op separator is WS{0,7} — none, mixed, up to 7; 8+ rejected", () => {
    const lead = "<<PLAN:p:PLAN";
    // glued — zero separator between ops
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ<<SEND[102]:done:SEND"), true);
    // mixed whitespace separator (CRLF blank line + indent, within 7)
    assert.equal(derives("root-turn", lead + "\n<<READ(known:///x)::READ \t\n  <<SEND[102]:done:SEND"), true);
    // exactly 7 whitespace chars between ops — ok
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ" + " ".repeat(7) + "<<SEND[102]:done:SEND"), true);
    // 8 whitespace chars — over the cap, rejected (no unbounded stall)
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ" + " ".repeat(8) + "<<SEND[102]:done:SEND"), false);
    // leading + trailing whitespace (within cap) — op-free turn, 200 ok
    assert.equal(derives("root-turn", "  \n<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n  "), true);
    // still no non-whitespace text between ops
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ prose <<SEND[102]:done:SEND"), false);
});

test("GBNF: glued output round-trips through the parser (subset invariant)", () => {
    const turn = "<<READ(known:///x)::READ<<EDIT(known:///y):z:EDIT<<SEND[200]:done:SEND";
    const result = PlurnkParser.parseStatements(turn);
    const errors = result.items.filter((item) => item.kind === "error");
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.equal(errors.length, 0, `glued turn produced parse errors: ${JSON.stringify(turn)}`);
    assert.equal(statements.length, 3, "expected 3 glued statements");
    assert.equal(result.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// Fuzz: L(GBNF) ⊂ L(ANTLR)
// -------------------------------------------------------------------------

test("GBNF: 100 seeded random turn batches parse cleanly and end in SEND", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
        const turn = sample("root-turn", rng);
        // parse enforces the turn `document` rule — the real subset check: a GBNF-sampled
        // turn (op-free preamble + PLAN + ops + SEND) must parse as a valid ANTLR turn.
        const result = PlurnkParser.parse(turn);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 0, `batch ${i} produced parse errors\nbatch: ${JSON.stringify(turn)}`);
        assert.ok(statements.length >= 1, `batch ${i} produced no statements`);
        assert.ok(statements[0].kind === "statement" && statements[0].statement.op === "PLAN", `batch ${i} did not open with PLAN`);
        assert.equal(result.unparsedTail, undefined, `batch ${i} left an unparsed tail`);
        const last = statements.at(-1)!;
        assert.ok(last.kind === "statement", `batch ${i} last item is not a statement`);
        if (last.kind !== "statement") continue;
        assert.equal(last.statement.op, "SEND", `batch ${i} does not end in SEND\nbatch: ${JSON.stringify(turn)}`);
        // terminal is path-agnostic — target may be present or null; the disposition code closes the turn
        assert.ok(
            [102, 200, 202, 300, 499].includes(last.statement.signal as number),
            `batch ${i} final SEND signal is ${last.statement.signal}, not 102/200/202/300/499\nbatch: ${JSON.stringify(turn)}`,
        );
    }
});

test("GBNF: 300 seeded random derivations all parse cleanly", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 300; i++) {
        const sentence = sample("statement", rng);
        const result = PlurnkParser.parseStatements(sentence);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(
            errors.length, 0,
            `sample ${i} produced parse errors: ${errors.map((e) => e.kind === "error" ? e.error.message : "").join(" | ")}\nsample: ${JSON.stringify(sentence)}`,
        );
        assert.equal(statements.length, 1, `sample ${i} produced ${statements.length} statements\nsample: ${JSON.stringify(sentence)}`);
        assert.equal(result.unparsedTail, undefined, `sample ${i} left an unparsed tail\nsample: ${JSON.stringify(sentence)}`);
    }
});

// -------------------------------------------------------------------------
// Serialization sanity
// -------------------------------------------------------------------------

test("GBNF: serialized grammar has a root rule and every ref is defined", () => {
    const text = serializeGbnf(model, "root-turn");
    assert.match(text, /^root ::= root-turn$/m);
    const collectRefs = (item: GItem): string[] => {
        if (item.kind === "ref") return [item.name];
        if (item.kind === "rep") return collectRefs(item.item);
        return [];
    };
    for (const [name, alts] of model) {
        for (const refName of alts.flat().flatMap(collectRefs)) {
            assert.ok(model.has(refName), `rule ${name} references undefined rule ${refName}`);
        }
    }
});
