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
    const block = rest.substring(0, nextHeading ? nextHeading.index : rest.length).trim();

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
    assert.equal(derives("root-turn", "<<PLAN:decompose first:PLAN\n<<READ(known:///x)::READ\n<<SEND[200]:done:SEND"), true);
    // minimal: PLAN then the closing SEND.
    assert.equal(derives("root-turn", "<<PLAN:think:PLAN\n<<SEND[102]:working:SEND"), true);
    // op-first (no PLAN) is NOT a turn.
    assert.equal(derives("root-turn", "<<READ(known:///x)::READ\n<<SEND[200]:done:SEND"), false);
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

test("PlurnkParser.parse rejects non-turns — no PLAN and SEND[N] ⇒ invalid", () => {
    const invalid = (s: string): boolean => {
        const r = PlurnkParser.parse(s);
        return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
    };
    // prose with no PLAN and no SEND — The Gettysburg Address is not a plurnk turn
    assert.equal(invalid("Four score and seven years ago our fathers brought forth a new nation."), true);
    assert.equal(invalid("<<PLAN:I will answer:PLAN"), true);                        // PLAN, no terminal SEND
    assert.equal(invalid("<<READ(known:///x)::READ\n<<SEND[200]:done:SEND"), true);  // ops + SEND, but no PLAN
    // ...a full sandwich is valid
    const ok = PlurnkParser.parse("<<PLAN:intent:PLAN\n<<SEND[200]:done:SEND");
    assert.equal(ok.items.some((i) => i.kind === "error"), false);
    assert.equal(ok.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// SEND disposition codes (terminal vs mid)
// -------------------------------------------------------------------------

test("GBNF: SEND[202] (parked) is a pathless terminator, not a mid status", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]:parked until the fork reports:SEND"), true);
    // a pathless 202 closes the turn — it can't sit mid-batch ahead of another SEND
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[202]:parked:SEND\n<<SEND[200]:done:SEND"), false);
});

test("GBNF: SEND[499] (give-up) is a terminal disposition; 500 (engine verdict) is not emittable as a terminal", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499]:giving up:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499](run://parent):aborting:SEND"), true); // terminate-and-report give-up
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[499]:abort:SEND\n<<SEND[200]:done:SEND"), false); // 499 is terminal-only
    // 500 is an engine verdict, never a model terminal — only usable as a mid message code
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[500]:report:SEND"), false); // 500 not a terminal
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[500]:report:SEND\n<<SEND[200]:done:SEND"), true); // 500 ok as a mid code
});

test("GBNF: SEND[300] (user-question) is an allowed terminal, reserved from mid (untaught in canon)", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300]:Which sources do you trust?:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300](agent://user):clarify?:SEND"), true); // terminate-and-ask
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[300]:q:SEND\n<<SEND[200]:done:SEND"), false); // 300 is terminal-only
});

test("GBNF: root accepts mid-batch SENDs (targeted/pathless, non-loop status) before the final", () => {
    // mid SENDs must NOT carry a loop code (102/202/200) — those are terminal-always.
    const batch = "<<PLAN:plan:PLAN\n<<SEND[400](agent://supervisor):decomposition incomplete:SEND\n<<SEND[400]:{\"reason\":\"bad op\"}:SEND\n<<SEND[200]:done:SEND";
    assert.equal(derives("root-turn", batch), true);
    // a loop code on a mid (non-final) SEND is rejected — it would end the turn early
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[102](agent://supervisor):progress:SEND\n<<SEND[200]:done:SEND"), false);
});

test("GBNF: root rejects a batch with no final status SEND", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<EDIT(known://a.md):x:EDIT"), false);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<EDIT(known://a.md):x:EDIT\n<<SEND[400]:err:SEND"), false);
});

test("GBNF: root accepts a targeted terminal SEND (terminate-and-report)", () => {
    // The terminal is path-agnostic: a loop code closes the turn with or without a target.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200](run://parent):result:SEND"), true);
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200]:done:SEND"), true);
    // ...but a targeted terminal still terminates — nothing may follow it.
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[200](run://parent):result:SEND\n<<SEND[200]:again:SEND"), false);
});

test("GBNF: root rejects any statement after the final status SEND", () => {
    const after = "<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n<<EDIT(known://a.md):x:EDIT\n<<SEND[200]:again:SEND";
    assert.equal(derives("root-turn", after), false);
});

test("GBNF: root rejects two consecutive status SENDs", () => {
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND[102]:a:SEND\n<<SEND[200]:b:SEND"), false);
});

// -------------------------------------------------------------------------
// Statement layer: per-op shapes and canon boundaries
// -------------------------------------------------------------------------

test("GBNF: PLAN derives bare (slotless) at the statement layer", () => {
    assert.equal(derives("statement", "<<PLAN:think first, then act:PLAN"), true);
    assert.equal(derives("statement", "<<PLAN[tagged]:thoughts:PLAN"), false); // dictated form is slotless
});

test("GBNF: PLAN has no numeric suffix — the malformed <<PLAN1 is not derivable", () => {
    assert.equal(derives("statement", "<<PLAN1:nested thought:PLAN1"), false);
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
    assert.equal(derives("root-turn", "<<PLAN:p:PLAN\n<<SEND:note:SEND\n<<SEND[200]:done:SEND"), true);
});

test("GBNF: SEND signal must be three digits", () => {
    assert.equal(derives("statement", "<<SEND[20]:x:SEND"), false);
    assert.equal(derives("statement", "<<SEND[200]:x:SEND"), true);
});

test("GBNF: READ without a target is not derivable", () => {
    assert.equal(derives("statement", "<<READ:x:READ"), false);
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
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ<<SEND[200]:done:SEND"), true);
    // mixed whitespace separator (CRLF blank line + indent, within 7)
    assert.equal(derives("root-turn", lead + "\n<<READ(known:///x)::READ \t\n  <<SEND[200]:done:SEND"), true);
    // exactly 7 whitespace chars between ops — ok
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ" + " ".repeat(7) + "<<SEND[200]:done:SEND"), true);
    // 8 whitespace chars — over the cap, rejected (no unbounded stall)
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ" + " ".repeat(8) + "<<SEND[200]:done:SEND"), false);
    // leading + trailing whitespace (within cap)
    assert.equal(derives("root-turn", "  \n<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n  "), true);
    // still no non-whitespace text between ops
    assert.equal(derives("root-turn", lead + "<<READ(known:///x)::READ prose <<SEND[200]:done:SEND"), false);
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
        // terminal is path-agnostic — target may be present or null; the loop code closes the turn
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
