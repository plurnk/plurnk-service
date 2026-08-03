/**
 * GBNF compatibility tests. Two directions:
 *
 * Corpus - every plurnk.md example currently supported by the rail must be derivable.
 * README examples are not corpus:
 * they document the permissive parse layer (word suffixes, dash ranges).
 *
 * Fuzz - seeded derivations pin the rail's structural frame and bounded semantic
 * failure boundary. See {§gbnf-rail-purpose}. The recognizer and sampler
 * operate on the exported rule model, not serialized GBNF.
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

const CHANNEL_OPEN = "<|channel>thought\n";
const CHANNEL_CLOSE = "<channel|>";
const channel = (body = ""): string => `${CHANNEL_OPEN}${body}${CHANNEL_CLOSE}`;
const derivesTurn = (input: string, body = "", separator = ""): boolean =>
    derives("root-turn", `${channel(body)}${separator}${input}`);

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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Consumers load the committed artifact, so its bytes must equal current generator output.
test("GBNF: committed artifact is byte-identical to the generated grammar", () => {
    const committed = readFileSync(join(repoRoot, "dist", "plurnk.gbnf"), "utf8");
    const generated = serializeGbnf(model, "root-turn");
    assert.equal(committed, generated, "dist/plurnk.gbnf is STALE — run `npm run build:gbnf` and commit the regenerated artifact");
});

// -------------------------------------------------------------------------
// Turn shape: exactly one Harmony channel, then PLAN, bounded internal steps, terminal SEND.
// -------------------------------------------------------------------------

test("GBNF: PLAN-anchored root — PLAN mandatory & first, SEND-closed", () => {
    // PLAN first, then ops, closed by a terminal SEND.
    assert.equal(derivesTurn("<<PLAN:decompose first:PLAN\n<<READ(worker:///x)::READ\n<<SEND[102]:done:SEND"), true);
    // minimal: PLAN then a closing SEND (a non-102 disposition; see the no-idle test).
    assert.equal(derivesTurn("<<PLAN:think:PLAN\n<<SEND[200]:answer:SEND"), true);
    // op-first (no PLAN) is NOT a turn.
    assert.equal(derivesTurn("<<READ(worker:///x)::READ\n<<SEND[102]:done:SEND"), false);
    // bare SEND (no PLAN) is NOT a turn.
    assert.equal(derivesTurn("<<SEND[200]:done:SEND"), false);
    // PLAN alone (no terminal SEND) is NOT a turn.
    assert.equal(derivesTurn("<<PLAN:think:PLAN"), false);
    // no free prose between ops after PLAN.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\nstray prose\n<<SEND[200]:x:SEND"), false);
});

// tail-0 omits [102]; after one statement the complete disposition set returns.
// ANTLR remains tolerant. {§no-idle-102}
test("GBNF: zero-op [102] is excluded and one statement restores it", () => {
    // The idle turn: PLAN straight into a [102] terminal. Not derivable.
    assert.equal(derivesTurn("<<PLAN:think:PLAN\n<<SEND[102]:working:SEND"), false);
    // Targeted changes nothing — still idle.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[102](worker://self):working:SEND"), false);
    // One real op before it: derives.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n<<SEND[102]:working:SEND"), true);
    // A mid-comms SEND is a statement too (report-progress-and-continue): derives.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND:progress report:SEND\n<<SEND[102]:working:SEND"), true);
    // The other four dispositions stay legal with zero ops.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]:waiting:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]<30>:waiting:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[300]:pick one:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[499]:giving up:SEND"), true);
    // ANTLR (the forgiving ingester) still ACCEPTS the idle turn — rail-only rule.
    const result = PlurnkParser.parse("<<PLAN:think:PLAN\n<<SEND[102]:working:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
});

test("GBNF: exactly one leading Harmony channel precedes PLAN through sep", () => {
    const content = "<<PLAN:intent:PLAN\n<<SEND[200]:x:SEND";

    assert.equal(derivesTurn(content, "Analyze the task."), true);
    assert.equal(derivesTurn(content), true); // an empty channel remains legal
    assert.equal(derivesTurn(content, "reason", "\n \t"), true);
    assert.equal(derivesTurn(content, "reason", " ".repeat(7)), true);

    assert.equal(derives("root-turn", content), false); // the channel is required
    assert.equal(derives("root-turn", `${channel("first")}${channel("second")}${content}`), false);
    assert.equal(derivesTurn(content, "reason", " ".repeat(8)), false);
    assert.equal(derivesTurn(content, "reason", " prose "), false);
    assert.equal(derives("root-turn", `<think>reasoning</think>${content}`), false);
    assert.equal(derives("root-turn", `<|channel>thought reason${CHANNEL_CLOSE}${content}`), false);
    assert.equal(derives("root-turn", channel("reason")), false); // PLAN remains mandatory
});

test("GBNF: the leading channel rejects nested openers and no channel may follow PLAN", () => {
    const content = "<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n<<SEND[102]:waiting:SEND";

    // Reject the second opener immediately even if one closer could otherwise terminate it.
    assert.equal(derives("channel", `${CHANNEL_OPEN}outer ${CHANNEL_OPEN}inner${CHANNEL_CLOSE}`), false);
    assert.equal(derivesTurn(`<<PLAN:p:PLAN\n${channel("between")}<<SEND[200]:x:SEND`), false);
    assert.equal(derivesTurn(`<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n${channel("after act")}<<SEND[102]:w:SEND`), false);
    assert.equal(derivesTurn(`<<PLAN:p:PLAN\n<<SEND[200]:x:SEND\n${channel("after terminal")}`), false);
    assert.equal(derivesTurn(content, "one uninterrupted reasoning span"), true);
});

test("PlurnkParser.parse preserves pre-PLAN TEXT and anchors statements on PLAN", () => {
    const preamble = "plain preamble, no op lookalikes";
    const turn = `${preamble}\n<<PLAN:do the thing:PLAN\n<<READ(worker:///x)::READ\n<<SEND[200]:done:SEND`;
    const r = PlurnkParser.parse(turn);
    const stmts = r.items.filter((i) => i.kind === "statement");
    const errs = r.items.filter((i) => i.kind === "error");
    const texts = r.items.filter((i) => i.kind === "text");
    assert.equal(errs.length, 0, JSON.stringify(r.items));
    assert.deepEqual(texts.map(({ text }) => text), ["plain", "preamble,", "no", "op", "lookalikes"]);
    assert.ok(stmts[0]?.kind === "statement" && stmts[0].statement.op === "PLAN", "first parsed op should be PLAN");
    const last = stmts.at(-1);
    assert.ok(last?.kind === "statement" && last.statement.op === "SEND", "turn closes with SEND");
    assert.equal(r.unparsedTail, undefined);
});

// SPEC {§gbnf-turn-shape}: an op drafted inside the leading channel is reasoning text,
// not the turn anchor. The random sampler does not otherwise guarantee this specimen.
test("channel enclosure protects a drafted <<PLAN; parse anchors on the real one (#430)", () => {
    // A <<PLAN drafted WHILE reasoning (inside the channel body, a complement over the closer)
    // is protected content, not the anchor. GBNF derives it; parse anchors on the REAL PLAN
    // after <channel|>. PLAN's body is plain intended-goals text, not a {raw} object.
    const turn = `${channel("my plan: <<PLAN:draft:PLAN then verify")}<<PLAN:real intent:PLAN\n<<SEND[200]:done:SEND`;
    assert.equal(derives("root-turn", turn), true, "GBNF should derive the channel-enclosure turn");
    const r = PlurnkParser.parse(turn);
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0, JSON.stringify(r.items));
    const stmts = r.items.filter((i) => i.kind === "statement");
    const first = stmts[0]?.kind === "statement" ? stmts[0].statement : undefined;
    assert.ok(
        first?.op === "PLAN" && first.body === "real intent",
        `must anchor on the real PLAN, not the drafted one (got ${JSON.stringify(first?.body)})`,
    );
});

test("PlurnkParser.parse requires PLAN and terminal SEND while preserving admitted TEXT", () => {
    const invalid = (s: string): boolean => {
        const r = PlurnkParser.parse(s);
        return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
    };
    const valid = (s: string): boolean => !invalid(s);
    // Two hard requirements: a PLAN anchor and a terminal SEND.
    assert.equal(invalid("Four score and seven years ago our fathers brought forth a new nation."), true);
    assert.equal(invalid("<<PLAN:I will answer:PLAN"), true);                  // PLAN, no terminal SEND
    assert.equal(invalid("<<READ(worker:///x)::READ"), true);                  // op, no PLAN, no SEND
    // Operations plus SEND without a PLAN anchor remain invalid.
    assert.equal(invalid("<<READ(worker:///x)::READ\n<<SEND[200]:done:SEND"), true);
    // TEXT is admitted before PLAN, between operations, and after the terminal SEND.
    assert.equal(valid("thinking out loud <<PLAN:intent:PLAN now I read <<READ(worker:///x)::READ <<SEND[200]:done:SEND and done"), true);
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
    assert.equal(invalid("<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n<<SEND[200]:done:SEND\n<<EDIT(known://a):v:EDIT\n<<SEND[102]:cont:SEND"), true);
    assert.equal(invalid("<<PLAN:p:PLAN\n<<SEND[102]:cont:SEND\n<<SEND[200]:done:SEND"), true);     // two disposition SENDs
    assert.equal(invalid("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n<<KILL(proc://x)::KILL"), true);    // op after the terminal
    assert.equal(invalid("<<PLAN:p:PLAN\n<<EDIT(known://a):v:EDIT\n<<SEND[400]:report:SEND"), true); // 400 is comms, not a terminal — turn never terminated
    // Legal: a mid-comms SEND (non-disposition INT, statusless, or empty) may precede the
    // terminal; prose may follow the terminal.
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[400]:report:SEND\n<<EDIT(known://a):v:EDIT\n<<SEND[200]:done:SEND"), true);
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND(worker://peer):hint:SEND\n<<SEND[102]:cont:SEND"), true);
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\nall set, boss"), true);
    // A mid SEND[202] is a mid-termination parse error; a turn ending on it terminates cleanly.
    assert.equal(invalid("<<PLAN:p:PLAN\n<<SEND[202]:fyi:SEND\n<<SEND[102]:cont:SEND"), true);
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[202]:awaiting worker:SEND"), true);
    // ANTLR accepts the terminal SEND scope shape; the dispatcher rejects this
    // semantic combination and the GBNF never samples it.
    assert.equal(valid("<<PLAN:p:PLAN\n<<SEND[102]<60>:holding:SEND"), true);
});

// -------------------------------------------------------------------------
// SEND disposition codes (terminal vs mid)
// -------------------------------------------------------------------------

// {§waitpid-dispositions}
test("GBNF: 202 is the terminal wait disposition and is unavailable mid-turn", () => {
    // A turn ends on SEND[202]: the wait disposition (engine verifies against live obligations).
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]:awaiting the fork's report:SEND"), true);
    // A mid SEND[202] is unsampleable because it is the terminal.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]:fyi:SEND\n<<SEND[102]:cont:SEND"), false);
    // The park moved with the wait: [102] is a pure continue, no park at the rail.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[102]<60>:holding for the stream:SEND"), false);
});

// {§park-202-only}
test("GBNF: the terminal [202] park <T>/<T,P>/<-1> — bounded, polled, indefinite, targeted; no park elsewhere", () => {
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]<30>:polling:SEND"), true);          // bounded wait
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]<-1>:standing by:SEND"), true);      // indefinite (join-bounded)
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202]<60,5>:watching stream:SEND"), true); // timeout + poll cadence (mirrors EXEC)
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[202](worker://w)<60>:awaiting:SEND"), true); // targeted + park
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[102]<30>:cont:SEND"), false);            // 102 is a pure continue — the wait is 202's meaning
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]<30>:done:SEND"), false);            // 200 ends the loop — no wait to carry
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[300]<30>:choose:SEND"), false);          // 300 waits on the operator exclusively — indefinite by definition
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[499]<30>:abort:SEND"), false);
});

test("GBNF: SEND[499] is a terminal disposition; 500 is not a valid terminal (engine verdict)", () => {
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[499]:giving up:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[499](worker://parent):aborting:SEND"), true); // terminate-and-report give-up
    // 500 is an engine verdict — not in the terminal set, so not a valid turn closer.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[500]:report:SEND"), false);
    // 499 is terminal-reserved: it IS the terminal, so it can't be a mid comms before another SEND.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[499]:partial:SEND\n<<SEND[200]:done:SEND"), false);
    // 500 is NOT a disposition code, so it stays legal as a mid comms (error report), then a real terminal closes.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[500]:report:SEND\n<<SEND[102]:done:SEND"), true);
});

test("GBNF: SEND[300] (multiple-choice question) is a valid terminal disposition (untaught in canon)", () => {
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[300]:Which sources do you trust?:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[300](agent://user):clarify?:SEND"), true); // terminate-and-ask
    // 300 is terminal-reserved: a SEND[300] IS the terminal, so it can't precede another SEND.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[300]:q:SEND\n<<SEND[200]:done:SEND"), false);
});

test("GBNF: a header-bearing http target derives (constrained models can emit auth, #46)", () => {
    // Request-metadata `{key: value}` blocks ride inside the target as free text;
    // `target-inner` already admits the required punctuation and spaces.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<READ(https://api.dev/me{Authorization: Bearer x})::READ\n<<SEND[102]:fetching:SEND"), true);
    // SEND carries the loop disposition (200 here), not the HTTP status; the http scheme maps SEND->POST and rides the headers in the target.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200](https://api.dev/items{Authorization: Bearer x}{Content-Type: application/json}):{\"n\":1}:SEND"), true);
});

test("GBNF: ws:// and wss:// targets derive — the rail'd model can reach the WebSocket handler (#470)", () => {
    // {§path-syntax} The rail does not whitelist schemes.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<READ(ws://api.example.com/feed)::READ\n<<SEND(wss://api.example.com/feed):hello:SEND\n<<KILL(ws://api.example.com/feed)::KILL\n<<SEND[102]:streaming:SEND"), true);
});

test("GBNF: 14 mid-steps derive, 15 do not, and exhaustion requires a terminal", () => {
    const turn = (steps: string[], terminal: string) => `<<PLAN:p:PLAN\n${steps.join("\n")}\n${terminal}`;
    const edit = "<<EDIT(worker:///x):v:EDIT";       // side-effect step
    const read = "<<READ(worker:///x)::READ";        // retrieval step
    const midSend = "<<SEND[400]:working:SEND";     // a mid comms SEND (non-disposition code) is a counted step

    // 14 steps + 200 derives; a 15th step does not.
    assert.equal(derivesTurn(turn(Array(14).fill(edit), "<<SEND[200]:done:SEND")), true);
    assert.equal(derivesTurn(turn(Array(15).fill(edit), "<<SEND[200]:done:SEND")), false);
    // Every internal statement consumes one position in the same tail chain.
    assert.equal(derivesTurn(turn(Array(14).fill(read), "<<SEND[102]:fetching:SEND")), true);
    assert.equal(derivesTurn(turn(Array(14).fill(read), "<<SEND[200]:done:SEND")), true);  // core judges pending results
    assert.equal(derivesTurn(turn(Array(15).fill(read), "<<SEND[102]:fetching:SEND")), false);
    // The reproduced flail shape (READ,READ,FIND,SEND ×2 then SEND-spam past K) is non-derivable.
    const flail = [read, read, "<<FIND(src/**)::FIND", midSend, read, read, "<<FIND(src/**)::FIND", midSend, ...Array(10).fill(midSend)];
    assert.equal(derivesTurn(turn(flail, "<<SEND[102]:done:SEND")), false);
    // Mid-SENDs count as steps: 13 sends + 1 op + terminal is exactly 14 → derives.
    assert.equal(derivesTurn(turn([...Array(13).fill(midSend), edit], "<<SEND[200]:done:SEND")), true);
});

// {§pattern-body-single-line}
test("GBNF: matcher bodies are single-line while content bodies remain multiline", () => {
    // With newline unavailable, a wrong matcher closer cannot absorb later lines;
    // the matching close remains the body's only exit.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<FIND(SPEC.md):/grinder/:READ\n<<SEND[102]:x:SEND"), false); // the exact trap
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<FIND(SPEC.md):/grinder/:FIND\n<<SEND[102]:x:SEND"), true);  // closed correctly
    for (const op of ["FIND", "READ", "OPEN", "FOLD"]) {
        assert.equal(derivesTurn(`<<PLAN:p:PLAN\n<<${op}(a):line1\nline2:${op}\n<<SEND[102]:c:SEND`), false, `${op} pattern body must not span lines`);
    }
    // Content bodies (EDIT/SEND/...) stay multiline — the narrowing is pattern-only.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<EDIT(a):line1\nline2:EDIT\n<<SEND[200]:done:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:multi\nline:SEND"), true);
});

test("GBNF: OPEN and FOLD admit tagged set selection but no positional scope", () => {
    for (const op of ["OPEN", "FOLD"]) {
        assert.equal(
            derivesTurn(`<<PLAN:p:PLAN\n<<${op}[memory](log:///**):needle:${op}\n<<SEND[102]:c:SEND`),
            true,
            `${op} retains tags, target, and matcher selection`,
        );
        assert.equal(
            derivesTurn(`<<PLAN:p:PLAN\n<<${op}[memory](log:///**)<1,2>:needle:${op}\n<<SEND[102]:c:SEND`),
            false,
            `${op} must not expose positional scope`,
        );
    }
});

// {§pattern-body-leading-colon}
test("GBNF: pattern bodies cannot begin with the close delimiter - triple-colon recovery", () => {
    for (const op of ["FIND", "READ", "OPEN", "FOLD"]) {
        const prefix = `<<PLAN:p:PLAN\n<<${op}(a)`;
        assert.equal(derivesTurn(`${prefix}::${op}\n<<SEND[102]:c:SEND`), true, `${op} keeps an empty matcher body`);
        assert.equal(derivesTurn(`${prefix}:::${op}\n<<SEND[102]:c:SEND`), false, `${op} rejects the triple-colon typo`);
        assert.equal(derivesTurn(`${prefix}::needle:${op}\n<<SEND[102]:c:SEND`), false, `${op} rejects a colon-prefixed matcher body`);
        assert.equal(derivesTurn(`${prefix}:a:b:${op}\n<<SEND[102]:c:SEND`), true, `${op} retains colons after the first matcher character`);
        assert.equal(derivesTurn(`${prefix}:/^:needle/:${op}\n<<SEND[102]:c:SEND`), true, `${op} can match a literal leading colon through regex`);
    }
    assert.equal(
        derivesTurn("<<PLAN:p:PLAN\n<<READ(https://example.com)<17,50>:::READ\n<<SEND[102]:c:SEND"),
        false,
        "the scoped live-demo failure is outside the rail",
    );

    const parsed = PlurnkParser.parseStatements("<<READ(a):::READ");
    assert.equal(parsed.items.filter((item) => item.kind === "error").length, 0, "ANTLR remains the permissive ingester");
    assert.equal(parsed.items[0]?.kind, "statement");
    if (parsed.items[0]?.kind === "statement") assert.deepEqual(parsed.items[0].statement.body, { dialect: "glob", raw: ":" });
});

test("GBNF: mid-batch comms SENDs derive (targeted/pathless, NON-disposition codes) before the final", () => {
    const batch = "<<PLAN:plan:PLAN\n<<SEND[400](agent://supervisor):decomposition incomplete:SEND\n<<SEND[400]:{\"reason\":\"bad op\"}:SEND\n<<SEND[102]:done:SEND";
    assert.equal(derivesTurn(batch), true);
    // A disposition code (here 102) is the terminal, so it cannot be mid-turn comms.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[102](agent://supervisor):progress:SEND\n<<SEND[102]:done:SEND"), false);
});

test("GBNF: root rejects a batch with no final status SEND", () => {
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<EDIT(known://a.md):x:EDIT"), false);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<EDIT(known://a.md):x:EDIT\n<<SEND[400]:err:SEND"), false);
});

test("GBNF: root accepts a targeted terminal SEND (terminate-and-report)", () => {
    // The terminal is path-agnostic: a disposition code closes the turn with or without a target.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200](worker://parent):result:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND"), true);
    // The first disposition SEND is terminal, so a second one cannot follow it.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200](worker://parent):result:SEND\n<<SEND[200]:again:SEND"), false);
    // ...but the turn must still END on a SEND — a trailing non-SEND op is rejected.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:result:SEND\n<<EDIT(known://a.md):x:EDIT"), false);
});

test("GBNF: a turn may contain multiple SENDs — but only the terminal carries a disposition code", () => {
    // A non-disposition comms SEND (400) may precede ops and the terminal disposition SEND.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[400]:interim:SEND\n<<EDIT(known://a.md):x:EDIT\n<<SEND[200]:done:SEND"), true);
    // A disposition-coded SEND is terminal, so no operation can follow it.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:interim:SEND\n<<EDIT(known://a.md):x:EDIT\n<<SEND[200]:done:SEND"), false);
    // and a non-SEND op after the terminal is still rejected — the turn ends on the terminal.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n<<EDIT(known://a.md):x:EDIT"), false);
});

// {§send-mid-reservation}
test("GBNF: terminal disposition codes are UNSAMPLEABLE mid — a coded SEND IS the terminal", () => {
    // The bug this closes: a mid SEND[200] after a READ demoted a premature terminate to a legal
    // comms SEND, which the dispatcher (first disposition-coded SEND wins) acted on — bypassing
    // the last-SEND model. Reserving the disposition codes for the terminal makes premature
    // termination unsampleable at the mask. Set is {102,200,202,300,499} (waitpid contract).
    for (const code of ["102", "200", "202", "300", "499"]) {
        assert.equal(derivesTurn(`<<PLAN:p:PLAN\n<<SEND[${code}]:x:SEND\n<<SEND[102]:c:SEND`), false, `mid SEND[${code}] must reject`);
    }
    // Non-disposition codes stay legal mid comms (boundary cases around the reserved five).
    for (const code of ["100", "201", "203", "301", "400", "498", "500", "999"]) {
        assert.equal(derivesTurn(`<<PLAN:p:PLAN\n<<SEND[${code}]:x:SEND\n<<SEND[102]:c:SEND`), true, `mid SEND[${code}] must derive`);
    }
    // A disposition SEND after READ remains terminal; another SEND cannot follow it.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<READ(a)::READ\n<<SEND[200]:done:SEND\n<<SEND[102]:cont:SEND"), false);
});

// -------------------------------------------------------------------------
// Statement layer: per-op shapes and canon boundaries
// -------------------------------------------------------------------------

test("GBNF: EXEC accepts an optional <timeout,poll> scope after canonical signal and target slots", () => {
    assert.equal(derives("op-statement", "<<EXEC[node](sh:///x):cmd:EXEC"), true);        // no slot
    assert.equal(derives("op-statement", "<<EXEC[node](sh:///x)<60>:cmd:EXEC"), true);     // timeout only
    assert.equal(derives("op-statement", "<<EXEC[node](sh:///x)<60,5>:cmd:EXEC"), true);   // timeout + poll
    assert.equal(derives("op-statement", "<<EXEC(sh:///x)<60,5>:cmd:EXEC"), true);         // slotless executor
});

test("GBNF: WORK/FORK require a worker target and non-empty prompt", () => {
    // WORK spawns a fresh named worker; FORK branches the current worker into a named child.
    assert.equal(derives("op-statement", "<<WORK(worker://worker-db):resolve the db field:WORK"), true);
    assert.equal(derives("op-statement", "<<FORK(worker://recheck):re-derive from a primary source:FORK"), true);
    // The rail REQUIRES the target — a nameless worker/branch can't be addressed.
    assert.equal(derives("op-statement", "<<WORK:do a thing:WORK"), false);
    assert.equal(derives("op-statement", "<<FORK:do a thing:FORK"), false);
    assert.equal(derives("op-statement", "<<WORK(worker://w)::WORK"), false);
    assert.equal(derives("op-statement", "<<FORK(worker://w)::FORK"), false);
    assert.equal(derives("op-statement", "<<WORK[feature/x](worker://w):t:WORK"), true);
    assert.equal(derives("op-statement", "<<FORK[fix/issue-642](worker://w):t:FORK"), true);
    assert.equal(derives("op-statement", "<<WORK[a,b](worker://w):t:WORK"), false);
    // They derive as mid-ops before the terminal SEND.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<WORK(worker://w):task:WORK\n<<SEND[102]:spawned:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<FORK(worker://r):retry:FORK\n<<SEND[102]:forked:SEND"), true);
});

test("parse: WORK/FORK build the right AST, including a slash-bearing branch signal", () => {
    const one = (s: string) => {
        const r = PlurnkParser.parseStatements(s);
        const item = r.items.find((i) => i.kind === "statement");
        assert.ok(item && item.kind === "statement", `no statement parsed from ${s}`);
        return item.statement;
    };
    const w = one("<<WORK(worker://capital-checker):Find the capital of France:WORK");
    assert.equal(w.op, "WORK");
    assert.equal(w.signal, null);
    assert.equal(w.lineMarker, null);
    assert.equal(w.body, "Find the capital of France");
    assert.ok(w.target !== null && JSON.stringify(w.target).includes("capital-checker"));
    const f = one("<<FORK[feature/recheck](worker://recheck):Re-derive the capital:FORK");
    assert.equal(f.op, "FORK");
    assert.equal(f.signal, "feature/recheck");
    assert.equal(f.lineMarker, null);
    assert.equal(f.body, "Re-derive the capital");
});

test("GBNF: PLAN is the turn anchor only — first op, not a statement-layer op", () => {
    // PLAN is first-only: NOT in the statement trie, so it never appears mid-batch.
    assert.equal(derives("statement", "<<PLAN:think first, then act:PLAN"), false);
    // as the anchor it is slotless (no tag signal) and non-empty.
    assert.equal(derivesTurn("<<PLAN:intent:PLAN\n<<SEND[200]:done:SEND"), true);
    assert.equal(derivesTurn("<<PLAN[tagged]:thoughts:PLAN\n<<SEND[200]:done:SEND"), false); // slotless
    // a second PLAN after the anchor is not derivable.
    assert.equal(derivesTurn("<<PLAN:first:PLAN\n<<PLAN:second:PLAN\n<<SEND[102]:done:SEND"), false);
});

test("GBNF: PLAN has no numeric suffix", () => {
    assert.equal(derives("statement", "<<PLAN1:nested goals:PLAN1"), false);
});

// {§plan-body-no-openers}: PLAN ends before an operation opener.
test("GBNF: PLAN body excludes `<<` and cannot capture following operations", () => {
    // An op opener inside the plan body: NOT derivable.
    assert.equal(derivesTurn("<<PLAN:plan text\n<<READ(worker:///x)::READ more plan:PLAN\n<<SEND[200]:x:SEND"), false);
    // An omitted :PLAN cannot consume operations through a later PLAN closer.
    assert.equal(derivesTurn("<<PLAN:Execute hostname.\n<<EXEC:hostname::EXEC\n<<SEND[102]:executing:SEND\n<<PLAN:Awaiting.:PLAN\n<<SEND[202]:waiting:SEND"), false);
    // The corrected form (plan closed, then the ops): derives.
    assert.equal(derivesTurn("<<PLAN:Execute hostname.:PLAN\n<<EXEC:hostname::EXEC\n<<SEND[102]:executing:SEND"), true);
    // A single `<` in a plan body stays legal (comparisons, arrows).
    assert.equal(derivesTurn("<<PLAN:check 3 < 5 and a -> b:PLAN\n<<SEND[200]:yes:SEND"), true);
    // Even a lone `<` at body end is legal; only the double is unsampleable.
    assert.equal(derivesTurn("<<PLAN:compare a <:PLAN\n<<SEND[200]:x:SEND"), true);
});

test("GBNF: PLAN body is required non-empty — no blank statement of intent", () => {
    assert.equal(derivesTurn("<<PLAN::PLAN\n<<SEND[200]:done:SEND"), false);   // blank plan rejected
    assert.equal(derivesTurn("<<PLAN:go:PLAN\n<<SEND[200]:done:SEND"), true);
});

test("GBNF: pending-result semantics remain outside the generation rail", () => {
    // The rail shapes the turn; core decides whether a terminal disposition is honest.
    assert.equal(derivesTurn("<<PLAN:answer from memory:PLAN\n<<SEND[200]:Paris:SEND"), true);            // op-free answer
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n<<SEND[200]:done:SEND"), true);    // core judges the pending retrieval
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<FIND(worker:///**)::FIND\n<<SEND[200]:done:SEND"), true);   // same boundary for FIND
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n<<SEND[102]:reading:SEND"), true); // the taught pattern: 102 to receive
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<EDIT(worker:///x):42:EDIT\n<<SEND[200]:done:SEND"), true);  // fire-and-forget → 200
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND(worker://peer):ping:SEND\n<<SEND[200]:done:SEND"), true);
});

// {§terminal-body-nonempty}
test("GBNF: terminal SEND body is required non-empty — a turn must not end empty-handed", () => {
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:Paris:SEND"), true);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]::SEND"), false);          // empty terminal
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[499]::SEND"), false);          // any terminal code
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200](worker://parent)::SEND"), false); // targeted, still empty
    // MID sends stay lax — terse/empty comms allowed before the terminal.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND::SEND\n<<SEND[102]:done:SEND"), true);
});

test("GBNF: digit-suffixed statement quoting an inner op derives", () => {
    const quoted = "<<EDIT1(known://demo):\nquoted: <<EDIT(known://inner):hello:EDIT\n:EDIT1";
    assert.equal(derives("statement", quoted), true);
});

test("GBNF: word suffix is parse-side only — not derivable", () => {
    assert.equal(derives("statement", "<<EDITouter(known://demo):x:EDITouter"), false);
});

test("GBNF: dash-separated <scope> is parse-side tolerance only — not derivable", () => {
    assert.equal(derives("statement", "<<READ(a.md)<1-5>::READ"), false);
});

test("GBNF: statusless SEND is a valid mid-batch message (pathless or targeted)", () => {
    assert.equal(derives("statement", "<<SEND:just a message:SEND"), true);
    assert.equal(derives("statement", "<<SEND(agent://supervisor):heads up:SEND"), true);
    // ...but a statusless SEND is NOT a terminator — the turn still needs a status SEND.
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND:done:SEND"), false);
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND:note:SEND\n<<SEND[102]:done:SEND"), true);
});

test("GBNF: SEND signal must be three digits", () => {
    assert.equal(derives("statement", "<<SEND[20]:x:SEND"), false);
    assert.equal(derives("statement", "<<SEND[200]:x:SEND"), true);
});

test("GBNF: READ without a target is not derivable", () => {
    assert.equal(derives("statement", "<<READ:x:READ"), false);
});

test("GBNF: targets use the canonical percent-encoded spelling for parentheses", () => {
    // ANTLR accepts balanced raw parentheses, but GBNF is a narrow generation
    // rail, not ANTLR Jr. Targets are exact paths or shell globs.
    assert.equal(derives("statement", "<<FIND(worker:///**)::FIND"), true);
    assert.equal(derives("statement", "<<READ(https://en.wikipedia.org/wiki/Igor_Smirnov_(politician))::READ"), false);
    assert.equal(derives("statement", "<<READ(https://en.wikipedia.org/wiki/Igor_Smirnov_%28politician%29)::READ"), true);
    // Unbalanced delimiters are still not derivable; percent-encode those.
    assert.equal(derives("statement", "<<FIND(a)b)::FIND"), false);
    assert.equal(derives("statement", "<<FIND(a(b)::FIND"), false);
    // `<` in a path stays excluded (encode `%3C`) — strict-generate over ANTLR's tolerance
    assert.equal(derives("statement", "<<FIND(a<b)::FIND"), false);
});

test("GBNF: unsuffixed body cannot contain its own close literal", () => {
    const collision = "<<EDIT(known://demo):quoted: <<EDIT(known://inner):hello:EDIT\n:EDIT";
    assert.equal(derives("statement", collision), false);
});

test("GBNF: permissive decimal marker shapes derive for runtime interpretation", () => {
    assert.equal(derives("statement", "<<EDIT(known://plan)<2.5>:x:EDIT"), true);
    assert.equal(derives("statement", "<<FIND(known://**)<0.7>:~q:FIND"), true);
    assert.equal(derives("statement", "<<FIND(known://**)<0.7,20>:~q:FIND"), true);
    assert.equal(derives("statement", "<<FIND(known://**)<0.7,10,20>:~q:FIND"), true); // thresholded triple
    assert.equal(derives("statement", "<<READ(known://**)<0.7,12,5,12,20>:~q:READ"), true);
    assert.equal(derives("statement", "<<READ(a.md)<2.>::READ"), false); // bare trailing dot is not a decimal
});

// -------------------------------------------------------------------------
// Separator + glued-output round-trip
// -------------------------------------------------------------------------

test("GBNF: inter-op separator is WS{0,7} — none, mixed, up to 7; 8+ rejected", () => {
    const lead = "<<PLAN:p:PLAN";
    // glued — zero separator between ops
    assert.equal(derivesTurn(lead + "<<READ(worker:///x)::READ<<SEND[102]:done:SEND"), true);
    // mixed whitespace separator (CRLF blank line + indent, within 7)
    assert.equal(derivesTurn(lead + "\n<<READ(worker:///x)::READ \t\n  <<SEND[102]:done:SEND"), true);
    // exactly 7 whitespace chars between ops — ok
    assert.equal(derivesTurn(lead + "<<READ(worker:///x)::READ" + " ".repeat(7) + "<<SEND[102]:done:SEND"), true);
    // 8 whitespace chars — over the cap, rejected (no unbounded stall)
    assert.equal(derivesTurn(lead + "<<READ(worker:///x)::READ" + " ".repeat(8) + "<<SEND[102]:done:SEND"), false);
    // The channel is byte-zero strict; the same whitespace is legal after its closer.
    assert.equal(derives("root-turn", `  \n${channel()}<<PLAN:p:PLAN\n<<SEND[200]:done:SEND`), false);
    assert.equal(derivesTurn("  \n<<PLAN:p:PLAN\n<<SEND[200]:done:SEND"), true);
    // trailing whitespace after the terminal (within cap) is fine
    assert.equal(derivesTurn("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n  "), true);
    // still no non-whitespace text between ops
    assert.equal(derivesTurn(lead + "<<READ(worker:///x)::READ prose <<SEND[102]:done:SEND"), false);
});

test("GBNF: glued output round-trips through the parser", () => {
    const turn = "<<READ(worker:///x)::READ<<EDIT(worker:///y):z:EDIT<<SEND[200]:done:SEND";
    const result = PlurnkParser.parseStatements(turn);
    const errors = result.items.filter((item) => item.kind === "error");
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.equal(errors.length, 0, `glued turn produced parse errors: ${JSON.stringify(turn)}`);
    assert.equal(statements.length, 3, "expected 3 glued statements");
    assert.equal(result.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// Compatibility fuzz for the current rail.
// -------------------------------------------------------------------------

test("GBNF: a malformed JSONPath claim remains one bounded visitor error", () => {
    const turn = [
        `${channel("inspect the available evidence")}<<PLAN:inspect the relevant entries:PLAN`,
        "<<READ(worker:///x):$fC:READ",
        "<<READ(worker:///y)::READ",
        "<<SEND[102]:continue with the retained result:SEND",
    ].join("\n");

    assert.equal(derives("root-turn", turn), true, "the lean rail intentionally admits the malformed dialect claim");
    const result = PlurnkParser.parse(turn);
    const statements = result.items.filter((item) => item.kind === "statement");
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(statements.map(({ statement }) => statement.op), ["PLAN", "READ", "SEND"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.error.source, "visitor");
    assert.match(errors[0]!.error.message, /not a valid jsonpath.*\$fC/i);
    assert.equal(result.unparsedTail, undefined);
});

test("GBNF: 100 seeded turn batches retain a PLAN-through-terminal-SEND frame", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
        const turn = sample("root-turn", rng);
        const result = PlurnkParser.parse(turn);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(
            errors.every(({ error }) => error.source === "visitor"),
            `batch ${i} escaped the structural rail: ${errors.map(({ error }) => error.message).join(" | ")}\nbatch: ${JSON.stringify(turn)}`,
        );
        assert.ok(statements.length >= 2, `batch ${i} lost a frame anchor`);
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

test("GBNF: 300 seeded statement derivations build one statement or one bounded Visitor error", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 300; i++) {
        const sentence = sample("statement", rng);
        const result = PlurnkParser.parseStatements(sentence);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(
            errors.every(({ error }) => error.source === "visitor"),
            `sample ${i} escaped the statement frame: ${errors.map(({ error }) => error.message).join(" | ")}\nsample: ${JSON.stringify(sentence)}`,
        );
        assert.equal(
            statements.length + errors.length,
            1,
            `sample ${i} produced ${statements.length} statements and ${errors.length} errors\nsample: ${JSON.stringify(sentence)}`,
        );
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
